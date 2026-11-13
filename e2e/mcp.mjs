// The MCP bridge end to end: this script plays the MCP client (what Claude Desktop or
// Claude Code would be), the real bridge program runs, and a real Slate tab does the work.
// Usage: npm run build && npm start, then: node e2e/mcp.mjs [url] [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const base = process.argv[2] ?? "http://localhost:5183/";
const shots = process.argv[3];
const PORT = 47811;
const origin = new URL(base).origin;

/** Start a copy of the bridge and talk JSON-RPC to it over its stdin/stdout. */
function client() {
  const child = spawn(process.execPath, ["public/slate-mcp.mjs"], { env: { ...process.env, SLATE_MCP_PORT: String(PORT), SLATE_ORIGINS: origin }, stdio: ["pipe", "pipe", "ignore"] });
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
  assert.ok(tools.length >= 12);
  assert.deepEqual(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort(), ["delete_task", "trash_page"]);
  assert.ok(tools.every((t) => t.inputSchema.type === "object" && t.description.length > 30));
  assert.deepEqual((await claude.request("ping")).result, {});
});

await step("while Slate has not allowed it, a call explains what the person must switch on", async () => {
  const r = await claude.tool("list_tasks");
  assert.equal(r.isError, true);
  assert.match(r.text, /Slate is not connected.*允許這台電腦上的 Claude 連進來/s);
});

await step("the person switches it on in Slate, and the tab finds the bridge", async () => {
  await page.locator(".sidebar .nav-row", { hasText: "AI 助理" }).click();
  await page.locator(".ai-setup .seg-btn", { hasText: "Claude 訂閱" }).click();
  assert.equal(await page.locator(".ai-setup .btn.primary").isVisible(), false); // nothing to "save" on this tab
  const href = await page.locator(".ai-mcp a[download]").getAttribute("href");
  const file = await fetch(new URL(href, base)).then((r) => r.text());
  assert.match(file, /^#!\/usr\/bin\/env node/); // the download is the bridge itself
  await page.locator(".ai-switch input").check();
  await page.waitForSelector(".ai-bridge-state.connected");
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
  assert.equal((await fetch(url + "/result", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(url + "/poll")).status, 403); // no origin at all
  // the door for sibling copies needs the secret from the person's home folder, and no web page may use it
  assert.equal((await fetch(url + "/call", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"list_tasks","input":{}}' })).status, 403);
  assert.equal((await fetch(url + "/call", { method: "POST", headers: { "x-slate-mcp": "guess", "content-type": "application/json" }, body: "{}" })).status, 403);
  // from the Slate page itself the browser's own check passes
  const fromPage = await page.evaluate((u) => fetch(u + "/hello").then((r) => r.status), url);
  assert.equal(fromPage, 204);
});

await step("switching it off stops the tab from listening", async () => {
  await page.locator(".ai-switch input").uncheck();
  await page.waitForSelector(".ai-bridge-state", { state: "detached" });
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
