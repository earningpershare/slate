// Linking two devices with a code and syncing between them, end to end.
// Starts its own copy of the built app and a local meeting point (PeerJS broker), so it
// does not depend on the public one. Run `npm run build` first.
// Usage: node e2e/sync.mjs [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const shots = process.argv[2];
const PORT = 5197;
const BROKER = 5198;
const base = "http://localhost:" + PORT;

const children = [
  spawn(process.execPath, ["node_modules/peer/dist/bin/peerjs.js", "--port", String(BROKER)], { stdio: "ignore" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" }),
];
const stop = () => children.forEach((c) => c.kill());
process.on("exit", stop);
for (const url of [base, `http://localhost:${BROKER}/`]) {
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    if (i > 60) throw new Error("did not start: " + url);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({ channel: "msedge" });
const errors = [];
const watchPage = (name, page) => {
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => errors.push(name + " pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(name + " console: " + m.text()));
  return page;
};
const device = async (name, opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW", ...opts });
  // devices meet at the local broker instead of the public one
  await ctx.addInitScript((b) => localStorage.setItem("slate:broker", b), "localhost:" + BROKER);
  return watchPage(name, await ctx.newPage());
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
const store = (page, table) =>
  page.evaluate(
    (table) =>
      new Promise((res) => {
        const open = indexedDB.open("slate-workspace");
        open.onsuccess = () => {
          const d = open.result;
          const q = d.transaction(table).objectStore(table).getAll();
          q.onsuccess = () => (d.close(), res(q.result));
        };
      }),
    table,
  );
const titles = async (page) => (await store(page, "pages")).filter((p) => !p.isRow).map((p) => p.title).sort();
/** wait until `check()` holds */
const until = async (what, check, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("never happened: " + what);
};
const openSettings = async (page, phone) => {
  if (phone) {
    await page.locator(".tabbar button", { hasText: "頁面" }).tap();
    await page.locator(".sidebar .nav-row", { hasText: "設定" }).tap();
  } else await page.locator(".sidebar .nav-row", { hasText: "設定" }).click();
  await page.waitForSelector(".link");
};

const laptop = await device("laptop");
let phone = await device("phone", {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
});

await step("each device starts on its own with sample content", async () => {
  await laptop.goto(base);
  await phone.goto(base);
  await laptop.waitForSelector(".page-title");
  await phone.waitForSelector(".page-title");
  assert.deepEqual(await titles(laptop), ["專案追蹤", "歡迎使用"]);
  assert.deepEqual(await titles(phone), ["專案追蹤", "歡迎使用"]);
});

await step("write something on the laptop, with an attachment", async () => {
  await laptop.keyboard.press("Alt+n");
  await laptop.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await laptop.fill(".page-title", "電腦寫的頁面");
  await laptop.keyboard.press("Enter");
  await laptop.keyboard.type("第一段內容");
  await laptop.waitForTimeout(800);
  // big enough to need several messages (0.7 MB of a known pattern)
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

let code = "";
await step("the laptop shows a link code", async () => {
  await openSettings(laptop, false);
  await laptop.locator(".link .btn.primary", { hasText: "顯示連結碼" }).click();
  await laptop.waitForSelector(".link-code");
  code = (await laptop.locator(".link-code").innerText()).trim();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  if (shots) await laptop.screenshot({ path: shots + "/s-01-code.png" });
});

await step("a wrong code is refused with a clear message", async () => {
  await openSettings(phone, true);
  await phone.locator(".link .btn", { hasText: "輸入連結碼" }).tap();
  await phone.fill(".link-input", code.startsWith("AAAA") ? "BBBB-BBBB" : "AAAA-" + code.slice(5));
  await phone.locator(".link .btn.primary").tap();
  await phone.waitForSelector(".auth-error >> text=找不到這組連結碼", { timeout: 30_000 });
  assert.deepEqual((await store(phone, "meta")).filter((x) => x.key === "link:group"), []);
});

await step("the right code links the phone, and it receives the laptop's workspace", async () => {
  await phone.fill(".link-input", code.toLowerCase().replace("-", " ")); // typed sloppily
  await phone.locator(".link .btn.primary").tap();
  await phone.waitForSelector(".link-devices li", { timeout: 30_000 });
  await until("phone has the laptop's page", async () => (await titles(phone)).includes("電腦寫的頁面"));
  // the phone's own untouched sample pages were dropped instead of doubling up
  await until("no duplicates", async () => JSON.stringify(await titles(phone)) === JSON.stringify(["專案追蹤", "歡迎使用", "電腦寫的頁面"]));
  assert.deepEqual(await titles(laptop), ["專案追蹤", "歡迎使用", "電腦寫的頁面"]);
  // each sees the other as connected
  await laptop.waitForSelector(".link-devices .link-dot.on");
  await phone.waitForSelector(".link-devices .link-dot.on");
  assert.match(await laptop.locator(".link-devices li").innerText(), /Android 手機/);
  assert.match(await phone.locator(".link-devices li").innerText(), /Windows 電腦/);
  if (shots) await phone.screenshot({ path: shots + "/s-02-linked-phone.png" });
  if (shots) await laptop.screenshot({ path: shots + "/s-03-linked-laptop.png" });
});

await step("the attachment arrived whole", async () => {
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
  await until("file on phone", async () => (file = await readFile()));
  assert.equal(JSON.stringify(file), JSON.stringify({ size: 700000, ok: true, name: "big.png", type: "image/png" }));
});

await step("an edit on the phone shows up on the laptop while its page is open", async () => {
  await phone.keyboard.press("Escape");
  await laptop.keyboard.press("Escape");
  await phone.locator(".tabbar button", { hasText: "頁面" }).tap();
  await phone.locator(".tree-main", { hasText: "電腦寫的頁面" }).tap();
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
  await until("page trashed on phone", async () => (await store(phone, "pages")).some((p) => p.title === "電腦寫的頁面" && p.deletedAt));
});

await step("changes made while the other device is closed are merged when it comes back, without a code", async () => {
  const ctx = phone.context();
  await phone.close();
  await laptop.waitForTimeout(500);
  await laptop.fill(".quick-add input", "手機關著時電腦加的");
  await laptop.keyboard.press("Enter");
  await laptop.waitForTimeout(500);
  phone = watchPage("phone", await ctx.newPage());
  await phone.goto(base + "/#/tasks/inbox");
  await phone.waitForSelector(".task-row >> text=手機關著時電腦加的", { timeout: 30_000 });
  await phone.fill(".quick-add input", "手機回來後加的");
  await phone.keyboard.press("Enter");
  await laptop.waitForSelector(".task-row >> text=手機回來後加的");
});

await step("a reload reconnects on its own", async () => {
  await laptop.reload();
  await laptop.waitForSelector(".quick-add input");
  await laptop.fill(".quick-add input", "重新整理後加的");
  await laptop.keyboard.press("Enter");
  await phone.waitForSelector(".task-row >> text=重新整理後加的", { timeout: 30_000 });
});

await step("the meeting point only ever sees derived ids, never the shared secret", async () => {
  const group = (await store(laptop, "meta")).find((m) => m.key === "link:group").value;
  assert.match(group.secret, /^[0-9a-f]{64}$/);
  const me = (await store(laptop, "meta")).find((m) => m.key === "link:device").value;
  assert.match(me.id, /^[0-9a-f]{24}$/);
});

await step("stopping sync on the phone keeps its data and ends the exchange", async () => {
  await openSettings(phone, true);
  phone.once("dialog", (d) => d.accept());
  await phone.locator(".link .btn.danger", { hasText: "停止同步" }).tap();
  await phone.waitForSelector(".link .btn.primary >> text=顯示連結碼");
  await phone.keyboard.press("Escape");
  assert.ok((await store(phone, "tasks")).some((t) => t.title === "重新整理後加的"));
  // the laptop forgot the phone
  await until("laptop forgot the phone", async () => (await store(laptop, "meta")).find((m) => m.key === "link:group")?.value.members.length === 0);
  await laptop.fill(".quick-add input", "停止同步後加的");
  await laptop.keyboard.press("Enter");
  await laptop.waitForTimeout(2500);
  assert.ok(!(await store(phone, "tasks")).some((t) => t.title === "停止同步後加的"));
});

await step("no console errors", async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
stop();
process.exit(process.exitCode ?? 0);
