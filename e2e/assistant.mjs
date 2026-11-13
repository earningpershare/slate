// The AI assistant end to end, without spending anything: a scripted stand-in plays the
// model for both providers (a local OpenAI-style server, and Anthropic's API intercepted
// in the browser), while the real panel, the real tool loop and the real workspace run.
// Usage: npm run build && npm start, then: node e2e/assistant.mjs [url] [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import http from "node:http";

const base = process.argv[2] ?? "http://localhost:5183/";
const shots = process.argv[3];
const MOCK = 5199;

// ---------- a scripted "local model" ----------
const seen = []; // every request body the model server received
const call = (name, args) => ({ id: "call_" + Math.random().toString(36).slice(2, 10), type: "function", function: { name, arguments: JSON.stringify(args) } });
function localModel(body) {
  const last = body.messages[body.messages.length - 1];
  const user = [...body.messages].reverse().find((m) => m.role === "user").content;
  const say = (content) => ({ role: "assistant", content });
  const use = (...calls) => ({ role: "assistant", content: null, tool_calls: calls });
  if (last.role === "user") {
    if (user.includes("買牛奶")) return use(call("add_task", { title: "買牛奶", due: "2030-01-02", priority: 2 }));
    if (user.includes("刪掉")) {
      // the id comes from what the tool told it earlier, as a real model would use it
      const added = body.messages.find((m) => m.role === "tool" && m.content.includes("買牛奶"));
      return use(call("delete_task", { id: JSON.parse(added.content).id }));
    }
    if (user.includes("改寫")) return use(call("update_page", { id: /id=(\S+)/.exec(user)[1], markdown: "## 由助理改寫\n\n- 第一點\n- 第二點" }));
    if (user.includes("壞掉")) return use(call("add_task", { due: "not a date" }), call("no_such_tool", {}));
    return say("你好！");
  }
  if (last.role === "tool") {
    if (last.content.includes("declined")) return say("好，沒有刪除。");
    if (last.content.includes('"deleted":true')) return say("已經刪除了。");
    if (last.content.includes("Invalid input") || last.content.includes("no tool called")) return say("我剛才呼叫錯了，沒有變更任何東西。");
    if (last.content.includes("買牛奶")) return say("已新增任務「買牛奶」，到期日 2030-01-02。");
    return say("完成了。");
  }
  return say("？");
}
const server = http.createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push(body);
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: localModel(body) }] }));
  });
});
await new Promise((r) => server.listen(MOCK, r));

// ---------- the browser ----------
// A public https site reaching a server on localhost makes the browser ask the person for
// permission ("local network access"). Nobody is there to click in a test, so the check is off here.
const browser = await chromium.launch({ channel: "msedge", args: ["--disable-features=LocalNetworkAccessChecks"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW" })).newPage();
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/status of 401/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n     " + String(e.message).split("\n").slice(0, 4).join(" | "));
    process.exitCode = 1;
  }
};
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
const say = async (text) => {
  await page.fill(".ai-input textarea", text);
  await page.keyboard.press("Enter");
};
const lastReply = () => page.locator(".ai-msg.assistant").last();

await page.goto(base);
await page.waitForSelector(".page-title");

await step("the panel opens from the sidebar and asks for a model first", async () => {
  await page.locator(".sidebar .nav-row", { hasText: "AI 助理" }).click();
  await page.waitForSelector(".ai-panel .ai-setup");
  assert.equal(await page.locator(".ai-setup .btn.primary").isDisabled(), true); // nothing to save yet
  await page.locator(".ai-setup .seg-btn", { hasText: "本機模型" }).click();
  await page.locator(".ai-setup label", { hasText: "位址" }).locator("input").fill(`http://localhost:${MOCK}/v1/`);
  await page.locator(".ai-setup label", { hasText: "模型名稱" }).locator("input").fill("test-model");
  await page.locator(".ai-setup .btn.primary").click();
  await page.waitForSelector(".ai-empty");
  if (shots) await page.screenshot({ path: shots + "/ai-01-empty.png" });
});

await step("local model: a request becomes a real task, and the reply says so", async () => {
  await say("幫我新增任務買牛奶");
  await page.waitForSelector(".ai-text >> text=已新增任務「買牛奶」");
  await page.waitForSelector(".ai-tool.done >> text=新增任務「買牛奶」");
  const task = (await store("tasks")).find((t) => t.title === "買牛奶");
  assert.deepEqual([task.due, task.priority, task.done], ["2030-01-02", 2, false]);
  // what the model was sent: the instructions, every tool, the time, and the tool's answer under its call id
  const [first, second] = seen;
  assert.equal(first.model, "test-model");
  assert.match(first.messages[0].content, /assistant built into Slate/);
  assert.ok(first.tools.length >= 12 && first.tools.every((t) => t.type === "function" && t.function.parameters.additionalProperties === false));
  assert.match(first.messages[1].content, /^\[now: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, 星期.\]\n幫我新增任務買牛奶$/);
  const [assistantTurn, toolTurn] = second.messages.slice(-2);
  assert.equal(toolTurn.tool_call_id, assistantTurn.tool_calls[0].id);
  assert.equal(JSON.parse(toolTurn.content).title, "買牛奶");
});

await step("deleting asks first: declined leaves it, allowed removes it", async () => {
  await say("把它刪掉");
  await page.waitForSelector(".ai-confirm >> text=要讓助理永久刪除任務「買牛奶」嗎？"); // names what would go
  assert.ok((await store("tasks")).some((t) => t.title === "買牛奶")); // nothing happened yet
  if (shots) await page.screenshot({ path: shots + "/ai-02-confirm.png" });
  await page.locator(".ai-confirm .btn", { hasText: "不要" }).click();
  await page.waitForSelector(".ai-text >> text=好，沒有刪除。");
  await page.waitForSelector(".ai-tool.declined");
  assert.ok((await store("tasks")).some((t) => t.title === "買牛奶"));

  await say("還是刪掉好了");
  await page.locator(".ai-confirm .btn", { hasText: "允許" }).click();
  await page.waitForSelector(".ai-text >> text=已經刪除了。");
  assert.ok(!(await store("tasks")).some((t) => t.title === "買牛奶"));
});

await step("a page rewritten by the assistant changes on screen while it is open", async () => {
  const id = (await store("pages")).find((p) => p.title === "歡迎使用").id;
  await page.waitForSelector(".bn-editor >> text=快速上手");
  await say(`改寫這一頁 id=${id}`);
  await page.waitForSelector(".bn-editor h2 >> text=由助理改寫");
  assert.equal(await page.locator('.bn-editor [data-content-type="bulletListItem"]').count(), 2);
  assert.equal(await page.locator(".bn-editor >> text=快速上手").count(), 0);
  // the old version is one click away in the page's history
  assert.ok((await store("history")).some((h) => h.pageId === id && JSON.stringify(h.content).includes("快速上手")));
});

await step("a model that calls tools wrongly changes nothing and gets told why", async () => {
  const before = (await store("tasks")).length;
  await say("壞掉的呼叫");
  await page.waitForSelector(".ai-text >> text=我剛才呼叫錯了");
  assert.equal(await lastReply().locator(".ai-tool.error").count(), 2);
  assert.equal((await store("tasks")).length, before);
  const results = seen[seen.length - 1].messages.filter((m) => m.role === "tool").slice(-2).map((m) => m.content);
  assert.match(results[0], /Invalid input: missing "title"/);
  assert.match(results[1], /no tool called "no_such_tool"/);
});

await step("an unreachable model server gives a message that says what to check", async () => {
  await page.locator('.ai-head [aria-label="模型設定"]').click();
  await page.locator(".ai-setup label", { hasText: "位址" }).locator("input").fill("http://localhost:5990/v1");
  await page.locator(".ai-setup .btn.primary").click();
  await say("在嗎");
  await page.waitForSelector(".ai-msg.error >> text=OLLAMA_ORIGINS");
});

// ---------- Claude, with Anthropic's API intercepted ----------
const claudeRequests = [];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
const finish = (stop_reason) => [{ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }, { type: "message_stop" }];
const textBlock = (index, pieces) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...pieces.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index },
];
const toolBlock = (index, id, name, input) => {
  const json = JSON.stringify(input);
  const cut = Math.ceil(json.length / 2);
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, cut) } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(cut) } },
    { type: "content_block_stop", index },
  ];
};
let claudeStatus = 200;
await page.route("https://api.anthropic.com/**", async (route) => {
  const req = route.request();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = req.postDataJSON();
  claudeRequests.push({ url: req.url(), headers: req.headers(), body });
  if (claudeStatus !== 200) {
    return route.fulfill({ status: claudeStatus, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
  }
  const last = body.messages[body.messages.length - 1];
  const answered = Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
  const events = answered
    ? [start, ...textBlock(0, ["已經幫你", "加到「工作」清單了。"]), ...finish("end_turn")]
    : [start, ...textBlock(0, ["我來處理。"]), ...toolBlock(1, "toolu_01", "add_task", { title: "交報告", list: "工作", due: "2030-05-06", due_time: "15:00" }), ...finish("tool_use")];
  await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(events) });
});

await step("Claude: the key goes straight to Anthropic, and the tool loop does the work", async () => {
  await page.locator('.ai-head [aria-label="模型設定"]').click();
  await page.locator(".ai-setup .seg-btn", { hasText: "Claude API 金鑰" }).click();
  await page.locator(".ai-setup input[type=password]").fill("sk-ant-test-key");
  await page.locator(".ai-setup .btn.primary").click();
  assert.match(await page.locator(".ai-head .ai-model").innerText(), /Claude Opus 5\.5/);
  await say("明天下午三點交報告，放到工作清單");
  await page.waitForSelector(".ai-text >> text=我來處理。已經幫你加到「工作」清單了。");
  await page.waitForSelector(".ai-tool.done >> text=新增任務「交報告」");
  const task = (await store("tasks")).find((t) => t.title === "交報告");
  assert.deepEqual([task.due, task.dueTime], ["2030-05-06", "15:00"]);
  assert.ok((await store("lists")).some((l) => l.name === "工作" && l.id === task.listId));

  const [first, second] = claudeRequests;
  assert.match(first.url, /\/v1\/messages/);
  // the key travels as a bearer token, to Anthropic only
  assert.equal(first.headers["authorization"], "Bearer sk-ant-test-key");
  assert.ok(claudeRequests.every((r) => new URL(r.url).host === "api.anthropic.com"));
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.equal(first.body.stream, true);
  assert.equal(first.body.fallbacks, "default");
  assert.deepEqual(first.body.thinking, { type: "adaptive" });
  assert.deepEqual(first.body.output_config, { effort: "medium" });
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.match(first.body.system, /assistant built into Slate/);
  assert.ok(first.body.tools.length >= 12 && first.body.tools.every((t) => t.eager_input_streaming === true && t.input_schema.type === "object"));
  // the second request carries the model's own turn back unchanged, then the tool's answer
  const [assistantTurn, resultTurn] = second.body.messages.slice(-2);
  assert.deepEqual(assistantTurn.content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(resultTurn.content[0].tool_use_id, "toolu_01");
  assert.equal(JSON.parse(resultTurn.content[0].content).title, "交報告");
  if (shots) await page.screenshot({ path: shots + "/ai-03-claude.png" });
});

await step("Claude: a rejected key is explained, not dumped as an error code", async () => {
  claudeStatus = 401;
  await say("再來一次");
  await page.waitForSelector(".ai-msg.error >> text=API 金鑰無效或已停用");
  claudeStatus = 200;
});

await step("settings stay on this device and out of backups and sync", async () => {
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-settings")));
  assert.equal(saved.claudeKey, "sk-ant-test-key");
  const everything = JSON.stringify([await store("meta"), await store("pages"), await store("tasks")]);
  assert.ok(!everything.includes("sk-ant-test-key"));
});

await step("no console errors", async () => {
  const real = errors.filter((e) => !/ERR_CONNECTION_REFUSED|Failed to fetch/.test(e));
  for (const e of real.slice(0, 3)) console.log("     " + e.slice(0, 700));
  assert.deepEqual(real, []);
});

await browser.close();
server.close();
process.exit(process.exitCode ?? 0);
