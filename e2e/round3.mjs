// End-to-end test for: table grouping + keyboard, row menu, rollup, CSV import, board groups,
// home + daily note, Eisenhower matrix, page typography.
// Usage: node e2e/round3.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:5183";
const shots = process.argv[3];
const browser = await chromium.launch({ channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-TW" });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const step = async (name, fn) => {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n     " + String(e.message).split("\n").slice(0, 3).join(" | "));
    await shot("fail-" + name.replace(/[^a-z0-9]+/gi, "-"));
    process.exitCode = 1;
  }
};
const rowCount = (n) =>
  page.waitForFunction((k) => document.querySelectorAll(".db-table tr.data-row").length === k, n);
const addProp = async (label) => {
  await page.click(".db-table thead .col-add .icon-btn");
  await page.click(`.popover .menu-label:text-is("${label}")`);
  await page.waitForSelector(`.db-table thead .th-btn:text-is("${label}")`);
};
const openDb = async (name) => {
  await page.click(`.sidebar .tree-main >> text=${name}`);
  await page.waitForSelector(".database .db-tab");
};

await page.goto(base);
await page.waitForSelector(".bn-editor");
await page.click(".sidebar .chevron >> nth=0");

await step("home shows today's tasks and recent pages", async () => {
  await page.click(".sidebar .nav-row >> text=首頁");
  await page.waitForSelector(".home h1");
  assert.equal(await page.locator(".home-task").count(), 2);
  assert.ok((await page.locator(".home-page").count()) >= 2);
  await page.fill(".home .quick-add input", "首頁加的任務 !3");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".home-task").length === 3);
  await page.locator(".home-task:has-text('逛逛這個工作區') input").click();
  await page.waitForFunction(() => document.querySelectorAll(".home-task").length === 2);
  await shot("r3-01-home");
});

await step("daily note is created once and reused", async () => {
  await page.click(".sidebar .nav-row >> text=今日筆記");
  await page.waitForFunction(() => /年.*月.*日/.test(document.querySelector(".page-title")?.value ?? ""));
  const title = await page.inputValue(".page-title");
  await page.waitForFunction(() => document.querySelectorAll(".crumb").length === 2);
  await page.click(".sidebar .nav-row >> text=首頁");
  await page.click(".home-actions >> text=今日筆記");
  await page.waitForFunction((t) => document.querySelector(".page-title")?.value === t, title);
  await page.click(".sidebar .tree-row:has-text('日誌') .chevron");
  assert.equal(await page.locator(".sidebar .tree-main >> text=" + title.slice(0, 8)).count(), 1);
});

await step("table groups by a select property", async () => {
  await openDb("專案追蹤");
  await page.selectOption(".db-tools .tool-select:has-text('分組') select", { label: "狀態" });
  await page.waitForSelector(".group-row");
  assert.equal(await page.locator(".group-row").count(), 3);
  // add inside a group presets that group's value
  await page.click(".group-row:has-text('進行中') button[title*='新增']");
  await rowCount(4);
  await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "未命名" && document.activeElement.value === "");
  await page.keyboard.type("分組新增的列");
  await page.keyboard.press("Tab");
  await page.waitForSelector(".data-row:has-text('進行中') input[value='分組新增的列']");
  // collapse hides the rows
  await page.click(".group-row:has-text('進行中') .icon-btn >> nth=0");
  await rowCount(2);
  await page.click(".group-row:has-text('進行中') .icon-btn >> nth=0");
  await rowCount(4);
  await shot("r3-02-grouped");
  await page.selectOption(".db-tools .tool-select:has-text('分組') select", "");
  await page.waitForSelector(".group-row", { state: "detached" });
});

await step("keyboard: arrows and Enter move between rows", async () => {
  const first = page.locator(".db-table tr.data-row").first().locator(".cell-input.strong");
  await first.click();
  await page.keyboard.press("ArrowDown");
  const focused = () =>
    page.evaluate(() => document.activeElement?.closest("tr")?.rowIndex ?? -1);
  assert.equal(await focused(), 2);
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(), 1);
  await page.keyboard.press("Enter");
  assert.equal(await focused(), 2);
  // Enter on the last row only commits; it must not create rows by accident
  await page.locator(".db-table tr.data-row").last().locator(".cell-input.strong").click();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await rowCount(4);
  await page.click(".table-wrap > .add-row");
  await rowCount(5);
  await page.waitForFunction(() => document.activeElement?.closest("tr")?.rowIndex === 5);
  await page.keyboard.type("鍵盤新增");
  await page.keyboard.press("Tab");
  await page.waitForSelector(".db-table input[value='鍵盤新增']");
});

await step("row menu duplicates and deletes with undo", async () => {
  const row = page.locator(".db-table tr.data-row:has(input[value='鍵盤新增'])");
  await row.hover();
  await row.locator("button[title='列選單']").click();
  await page.click(".popover .menu-label:text-is('複製')");
  await rowCount(6);
  await page.waitForSelector(".db-table input[value='鍵盤新增（副本）']");
  const copy = page.locator(".db-table tr.data-row:has(input[value='鍵盤新增（副本）'])");
  await copy.hover();
  await copy.locator("button[title='列選單']").click();
  await page.click(".popover .menu-label:text-is('刪除')");
  await rowCount(5);
  await page.click(".toast button:has-text('復原')");
  await rowCount(6);
});

await step("CSV import adds rows and creates typed columns", async () => {
  const file = path.join(os.tmpdir(), "slate-import-test.csv");
  fs.writeFileSync(
    file,
    "﻿名稱,狀態,預算,負責人\r\n匯入甲,完成,1200,小明\r\n\"匯入乙, 含逗號\",全新狀態,800,小華\r\n",
  );
  await page.click(".topbar button[title='頁面選單']");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click(".popover .menu-label:text-is('匯入 CSV')"),
  ]);
  await chooser.setFiles(file);
  await page.waitForSelector(".toast >> text=已匯入 2 筆");
  await rowCount(8);
  await page.waitForSelector('.db-table thead .th-btn:text-is("預算")');
  const a = page.locator(".db-table tr.data-row:has(input[value='匯入甲'])");
  assert.equal(await a.locator('input[aria-label="預算"]').inputValue(), "1200");
  await a.locator(".tag >> text=完成").waitFor();
  await page.waitForSelector(".db-table tr.data-row:has(input[value='匯入乙, 含逗號']) .tag >> text=全新狀態");
  fs.unlinkSync(file);
});

await step("rollup sums a property across a relation", async () => {
  // a second database that points at 專案追蹤
  await page.click(".nav-heading button[title='新增頁面或資料庫']");
  await page.click(".popover .menu-label:text-is('資料庫')");
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await page.waitForSelector(".db-table");
  await page.fill(".page-title", "客戶");
  await page.click(".table-wrap > .add-row");
  await rowCount(1);
  await page.waitForFunction(() => document.activeElement?.classList.contains("cell-input"));
  await page.keyboard.type("客戶甲");
  await page.keyboard.press("Tab");
  await addProp("關聯");
  await page.click('.db-table thead .th-btn:text-is("關聯")');
  await page.selectOption(".popover .field:has-text('連到') select", { label: "專案追蹤" });
  await page.keyboard.press("Escape");
  await page.locator(".db-table tr.data-row").first().locator('button[aria-label="關聯"]').click();
  await page.click(".popover .menu-item >> text=匯入甲");
  await page.click(".popover .menu-item >> text=匯入乙");
  await page.keyboard.press("Escape");
  await addProp("彙總");
  await page.click('.db-table thead .th-btn:text-is("彙總")');
  // fields in order: 類型, 關聯, 屬性, 計算
  await page.selectOption(".popover label.field >> nth=1 >> select", { label: "關聯" });
  await page.selectOption(".popover label.field >> nth=2 >> select", { label: "預算" });
  await page.selectOption(".popover label.field >> nth=3 >> select", { label: "加總" });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".db-table .cell-static")].some((c) => c.textContent === "2000"),
  );
  await shot("r3-03-rollup");
  // the same value shows in the row's side peek
  await page.locator(".db-table tr.data-row").first().hover();
  await page.click(".db-table .open-btn");
  await page.waitForSelector(".peek .row-prop .cell-static >> text=2000");
  await page.keyboard.press("Escape");
});

await step("board: add a new group", async () => {
  await openDb("專案追蹤");
  await page.click(".db-tab >> text=看板");
  const before = await page.locator(".board-col:not(.new)").count();
  await page.fill(".board-col.new input", "擱置");
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".board-col:not(.new)").length === n + 1, before);
  await page.waitForSelector(".board-head >> text=擱置");
});

await step("eisenhower matrix places tasks and drag changes them", async () => {
  await page.click(".sidebar .nav-row >> text=待辦");
  await page.click(".tasks-nav >> text=四象限");
  await page.waitForSelector(".matrix .quad");
  await page.waitForSelector(".quad.q1 .task-row >> text=首頁加的任務");
  await page.waitForSelector(".quad.q3 .task-row >> text=到設定匯出一次備份");
  await shot("r3-04-matrix");
  await page.dragAndDrop(".quad.q3 .task-row:has-text('到設定匯出一次備份')", ".quad.q2 h2");
  await page.waitForSelector(".quad.q2 .task-row >> text=到設定匯出一次備份");
});

await step("toasts go away on their own", async () => {
  await page.waitForSelector(".toast", { state: "detached" });
});

await step("page font and small text are per page", async () => {
  await page.click(".sidebar .tree-main >> text=歡迎使用");
  await page.waitForSelector(".bn-editor");
  await page.click(".topbar button[title='頁面選單']");
  await page.click(".font-pick .font-serif");
  await page.click(".popover .menu-label:text-is('小字')");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".page-body.font-serif.small-text");
  const family = await page.evaluate(() => getComputedStyle(document.querySelector(".bn-editor")).fontFamily);
  assert.match(family, /Georgia/);
  await shot("r3-05-serif");
  await page.click(".sidebar .tree-main >> text=客戶");
  await page.waitForSelector(".database");
  assert.equal(await page.locator(".page-body.font-serif").count(), 0);
});

await step("two-column layout keeps text in each column", async () => {
  await page.keyboard.press("Alt+n");
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await page.fill(".page-title", "分欄測試");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/兩欄");
  await page.waitForSelector(".bn-suggestion-menu >> text=兩欄");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-node-type="columnList"] [data-node-type="column"]');
  assert.equal(await page.locator('[data-node-type="column"]').count(), 2);
  await page.keyboard.type("左欄文字");
  await page.locator('[data-node-type="column"]').nth(1).click();
  await page.keyboard.type("右欄文字");
  await page.waitForTimeout(800);
  // side by side: same row, different x
  const boxes = await page.$$eval('[data-node-type="column"]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), text: e.textContent };
    }),
  );
  assert.equal(boxes[0].y, boxes[1].y);
  assert.ok(boxes[1].x > boxes[0].x + 100, JSON.stringify(boxes));
  assert.match(boxes[0].text, /左欄文字/);
  assert.match(boxes[1].text, /右欄文字/);
  await shot("r3-06-columns");
  await page.reload();
  await page.waitForSelector('[data-node-type="column"] >> text=右欄文字');
  // column text is searchable
  await page.keyboard.press("Control+k");
  await page.fill(".search-input", "右欄文");
  await page.waitForSelector(".search-row >> text=分欄測試");
  await page.keyboard.press("Escape");
});

await step("no console errors", async () => {
  assert.equal(errors.join(" || ").slice(0, 600), "");
});

if (errors.length) console.log(errors.join(" || ").slice(0, 1500));
await browser.close();
