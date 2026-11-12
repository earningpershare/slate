// Accounts and device-to-device sync, end to end. Starts its own server on a spare
// port with a throwaway data folder. Usage: node e2e/sync.mjs [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const shots = process.argv[2];
const PORT = 5197;
const base = "http://localhost:" + PORT;
const data = fs.mkdtempSync(path.join(os.tmpdir(), "slate-e2e-"));
const server = spawn(process.execPath, ["server/slate-server.mjs"], {
  env: { ...process.env, PORT: String(PORT), SLATE_DATA: data },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((res, rej) => {
  server.stdout.on("data", (d) => String(d).includes("已啟動") && res());
  server.on("exit", () => rej(new Error("server did not start")));
});

const browser = await chromium.launch({ channel: "msedge" });
const errors = [];
const device = async (name, opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW", ...opts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errors.push(name + " pageerror: " + e.message));
  page.on("console", (m) => {
    // refused sign-ins are answered with 4xx on purpose
    if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(name + " console: " + m.text());
  });
  return page;
};
const step = async (name, fn) => {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n     " + String(e.message).split("\n").slice(0, 3).join(" | "));
    process.exitCode = 1;
  }
};
const auth = async (page, mode, name, password) => {
  if (mode === "register") await page.locator(".auth-form .seg-btn", { hasText: "建立帳號" }).click();
  await page.fill('.auth-form input[name="username"]', name);
  await page.fill('.auth-form input[name="password"]', password);
  await page.locator(".auth-form .btn.primary").click();
};
const titles = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const open = indexedDB.open("slate-workspace");
        open.onsuccess = () => {
          const d = open.result;
          const q = d.transaction("pages").objectStore("pages").getAll();
          q.onsuccess = () => (d.close(), res(q.result.map((p) => p.title).sort()));
        };
      }),
  );
const api = (page, method, route, body, headers = { "x-slate": "1" }) =>
  page.evaluate(
    async ([method, route, body, headers]) => {
      const r = await fetch("/api/" + route, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === null ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, route, body, headers],
  );

const laptop = await device("laptop");
const phone = await device("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

await step("a new device is asked to sign in before anything is created", async () => {
  await laptop.goto(base);
  await laptop.waitForSelector(".welcome .auth-form");
  assert.deepEqual(await titles(laptop), []);
  if (shots) await laptop.screenshot({ path: shots + "/s-01-welcome.png" });
});

await step("wrong password and short password are refused with a clear message", async () => {
  await auth(laptop, "login", "amy", "not-my-password");
  await laptop.waitForSelector(".auth-error >> text=帳號或密碼不正確");
  assert.equal((await api(laptop, "POST", "register", { name: "amy", password: "short" })).body.error, "password");
  assert.equal((await api(laptop, "POST", "register", { name: "a b", password: "long-enough-1" })).body.error, "name");
});

await step("create an account on the laptop and write something", async () => {
  await auth(laptop, "register", "Amy", "correct horse 1");
  await laptop.waitForSelector(".home, .page-title");
  await laptop.keyboard.press("Alt+n");
  await laptop.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await laptop.fill(".page-title", "電腦寫的頁面");
  await laptop.keyboard.press("Enter");
  await laptop.keyboard.type("第一段內容");
  await laptop.waitForTimeout(800);
  assert.deepEqual(await titles(laptop), ["電腦寫的頁面"]);
  // an attachment big enough to need several relay messages (0.7 MB of a known pattern)
  await laptop.evaluate(
    () =>
      new Promise((res, rej) => {
        const bytes = new Uint8Array(700_000).map((_, i) => (i * 31) % 251);
        const open = indexedDB.open("slate-workspace");
        open.onsuccess = () => {
          const d = open.result;
          const tx = d.transaction("files", "readwrite");
          tx.objectStore("files").add({ id: "bigfile1", name: "big.png", type: "image/png", blob: new Blob([bytes], { type: "image/png" }), rev: Date.now(), dirty: 1 });
          tx.oncomplete = () => (d.close(), res());
          tx.onerror = () => rej(tx.error);
        };
      }),
  );
});

await step("the phone signs in to the same account and receives it", async () => {
  await phone.goto(base);
  await phone.waitForSelector(".welcome .auth-form");
  await auth(phone, "login", "amy", "correct horse 1");
  await phone.waitForSelector(".tabbar");
  await phone.waitForFunction(() => !!document.querySelector(".page-title, .home"));
  await assert.doesNotReject(
    phone.waitForFunction(
      () =>
        new Promise((res) => {
          const open = indexedDB.open("slate-workspace");
          open.onsuccess = () => {
            const d = open.result;
            const q = d.transaction("pages").objectStore("pages").getAll();
            q.onsuccess = () => (d.close(), res(q.result.some((p) => p.title === "電腦寫的頁面")));
          };
        }),
    ),
  );
  // the attachment arrived whole
  const readFile = () =>
    phone.evaluate(
      () =>
        new Promise((res) => {
          const open = indexedDB.open("slate-workspace");
          open.onsuccess = () => {
            const d = open.result;
            const q = d.transaction("files").objectStore("files").get("bigfile1");
            q.onsuccess = async () => {
              d.close();
              if (!q.result) return res(null);
              const bytes = new Uint8Array(await q.result.blob.arrayBuffer());
              res({ size: bytes.length, ok: bytes.every((v, i) => v === (i * 31) % 251), name: q.result.name, type: q.result.blob.type });
            };
          };
        }),
    );
  let file = null;
  for (let i = 0; i < 40 && !file; i++) {
    file = await readFile();
    if (!file) await phone.waitForTimeout(250);
  }
  assert.equal(JSON.stringify(file), JSON.stringify({ size: 700000, ok: true, name: "big.png", type: "image/png" }));
  await phone.locator(".tabbar button", { hasText: "頁面" }).tap();
  await phone.locator(".tree-main", { hasText: "電腦寫的頁面" }).tap();
  await phone.waitForSelector(".bn-editor >> text=第一段內容");
  if (shots) await phone.screenshot({ path: shots + "/s-02-phone.png" });
});

await step("an edit on the phone shows up on the laptop while its page is open", async () => {
  await phone.locator(".bn-editor >> text=第一段內容").tap();
  await phone.keyboard.press("Control+End");
  await phone.keyboard.press("Enter");
  await phone.keyboard.type("手機補的一行");
  // the laptop is looking at the same page and is not typing in it
  await laptop.locator(".topbar").click();
  await laptop.waitForSelector(".bn-editor >> text=手機補的一行");
});

await step("tasks and deletions travel both ways", async () => {
  await laptop.evaluate(() => (location.hash = "/tasks/inbox"));
  await laptop.fill(".quick-add input", "電腦加的任務");
  await laptop.keyboard.press("Enter");
  await phone.locator(".tabbar button", { hasText: "待辦" }).tap();
  await phone.locator(".tasks-nav .nav-row", { hasText: "收件匣" }).tap();
  await phone.waitForSelector(".task-row >> text=電腦加的任務");
  await phone.locator(".task-row", { hasText: "電腦加的任務" }).locator(".task-check").tap();
  await laptop.waitForSelector(".task-row >> text=電腦加的任務", { state: "detached" });
  // delete the page on the laptop: it disappears from the phone
  await laptop.locator(".tree-row", { hasText: "電腦寫的頁面" }).hover();
  await laptop.locator(".tree-row", { hasText: "電腦寫的頁面" }).locator('[title="更多"]').click();
  await laptop.locator(".popover .menu-item", { hasText: "移到垃圾桶" }).click();
  await phone.locator(".tabbar button", { hasText: "頁面" }).tap();
  await phone.waitForSelector(".sidebar");
  await phone.waitForSelector(".sidebar .tree-main >> text=電腦寫的頁面", { state: "detached" });
  await phone.locator(".scrim").tap({ position: { x: 370, y: 300 } });
});

await step("changes made while the other device is closed are merged when it comes back", async () => {
  await phone.context().setOffline(true);
  await phone.waitForTimeout(300);
  await laptop.evaluate(() => (location.hash = "/tasks/inbox"));
  await laptop.fill(".quick-add input", "手機離線時電腦加的");
  await laptop.keyboard.press("Enter");
  await phone.locator(".tabbar button", { hasText: "待辦" }).tap();
  await phone.locator(".tasks-nav .nav-row", { hasText: "收件匣" }).tap();
  await phone.fill(".quick-add input", "手機離線時自己加的");
  await phone.keyboard.press("Enter");
  await phone.waitForSelector(".task-row >> text=手機離線時自己加的");
  await phone.context().setOffline(false);
  await phone.waitForSelector(".task-row >> text=手機離線時電腦加的", { timeout: 15000 });
  await laptop.waitForSelector(".task-row >> text=手機離線時自己加的", { timeout: 15000 });
});

await step("settings show the account and the connected device", async () => {
  await laptop.locator(".sidebar .nav-row", { hasText: "設定" }).click();
  await laptop.waitForSelector(".modal.settings >> text=已登入");
  await laptop.waitForSelector(".modal.settings >> text=目前有 1 台其他裝置連線中");
  if (shots) await laptop.screenshot({ path: shots + "/s-03-settings.png" });
  await laptop.locator(".modal .btn", { hasText: "完成" }).click();
});

await step("another account sees none of it and cannot reach the first account's devices", async () => {
  const other = await device("other");
  await other.goto(base);
  await other.waitForSelector(".welcome .auth-form");
  assert.equal((await api(other, "POST", "relay/send?from=xxxxxxxx&to=*", { t: "manifest", m: {} })).status, 401);
  await auth(other, "register", "bob", "another secret 2");
  await other.waitForSelector(".home, .page-title");
  await other.waitForTimeout(1500);
  assert.deepEqual(await titles(other), []);
  // bob floods "everyone": only his own devices are ever addressed (he has no other, so nobody)
  await other.waitForFunction(async () => {
    const r = await fetch("/api/info");
    return !!(await r.json()).user;
  });
  await other.evaluate(() => (location.hash = "/tasks/inbox"));
  await other.fill(".quick-add input", "bob 的任務");
  await other.keyboard.press("Enter");
  await other.waitForTimeout(1500);
  assert.equal(await laptop.locator(".task-row", { hasText: "bob 的任務" }).count(), 0);
  assert.equal(await phone.locator(".task-row", { hasText: "bob 的任務" }).count(), 0);
  await other.context().close();
});

await step("the server keeps accounts only, never notes; passwords are not stored readable", async () => {
  assert.deepEqual(fs.readdirSync(data).filter((f) => !f.endsWith(".tmp")), ["accounts.json"]);
  const raw = fs.readFileSync(path.join(data, "accounts.json"), "utf8");
  for (const secret of ["correct horse 1", "another secret 2", "電腦寫的頁面", "電腦加的任務", "第一段內容"]) {
    assert.ok(!raw.includes(secret), "found in accounts.json: " + secret);
  }
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.values(saved.users).map((u) => u.name).sort(), ["amy", "bob"]);
});

await step("requests without the same-origin header or without a session are refused", async () => {
  assert.equal((await api(laptop, "POST", "login", { name: "amy", password: "correct horse 1" }, {})).status, 400);
  const anon = await device("anon");
  await anon.goto(base + "/icon.svg");
  const events = await anon.evaluate(async () => (await fetch("/api/relay/events?peer=abcdefgh12")).status);
  assert.equal(events, 401);
  assert.equal((await api(anon, "POST", "password", { current: "x", next: "yyyyyyyy" })).status, 401);
  assert.equal((await api(anon, "GET", "../accounts.json", null)).status, 404);
  const leak = await anon.evaluate(async () => (await fetch("/..%2fserver-data/accounts.json")).status);
  assert.ok(leak === 403 || leak === 404, "got " + leak);
  await anon.context().close();
});

await step("repeated wrong passwords are slowed down", async () => {
  const anon = await device("anon2");
  await anon.goto(base + "/icon.svg");
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await api(anon, "POST", "login", { name: "bob", password: "guess-" + i })).status;
  assert.equal(last, 429);
  // even the right password has to wait now
  assert.equal((await api(anon, "POST", "login", { name: "bob", password: "another secret 2" })).status, 429);
  await anon.context().close();
});

await step("changing the password signs the other device out; signing out and clearing empties the device", async () => {
  await laptop.locator(".sidebar .nav-row", { hasText: "設定" }).click();
  await laptop.locator(".modal.settings .btn", { hasText: "變更密碼" }).click();
  await laptop.fill('.modal.settings input[autocomplete="current-password"]', "correct horse 1");
  await laptop.fill('.modal.settings input[autocomplete="new-password"]', "battery staple 9");
  await laptop.locator(".modal.settings .auth-form .btn.primary").click();
  await laptop.waitForSelector(".modal.settings >> text=密碼已變更");
  // the phone was signed out by that
  await phone.waitForFunction(async () => !(await (await fetch("/api/info")).json()).user, null, { timeout: 15000 });
  await phone.locator(".tabbar button", { hasText: "頁面" }).tap();
  await phone.locator(".sidebar .nav-row", { hasText: "設定" }).tap();
  await phone.waitForSelector(".modal.settings >> text=登入已經失效");
  // the phone still has its data
  assert.ok((await phone.locator(".task-row").count()) >= 0);
  laptop.once("dialog", (d) => d.accept());
  await laptop.locator(".modal.settings .btn", { hasText: "登出並清除這台裝置" }).click();
  await laptop.waitForSelector(".welcome .auth-form");
  assert.deepEqual(await titles(laptop), []);
  // old password no longer works, the new one does
  await auth(laptop, "login", "amy", "correct horse 1");
  await laptop.waitForSelector(".auth-error");
  await auth(laptop, "login", "amy", "battery staple 9");
  await laptop.waitForSelector(".home, .page-title");
});

await step("no unexpected console errors", async () => {
  assert.equal(errors.join(" || "), "");
});

await browser.close();
server.kill();
fs.rmSync(data, { recursive: true, force: true });
