// End-to-end smoke test. Usage: node e2e/smoke.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://localhost:5183";
const shots = process.argv[3];
const browser = await chromium.launch({ channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, locale: "zh-TW" });
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
    await shot("fail-" + name.replace(/[^a-z]+/gi, "-"));
    process.exitCode = 1;
  }
};
const rowCount = (n) =>
  page.waitForFunction((k) => document.querySelectorAll(".db-table tbody tr").length === k, n);

await page.goto(base);

await step("seeded welcome page opens", async () => {
  await page.waitForSelector(".page-title");
  assert.equal(await page.inputValue(".page-title"), "歡迎使用");
  await page.waitForSelector(".bn-editor");
  await shot("01-home");
});

await step("typing in the editor persists across reload", async () => {
  await page.click(".bn-editor >> text=記得偶爾到");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("persist-check-123");
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForSelector(".bn-editor >> text=persist-check-123");
});

await step("slash menu shows custom items and creates a sub-page", async () => {
  await page.click(".bn-editor >> text=persist-check-123");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/頁面");
  await page.waitForSelector(".bn-suggestion-menu");
  await shot("02-slash");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await page.fill(".page-title", "子頁面測試");
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".crumb").count(), 2);
  await page.click(".crumb >> nth=0");
  await page.waitForSelector(".page-link >> text=子頁面測試");
});

await step("callout block inserts", async () => {
  await page.click(".bn-editor >> text=persist-check-123");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/標註");
  await page.waitForSelector(".bn-suggestion-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".callout");
  await page.keyboard.type("重點提示");
  await page.waitForSelector(".callout >> text=重點提示");
  await page.waitForTimeout(700);
  await shot("03-blocks");
});

await step("database: table edit, new row, filter, board, calendar", async () => {
  await page.click(".sidebar .chevron >> nth=0");
  await page.click(".sidebar .tree-main >> text=專案追蹤");
  await page.waitForSelector(".db-table");
  await rowCount(3);
  await shot("04-table");
  await page.click(".table-wrap .add-row");
  await rowCount(4);
  const last = page.locator(".db-table tbody tr").nth(3);
  await last.locator(".cell-input.strong").fill("新的一列");
  await last.locator(".cell-input.strong").press("Enter");
  await last.locator(".cell-select").click();
  await page.fill(".select-menu .input", "卡關");
  await page.keyboard.press("Enter");
  await last.locator(".tag >> text=卡關").waitFor();
  await page.click(".db-tools button:has-text('篩選')");
  await page.click(".popover >> text=新增條件");
  await page.fill(".rule .input", "新的");
  await page.keyboard.press("Enter");
  await rowCount(1);
  await page.click(".rule .icon-btn");
  await rowCount(4);
  await page.keyboard.press("Escape");
  await page.click(".db-tab >> text=看板");
  await page.waitForSelector(".board-col");
  assert.equal(await page.locator(".board-col:not(.new)").count(), 4);
  await shot("05-board");
  const target = ".board-col:has(.board-head :text-is('完成'))";
  await page.dragAndDrop(".card:has-text('新的一列')", target);
  await page.waitForSelector(target + " .card:has-text('新的一列')");
  await page.click(".db-tab >> text=月曆");
  await page.waitForSelector(".cal-item");
  await shot("06-calendar");
});

await step("row opens as a page with editable properties", async () => {
  await page.click(".cal-item >> nth=0");
  await page.waitForSelector(".row-props");
  assert.ok((await page.locator(".row-prop").count()) >= 2);
  await shot("07-row");
});

await step("tasks: quick add parses, repeat rolls forward, complete", async () => {
  await page.click(".sidebar .nav-row >> text=待辦");
  await page.waitForSelector(".quick-add input");
  await page.fill(".quick-add input", "明天 交報告 !3 #工作");
  await page.keyboard.press("Enter");
  await page.click(".tasks-nav >> text=最近 7 天");
  const row = page.locator(".task-row:has-text('交報告')");
  await row.waitFor();
  assert.match(await row.innerText(), /明天/);
  assert.match(await row.innerText(), /#工作/);
  await row.locator(".task-title").click();
  await page.waitForSelector(".task-detail");
  await page.selectOption(".task-detail .detail-grid select >> nth=0", "daily");
  await shot("08-tasks");
  await row.locator(".task-check").click();
  await page.waitForFunction(
    () => !document.querySelector(".tasks-main .task-row .task-title")?.closest(".task-row")?.textContent.includes("明天") ||
      [...document.querySelectorAll(".tasks-main .task-row")].every((r) => !r.textContent.includes("交報告") || !r.textContent.includes("明天")),
  );
  assert.equal(await row.locator(".task-check").isChecked(), false);
  await page.click(".tasks-nav >> text=今天");
  const open = ".tasks-main .task-row:not(.done)";
  await page.waitForSelector(open);
  const before = await page.locator(open).count();
  await page.locator(".task-row:has-text('逛逛這個工作區') .task-check").click();
  await page.waitForFunction(([s, n]) => document.querySelectorAll(s).length === n - 1, [open, before]);
});

await step("focus timer and habits", async () => {
  await page.click(".tasks-nav >> text=番茄鐘");
  await page.waitForSelector(".focus-time");
  assert.equal(await page.innerText(".focus-time"), "25:00");
  await page.click("button:has-text('開始專注')");
  await page.waitForFunction(() => document.querySelector(".focus-time").textContent !== "25:00");
  await shot("09-focus");
  await page.click("button:has-text('放棄')");
  await page.click(".tasks-nav >> text=習慣打卡");
  await page.fill(".quick-add input", "喝水");
  await page.keyboard.press("Enter");
  await page.click(".habit-table tbody tr td:nth-child(8) .habit-dot");
  await page.waitForSelector(".streak >> text=1 天");
  await shot("10-habits");
});

await step("search finds body text; trash and restore", async () => {
  await page.keyboard.press("Control+k");
  await page.fill(".search-input", "persist-check");
  await page.waitForSelector(".search-row >> text=歡迎使用");
  await shot("11-search");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "歡迎使用");
  await page.click(".topbar button[title='頁面選單']");
  await page.click(".popover >> text=移到垃圾桶");
  await page.waitForSelector(".banner");
  assert.equal(await page.locator(".sidebar .tree-row").count(), 0);
  await page.click(".banner >> text=還原");
  await page.waitForSelector(".sidebar .tree-row");
});

await step("dark theme and backup export", async () => {
  await page.click(".sidebar >> text=設定與備份");
  await page.click(".seg-btn >> text=深色");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('匯出備份')")]);
  assert.match(dl.suggestedFilename(), /^slate-backup-.*\.json$/);
  await page.click(".modal-foot .btn");
  await shot("12-dark");
});

await step("works offline after first load", async () => {
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
  await page.waitForTimeout(1500);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector(".page-title");
  await ctx.setOffline(false);
});

await step("no console errors", async () => {
  assert.equal(errors.join(" || ").slice(0, 600), "");
});

if (errors.length) console.log(errors.join(" || ").slice(0, 1500));
await browser.close();
