// Takes the three phone screenshots shown on the download page (public/shots/*.jpg).
// Usage: npm run build && npm start, then: node e2e/shots.mjs [url]
import { chromium } from "playwright";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:5183/";
fs.mkdirSync("public/shots", { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-TW" });
await ctx.addInitScript(() => {
  localStorage.setItem("landing-done", "1");
  localStorage.setItem("install-dismissed", "1");
});
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `public/shots/${n}.jpg`, type: "jpeg", quality: 72 });

await page.goto(base);
await page.waitForSelector(".bn-editor");
await page.waitForTimeout(800);
await shot(1);

const dbId = await page.evaluate(
  () =>
    new Promise((res) => {
      const o = indexedDB.open("slate-workspace");
      o.onsuccess = () => {
        const q = o.result.transaction("pages").objectStore("pages").getAll();
        q.onsuccess = () => (o.result.close(), res(q.result.find((p) => p.title === "專案追蹤").id));
      };
    }),
);
await page.evaluate((id) => (location.hash = "/p/" + id), dbId);
await page.waitForSelector(".db-table, .board, table");
await page.waitForTimeout(800);
await shot(2);

await page.locator(".tabbar button", { hasText: "待辦" }).tap();
await page.waitForSelector(".task-row");
await page.waitForTimeout(600);
await shot(3);
await browser.close();
console.log("wrote public/shots/1.jpg, 2.jpg, 3.jpg");
