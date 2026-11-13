// Importing from Notion and TickTick through the real settings screen, with the real
// Markdown parser. Usage: npm run build && npm start, then: node e2e/import.mjs [url]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const base = process.argv[2] ?? "http://localhost:5183/";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slate-import-"));

/** a deflated zip, like the ones Notion hands out */
function zip(files) {
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const raw = Buffer.from(value);
    const body = zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, n, body);
    dir.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(dir.length / 2, 8);
  end.writeUInt16LE(dir.length / 2, 10);
  end.writeUInt32LE(dir.reduce((a, d) => a + d.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...dir, end]);
}

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const notion = path.join(tmp, "notion.zip");
fs.writeFileSync(
  notion,
  zip({
    [`讀書筆記 ${A}.md`]: `# 讀書筆記\n\n## 重點\n\n- 第一點\n- 第二點\n\n- [ ] 還沒做\n- [x] 做完了\n\n接著看 [第二章](${encodeURIComponent(`讀書筆記 ${A}`)}/${encodeURIComponent(`第二章 ${B}`)}.md)\n\n![圖](${encodeURIComponent(`讀書筆記 ${A}`)}/pic.png)\n`,
    [`讀書筆記 ${A}/第二章 ${B}.md`]: `# 第二章\n\n**粗體** 和 \`程式碼\`\n`,
    [`讀書筆記 ${A}/pic.png`]: png,
    [`讀書筆記 ${A}/書單 ${C}.csv`]: `書名,頁數,讀完\n原子習慣,320,Yes\n深度工作,304,No\n`,
  }),
);
const ticktick = path.join(tmp, "ticktick.csv");
fs.writeFileSync(
  ticktick,
  `"Date: 2024-03-01+0000"\n"Version: 7.1"\n"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"\n"","工作","從滴答來的任務","TEXT","","","N","","","","","5","0","2024-03-01T02:00:00+0000","","0","Asia/Taipei","true","false","","","list","1",""\n"","工作","已完成的任務","TEXT","","","N","","","","","0","2","2024-03-01T02:00:00+0000","2024-03-02T02:00:00+0000","0","Asia/Taipei","true","false","","","list","2",""\n`,
);

const browser = await chromium.launch({ channel: "msedge" });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW" })).newPage();
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(base);
await page.waitForSelector(".page-title");

/** open an imported page by its title */
const go = async (title) => {
  const id = await page.evaluate(
    (title) =>
      new Promise((res) => {
        const o = indexedDB.open("slate-workspace");
        o.onsuccess = () => {
          const q = o.result.transaction("pages").objectStore("pages").getAll();
          q.onsuccess = () => (o.result.close(), res(q.result.find((p) => p.title === title)?.id));
        };
      }),
    title,
  );
  assert.ok(id, "no page called " + title);
  await page.evaluate((id) => (location.hash = "/p/" + id), id);
};
const choose = async (file) => {
  await page.locator(".sidebar .nav-row", { hasText: "設定" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".settings .btn", { hasText: "從 Notion／滴答清單匯入" }).click();
  await (await chooser).setFiles(file);
};

await choose(notion);
await page.waitForSelector(".settings .status >> text=已從 Notion 匯入 2 個頁面、1 個資料庫（2 列）、1 個附件");
await page.keyboard.press("Escape");
console.log("ok   a Notion export is imported from the settings");

// everything landed under one page, which is where the import leaves you
await page.waitForFunction(() => document.querySelector(".page-title")?.value === "從 Notion 匯入");
await go("讀書筆記");
await page.waitForSelector(".bn-editor h2 >> text=重點");
assert.equal(await page.locator('.bn-editor [data-content-type="bulletListItem"]').count(), 2);
assert.equal(await page.locator('.bn-editor [data-content-type="checkListItem"]').count(), 2);
await page.waitForFunction(() => [...document.querySelectorAll(".bn-editor img")].some((i) => i.naturalWidth > 0));
console.log("ok   headings, lists, checkboxes and the picture arrive as real blocks");

await page.locator(".bn-editor .page-link", { hasText: "第二章" }).click();
await page.waitForFunction(() => document.querySelector(".page-title")?.value === "第二章");
await page.waitForSelector(".bn-editor strong >> text=粗體");
console.log("ok   a link between Notion pages opens the imported page");

await go("書單");
// cells are text or inputs depending on the column
const shows = (what) =>
  page.waitForFunction(
    (what) => document.body.innerText.includes(what) || [...document.querySelectorAll("input, textarea")].some((i) => i.value === what),
    what,
  );
await shows("原子習慣");
await shows("深度工作");
await shows("320");
await shows("頁數");
console.log("ok   the Notion database has its rows and columns");

await choose(ticktick);
await page.waitForSelector(".settings .status >> text=已從滴答清單匯入 2 筆任務、1 個清單");
await page.keyboard.press("Escape");
await page.locator(".tasks-nav .nav-row", { hasText: "工作" }).click();
await page.waitForSelector(".task-row >> text=從滴答來的任務");
console.log("ok   a TickTick backup becomes tasks in their list");

await choose(ticktick);
await page.waitForSelector(".settings .status >> text=已從滴答清單匯入 2 筆任務。");
await page.keyboard.press("Escape");
await page.locator(".tasks-nav .nav-row", { hasText: "工作" }).click();
await page.waitForSelector(".task-row >> text=從滴答來的任務");
assert.equal(await page.locator(".task-row", { hasText: "從滴答來的任務" }).count(), 1);
assert.equal(await page.locator(".tasks-nav .nav-row", { hasText: "工作" }).count(), 1);
console.log("ok   importing the same backup again does not double anything");

assert.deepEqual(errors, []);
console.log("ok   no console errors");
await browser.close();
