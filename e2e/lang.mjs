// The interface in Simplified Chinese: chosen by the device's language, changed in the settings,
// and never touching what the person wrote. Usage: node e2e/lang.mjs [url] [screenshot folder]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://localhost:5183/";
const shots = process.argv[3];
const browser = await chromium.launch({ channel: "msedge" });
const step = async (name, fn) => {
  await fn();
  console.log("ok   " + name);
};
const open = async (locale, opts = {}) => {
  const page = await (await browser.newContext({ locale, viewport: { width: 1200, height: 800 }, ...opts })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForSelector(".sidebar, .landing-download");
  return Object.assign(page, { errors });
};
const TRADITIONAL_ONLY = /[設與備檔資區頁匯蹤條臺體]/;

let cn;
await step("a device set to Simplified Chinese gets Simplified, down to the first page", async () => {
  cn = await open("zh-CN");
  await cn.waitForSelector(".sidebar");
  const text = await cn.locator("body").innerText();
  assert.match(text, /设置与备份/);
  assert.match(text, /欢迎使用/); // the pages made on first run are in the person's language
  assert.doesNotMatch(text, TRADITIONAL_ONLY);
  assert.equal(await cn.evaluate(() => document.documentElement.lang), "zh-Hans");
  assert.match(await cn.title(), /离线工作区/);
  if (shots) await cn.screenshot({ path: shots + "/lang-cn.png" });
});

await step("tasks, a database and the assistant read in Simplified too", async () => {
  await cn.goto(base + "#/tasks/inbox");
  await cn.waitForSelector("text=收件箱");
  assert.doesNotMatch(await cn.locator("body").innerText(), TRADITIONAL_ONLY);
  if (shots) await cn.screenshot({ path: shots + "/lang-cn-tasks.png" });
  const table = await cn.evaluate(async () => {
    const db = await new Promise((ok) => (indexedDB.open("slate-workspace").onsuccess = (e) => ok(e.target.result)));
    const pages = await new Promise((ok) => (db.transaction("pages").objectStore("pages").getAll().onsuccess = (e) => ok(e.target.result)));
    return pages.find((p) => p.kind === "database")?.id;
  });
  await cn.goto(base + "#/p/" + table);
  await cn.waitForSelector("text=项目追踪");
  await cn.waitForSelector("text=进行中");
  assert.doesNotMatch(await cn.locator("body").innerText(), TRADITIONAL_ONLY);
  if (shots) await cn.screenshot({ path: shots + "/lang-cn-table.png" });
});

await step("the settings change the language, and what the person wrote is left as written", async () => {
  await cn.evaluate(() => (location.hash = "#/home"));
  await cn.getByText("新页面").first().click();
  await cn.waitForSelector(".page-title");
  await cn.locator(".page-title").fill("繁體寫的筆記與檔案");
  await cn.waitForTimeout(600);
  await cn.getByText("设置与备份").first().click();
  await cn.waitForSelector(".settings");
  if (shots) await cn.screenshot({ path: shots + "/lang-cn-settings.png" });
  await Promise.all([cn.waitForEvent("load"), cn.locator(".settings").getByText("繁體中文").click()]);
  await cn.waitForSelector(".sidebar");
  const text = await cn.locator("body").innerText();
  assert.match(text, /設定與備份/);
  assert.match(text, /繁體寫的筆記與檔案/);
  assert.equal(await cn.evaluate(() => document.documentElement.lang), "zh-Hant");
  // and back: the choice is remembered over the device's language, the title is still as written
  await cn.getByText("設定與備份").first().click();
  await Promise.all([cn.waitForEvent("load"), cn.locator(".settings").getByText("简体中文").click()]);
  await cn.waitForSelector(".sidebar");
  const again = await cn.locator("body").innerText();
  assert.match(again, /设置与备份/);
  assert.match(again, /繁體寫的筆記與檔案/);
  assert.deepEqual(cn.errors, []);
});

await step("a device in Traditional Chinese, or in another language, sees what it always did", async () => {
  for (const locale of ["zh-TW", "zh-HK", "en-US"]) {
    const page = await open(locale);
    assert.match(await page.locator("body").innerText(), /設定與備份/, locale);
    assert.deepEqual(page.errors, [], locale);
    await page.context().close();
  }
});

await step("the download page offers the other script, in that script", async () => {
  const phone = await open("zh-TW", {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await phone.waitForSelector(".landing-download");
  assert.match(await phone.locator("body").innerText(), /下載 Slate/);
  await Promise.all([phone.waitForEvent("load"), phone.locator(".landing-lang").tap()]);
  await phone.waitForSelector(".landing-download");
  const text = await phone.locator("body").innerText();
  assert.match(text, /下载 Slate/);
  assert.match(text, /繁體/);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "page scrolls sideways");
  if (shots) await phone.screenshot({ path: shots + "/lang-cn-landing.png" });
  await phone.locator(".landing-download").tap();
  await phone.waitForSelector(".get");
  if (shots) await phone.screenshot({ path: shots + "/lang-cn-detail.png", fullPage: true });
});

await browser.close();
console.log("all good");
