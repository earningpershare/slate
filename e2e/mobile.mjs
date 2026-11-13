// Phone-size end-to-end test (touch, 390x844). Usage: node e2e/mobile.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://localhost:5183";
const shots = process.argv[3];
const browser = await chromium.launch({ channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "zh-TW",
});
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
/** nothing may be wider than the screen, or the whole page scrolls sideways */
const fits = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
const tab = (label) => page.locator(".tabbar button", { hasText: label });

// An existing workspace from before change tracking (database version 3) must open and keep its data.
await step("older data is upgraded in place", async () => {
  await page.goto(base + "/icon.svg");
  await page.evaluate(
    () =>
      new Promise((res, rej) => {
        const open = indexedDB.open("slate-workspace", 30);
        open.onupgradeneeded = () => {
          const d = open.result;
          const pages = d.createObjectStore("pages", { keyPath: "id" });
          pages.createIndex("parentId", "parentId");
          pages.createIndex("updatedAt", "updatedAt");
          const tasks = d.createObjectStore("tasks", { keyPath: "id" });
          for (const i of ["listId", "parentId", "due"]) tasks.createIndex(i, i);
          d.createObjectStore("lists", { keyPath: "id" });
          const focus = d.createObjectStore("focus", { keyPath: "id" });
          for (const i of ["taskId", "start"]) focus.createIndex(i, i);
          d.createObjectStore("habits", { keyPath: "id" });
          d.createObjectStore("files", { keyPath: "id" });
          const history = d.createObjectStore("history", { keyPath: "id" });
          for (const i of ["pageId", "at"]) history.createIndex(i, i);
          d.createObjectStore("meta", { keyPath: "key" });
          pages.add({ id: "old1", parentId: "", kind: "page", title: "舊資料頁", createdAt: 5, updatedAt: 5, sort: 1 });
          tasks.add({ id: "oldt", title: "舊任務", listId: null, done: false, priority: 0, sort: 1, createdAt: 5 });
        };
        open.onsuccess = () => (open.result.close(), res());
        open.onerror = () => rej(open.error);
      }),
  );
  errors.length = 0; // the bare icon document above asks for a favicon that does not exist
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "舊資料頁");
  const row = await page.evaluate(
    () =>
      new Promise((res) => {
        const open = indexedDB.open("slate-workspace");
        open.onsuccess = () => {
          const d = open.result;
          const q = d.transaction("pages").objectStore("pages").get("old1");
          q.onsuccess = () => (d.close(), res({ row: q.result, stores: [...d.objectStoreNames] }));
        };
      }),
  );
  assert.equal(row.row.title, "舊資料頁");
  assert.equal(row.row.dirty, 1);
  assert.ok(row.row.rev > 5);
  assert.ok(row.stores.includes("tombs"));
});

await step("opens without the sidebar covering the page", async () => {
  await page.waitForSelector(".bn-editor");
  assert.equal(await page.locator(".sidebar").count(), 0);
  assert.equal(await page.locator(".tabbar button").count(), 5);
  await fits();
});

await step("drawer opens from the bottom bar and closes after picking a page", async () => {
  await tab("頁面").tap();
  await page.waitForSelector(".sidebar");
  await page.waitForSelector(".scrim");
  await shot("m-01-drawer");
  // row actions are reachable without hover
  assert.ok(await page.locator(".tree-row .tree-actions").first().isVisible());
  await page.locator(".tree-main", { hasText: "舊資料頁" }).tap(); // the page already open
  await page.waitForSelector(".sidebar", { state: "detached" });
  await tab("頁面").tap();
  await page.waitForSelector(".sidebar");
  await page.locator(".scrim").tap({ position: { x: 370, y: 300 } });
  await page.waitForSelector(".sidebar", { state: "detached" });
});

await step("new page from the bottom bar, typed with the on-screen flow", async () => {
  await page.locator(".tabbar .tab-new").tap();
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "");
  await page.fill(".page-title", "手機筆記");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/待辦");
  await page.waitForSelector(".bn-suggestion-menu");
  await shot("m-02-slash");
  await page.keyboard.press("Enter");
  await page.keyboard.type("買牛奶");
  await page.waitForTimeout(700);
  await fits();
  await shot("m-03-page");
  await page.reload();
  await page.waitForSelector(".bn-editor >> text=買牛奶");
  await page.locator('.bn-editor input[type="checkbox"]').first().tap();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.bn-editor input[type="checkbox"]').first().isChecked(), true);
});

await step("page menu is a bottom sheet", async () => {
  await page.locator('.topbar [title="頁面選單"]').tap();
  await page.waitForTimeout(350); // slide-in animation
  const box = await page.locator(".popover").boundingBox();
  assert.equal(Math.round(box.x), 0);
  assert.equal(Math.round(box.width), 390);
  assert.ok(Math.abs(box.y + box.height - (844 - 0)) <= 1, JSON.stringify(box));
  await shot("m-04-sheet");
  await page.locator(".popover .menu-item", { hasText: "鎖定" }).tap();
  await page.waitForSelector(".topbar >> text=已鎖定");
  await page.locator(".topbar >> text=已鎖定").tap();
});

await step("search from the bottom bar", async () => {
  await tab("搜尋").tap();
  await page.fill(".search-input", "買牛");
  await page.locator(".search-row", { hasText: "手機筆記" }).tap();
  await page.waitForFunction(() => document.querySelector(".page-title")?.value === "手機筆記");
});

await step("tasks: chips, add, detail sheet, complete", async () => {
  await tab("待辦").tap();
  await page.waitForSelector(".tasks-nav");
  const nav = await page.locator(".tasks-nav").boundingBox();
  assert.ok(nav.height < 70, "list strip should be one row, got " + nav.height);
  await page.fill(".quick-add input", "手機新增的任務 !3");
  await page.keyboard.press("Enter");
  await page.locator(".task-row", { hasText: "手機新增的任務" }).locator(".task-title").tap();
  await page.waitForSelector(".task-detail");
  const d = await page.locator(".task-detail").boundingBox();
  assert.equal(Math.round(d.width), 390);
  await shot("m-05-task-detail");
  await page.locator(".task-detail .detail-head .icon-btn").last().tap();
  await page.waitForSelector(".task-detail", { state: "detached" });
  await page.locator(".task-row", { hasText: "手機新增的任務" }).locator(".task-check").tap();
  await page.waitForSelector(".task-row >> text=手機新增的任務", { state: "detached" });
  await fits();
  for (const chip of ["月曆", "四象限", "番茄鐘", "習慣打卡"]) {
    await page.locator(".tasks-nav .nav-row", { hasText: chip }).tap();
    await page.waitForTimeout(250);
    await fits();
    const main = page.locator(".tasks-main");
    assert.ok(
      await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      chip + " overflows sideways",
    );
  }
  await shot("m-06-habits");
});

await step("database: toolbar on one line, table scrolls sideways, row opens full screen", async () => {
  await tab("頁面").tap();
  await page.locator(".sidebar .nav-heading .icon-btn").tap();
  await page.locator(".popover .menu-item", { hasText: "資料庫" }).tap();
  await page.waitForSelector(".db-table");
  await page.fill(".page-title", "手機資料庫");
  await page.locator(".add-row").tap();
  await page.waitForFunction(() => !!document.activeElement?.closest(".db-table tbody tr"));
  await page.keyboard.type("第一筆");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await fits();
  const wrap = page.locator(".table-wrap");
  assert.ok(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth), "table should be wider than the screen");
  await wrap.evaluate((el) => (el.scrollLeft = 200));
  assert.ok((await wrap.evaluate((el) => el.scrollLeft)) > 100);
  await wrap.evaluate((el) => (el.scrollLeft = 0));
  const tools = await page.locator(".db-tools").boundingBox();
  assert.ok(tools.height < 50, "toolbar should be one row, got " + tools.height);
  await shot("m-07-table");
  await page.locator(".db-table .open-btn").first().tap();
  await page.waitForSelector(".peek .page-title");
  assert.equal(Math.round((await page.locator(".peek").boundingBox()).width), 390);
  // a select cell opens as a sheet and sets the value
  await page.locator(".peek .row-prop .cell-select").first().tap();
  await page.locator(".popover .select-pick", { hasText: "進行中" }).tap();
  await page.waitForSelector(".peek .row-prop .tag >> text=進行中");
  await shot("m-08-row");
  await page.locator(".peek .topbar .icon-btn").first().tap();
  await page.waitForSelector(".peek", { state: "detached" });
  // board view
  await page.locator(".db-tabs .icon-btn").last().tap();
  await page.locator(".popover .menu-item", { hasText: "看板" }).tap();
  await page.waitForSelector(".board-col");
  await fits();
  await shot("m-09-board");
});

await step("settings sheet shows the sync section", async () => {
  await tab("頁面").tap();
  await page.locator(".sidebar .nav-row", { hasText: "設定" }).tap();
  await page.waitForSelector(".modal.settings >> text=跨裝置同步");
  await page.waitForSelector(".modal.settings >> text=顯示連結碼");
  await shot("m-10-settings");
  await page.locator(".modal .btn", { hasText: "完成" }).tap();
});

await step("home fits", async () => {
  await tab("首頁").tap();
  await page.waitForSelector(".home");
  await fits();
  await shot("m-11-home");
});

await step("no console errors", async () => {
  assert.equal(errors.join(" || "), "");
});

if (errors.length) console.log(errors.join(" || ").slice(0, 1500));
await browser.close();
