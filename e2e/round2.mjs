// End-to-end test for: inline databases, side peek, formula / relation, gallery / timeline,
// mentions + backlinks, templates + outline, history, lock, sidebar reorder, toasts, import.
// Usage: node e2e/round2.mjs [baseUrl] [screenshotDir]
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
const endOfDoc = async () => {
  await page.click(".bn-editor >> text=記得偶爾到");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
};
const slash = async (text) => {
  await page.keyboard.type("/" + text);
  await page.waitForSelector(".bn-suggestion-menu");
  await page.keyboard.press("Enter");
};
const openDb = async () => {
  if ((await page.locator(".sidebar .tree-main >> text=專案追蹤").count()) === 0) {
    await page.click(".sidebar .chevron >> nth=0");
  }
  await page.click(".sidebar .tree-main >> text=專案追蹤");
  await page.waitForSelector(".database .db-tab");
};
const addProp = async (label) => {
  await page.click(".db-table thead .col-add .icon-btn");
  await page.click(`.popover .menu-label:text-is("${label}")`);
  await page.waitForSelector(`.db-table thead .th-btn:text-is("${label}")`);
};

await page.goto(base);
await page.waitForSelector(".bn-editor");

await step("inline database lives inside a page and accepts typing", async () => {
  await endOfDoc();
  await slash("資料庫（內嵌");
  await page.waitForSelector(".inline-db .db-table");
  await page.fill(".inline-db-title", "內嵌清單");
  await page.click(".inline-db .add-row");
  const cell = page.locator(".inline-db .db-table tbody tr").first().locator(".cell-input.strong");
  await cell.waitFor();
  await cell.click();
  await page.keyboard.type("inline-row-1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  await shot("r2-01-inline-db");
  await page.reload();
  await page.waitForSelector(".inline-db .db-table");
  assert.equal(await page.inputValue(".inline-db .db-table tbody tr .cell-input.strong"), "inline-row-1");
  assert.equal(await page.inputValue(".inline-db-title"), "內嵌清單");
  // typing in the table must not have leaked into the document
  assert.equal(await page.locator(".bn-editor >> text=inline-row-1").count(), 0);
});

await step("side peek opens a row, edits it, and closes with Esc", async () => {
  await page.hover(".inline-db .db-table tbody tr");
  await page.click(".inline-db .open-btn:not(.shown)");
  await page.waitForSelector(".peek .page-title");
  assert.equal(await page.inputValue(".peek .page-title"), "inline-row-1");
  await page.click(".peek .bn-editor");
  await page.keyboard.type("peek-body-text");
  await page.waitForTimeout(700);
  await shot("r2-02-peek");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".peek", { state: "detached" });
  await page.keyboard.press("Control+k");
  await page.fill(".search-input", "peek-body");
  await page.waitForSelector(".search-row >> text=inline-row-1");
  await page.keyboard.press("Escape");
});

await step("formula, footer sum and column resize", async () => {
  await openDb();
  await page.waitForSelector(".db-table");
  await addProp("數字");
  await addProp("公式");
  await page.click('.db-table thead .th-btn:text-is("公式")');
  await page.fill('.popover input[aria-label="公式"]', 'prop("數字") * 2 + 1');
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  const rows = page.locator(".db-table tbody tr");
  for (const [i, n] of [[0, "20"], [1, "5"]]) {
    await rows.nth(i).locator('input[aria-label="數字"]').fill(n);
    await rows.nth(i).locator('input[aria-label="數字"]').press("Enter");
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".db-table tbody tr:first-child .cell-static")].some((c) => c.textContent === "41"),
  );
  // a broken formula shows a warning instead of crashing
  await page.click('.db-table thead .th-btn:text-is("公式")');
  await page.fill('.popover input[aria-label="公式"]', 'prop("不存在") +');
  await page.keyboard.press("Enter");
  await page.waitForSelector(".formula-error");
  await page.waitForSelector(".db-table .cell-static.error");
  await page.fill('.popover input[aria-label="公式"]', 'prop("數字") * 2 + 1');
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  // footer: sum of the number column
  const numIndex = await page.evaluate(() =>
    [...document.querySelectorAll(".db-table thead th")].findIndex((th) => th.textContent === "數字"),
  );
  await page.hover(".db-table tfoot");
  await page.locator(".db-table tfoot td").nth(numIndex).locator(".calc-btn").click();
  await page.click('.popover .menu-label:text-is("加總")');
  await page.waitForFunction(
    (i) => document.querySelectorAll(".db-table tfoot td")[i].textContent.includes("25"),
    numIndex,
  );
  // resize the title column
  const th = page.locator(".db-table thead th.col-title");
  const before = (await th.boundingBox()).width;
  const h = await th.locator(".col-resize").boundingBox();
  await page.mouse.move(h.x + 3, h.y + 10);
  await page.mouse.down();
  await page.mouse.move(h.x + 83, h.y + 10, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = (await th.boundingBox()).width;
  assert.ok(Math.abs(after - before - 80) < 6, `width ${before} -> ${after}`);
  await shot("r2-03-formula");
});

await step("relation links rows across databases", async () => {
  await addProp("關聯");
  await page.click('.db-table thead .th-btn:text-is("關聯")');
  await page.selectOption(".popover .field:has-text('連到') select", { label: "內嵌清單" });
  await page.keyboard.press("Escape");
  await page.locator(".db-table tbody tr").first().locator('button[aria-label="關聯"]').click();
  await page.click(".popover .menu-item >> text=inline-row-1");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".db-table tbody tr:first-child .rel-chip >> text=inline-row-1");
  // in-view search matches the related title
  await page.click(".db-tools button[title='搜尋']");
  await page.fill(".db-search input", "inline-row");
  await page.waitForFunction(() => document.querySelectorAll(".db-table tbody tr").length === 1);
  await page.fill(".db-search input", "");
  await page.keyboard.press("Escape");
});

await step("gallery and timeline views", async () => {
  await page.click(".db-tabs > .icon-btn");
  await page.click('.popover .menu-item:has-text("畫廊")');
  await page.waitForSelector(".gallery-card");
  assert.equal(await page.locator(".gallery-card:not(.add)").count(), 3);
  await shot("r2-04-gallery");
  await page.click(".db-tabs > .icon-btn");
  await page.click('.popover .menu-item:has-text("時間軸")');
  await page.waitForSelector(".tl-bar");
  assert.equal(await page.locator(".tl-bar").count(), 3);
  // dragging a bar two days to the right moves its date
  const bar = page.locator(".tl-bar").first();
  const title0 = await bar.getAttribute("title");
  const b = await bar.boundingBox();
  await page.mouse.move(b.x + 10, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 10 + 68, b.y + 10, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((t) => document.querySelector(".tl-bar").getAttribute("title") !== t, title0);
  assert.equal(await page.locator(".peek").count(), 0, "dragging must not open the row");
  await shot("r2-05-timeline");
});

await step("@mention creates a backlink", async () => {
  await page.keyboard.press("Alt+n");
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await page.fill(".page-title", "提及來源");
  await page.keyboard.press("Enter");
  await page.keyboard.type("參考 @歡迎");
  await page.waitForSelector(".bn-suggestion-menu >> text=歡迎使用");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".bn-editor .mention >> text=歡迎使用");
  await page.waitForTimeout(700);
  await page.click(".bn-editor .mention");
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "歡迎使用");
  await page.click(".backlinks");
  await page.waitForSelector(".popover .menu-item >> text=提及來源");
  await page.keyboard.press("Escape");
});

await step("template fills an empty page; outline appears", async () => {
  await page.keyboard.press("Alt+n");
  await page.waitForSelector(".templates");
  await page.click('.templates .btn:has-text("會議記錄")');
  await page.waitForSelector(".bn-editor >> text=討論重點");
  await page.waitForSelector(".outline");
  await page.waitForSelector(".templates", { state: "detached" });
  assert.match(await page.inputValue(".page-title"), /會議記錄/);
  await shot("r2-06-template");
});

await step("lock makes the page read-only", async () => {
  await page.click(".topbar button[title='頁面選單']");
  await page.click('.popover .menu-item:has-text("鎖定頁面")');
  await page.waitForSelector('.bn-editor[contenteditable="false"]');
  await page.click(".topbar >> text=已鎖定");
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
});

await step("version history restores earlier content", async () => {
  await page.click(".sidebar .tree-main >> text=歡迎使用");
  await page.waitForSelector(".bn-editor >> text=試著勾掉我");
  await page.click(".bn-editor >> text=試著勾掉我");
  await page.keyboard.press("End");
  await page.keyboard.type("-HISTORY-EDIT");
  await page.waitForTimeout(800);
  await page.click(".topbar button[title='頁面選單']");
  await page.click('.popover .menu-item:has-text("版本歷史")');
  await page.waitForSelector(".history-list .menu-item");
  await shot("r2-07-history");
  await page.click(".history-list .menu-item >> nth=-1");
  await page.click("button:has-text('還原這個版本')");
  await page.waitForSelector(".modal.history", { state: "detached" });
  await page.waitForFunction(() => !document.querySelector(".bn-editor").textContent.includes("-HISTORY-EDIT"));
});

await step("sidebar drag reorders top-level pages", async () => {
  const names = () => page.$$eval(".side-scroll > div > .tree-row .nav-label", (els) => els.map((e) => e.textContent));
  const before = await names();
  assert.ok(before.length >= 3, "need 3 root pages: " + before);
  const last = page.locator(".side-scroll > div > .tree-row").last();
  const first = page.locator(".side-scroll > div > .tree-row").first();
  await last.dragTo(first, { targetPosition: { x: 60, y: 3 } });
  await page.waitForFunction((n) => document.querySelector(".side-scroll > div > .tree-row .nav-label").textContent === n, before.at(-1));
});

await step("trash shows an undo toast", async () => {
  await page.click(".sidebar .tree-main >> text=提及來源");
  await page.click(".topbar button[title='頁面選單']");
  await page.click('.popover .menu-item:has-text("移到垃圾桶")');
  await page.waitForSelector(".banner");
  await page.click(".toast button:has-text('復原')");
  await page.waitForSelector(".banner", { state: "detached" });
});

await step("markdown import becomes a page", async () => {
  const file = path.join(os.tmpdir(), "slate-import-test.md");
  fs.writeFileSync(file, "# 匯入的筆記\n\n## 第一節\n\n- 項目甲\n- 項目乙\n\n一段**粗體**文字。\n");
  await page.click(".nav-heading button[title='新增頁面或資料庫']");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('.popover .menu-item:has-text("匯入 Markdown")'),
  ]);
  await chooser.setFiles(file);
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "匯入的筆記");
  await page.waitForSelector(".bn-editor >> text=項目乙");
  fs.unlinkSync(file);
});

await step("dark mode screenshot of a database", async () => {
  await openDb();
  await page.click(".db-tab >> text=表格");
  await page.evaluate(() => {
    localStorage.setItem("theme", '"dark"');
  });
  await page.reload();
  await page.waitForSelector(".db-table tbody tr");
  await shot("r2-08-dark-table");
});

await step("auto-backup writes a dated file into the chosen folder", async () => {
  // Stand in for the OS folder picker with the browser's private file system:
  // same handle type, so the real write / prune code runs.
  await page.evaluate(() => {
    window.showDirectoryPicker = () => navigator.storage.getDirectory();
  });
  await page.click(".sidebar >> text=設定與備份");
  await page.click("button:has-text('選擇資料夾')");
  await page.waitForSelector(".status >> text=已開始自動備份");
  const file = await page.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    for await (const [name, handle] of dir.entries()) {
      if (/^slate-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
        const data = JSON.parse(await (await handle.getFile()).text());
        return { name, app: data.app, pages: data.pages.length, history: data.history.length };
      }
    }
    return null;
  });
  assert.ok(file, "backup file was not written");
  assert.equal(file.app, "slate-workspace");
  assert.ok(file.pages >= 5 && file.history >= 1, JSON.stringify(file));
  await page.click("button:has-text('立即備份')");
  await page.waitForSelector(".status >> text=已立即備份");
  await shot("r2-09-settings");
  await page.click(".modal-foot .btn");
});

await step("no console errors", async () => {
  assert.equal(errors.join(" || ").slice(0, 600), "");
});

if (errors.length) console.log(errors.join(" || ").slice(0, 1500));
await browser.close();
