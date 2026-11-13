// Quick check of a published copy: two browsers link through the real public meeting point
// and one receives the other's page. Usage: node e2e/live.mjs [url]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "https://earningpershare.github.io/slate/";
const browser = await chromium.launch({ channel: "msedge" });
const errors = [];
const open = async (name) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW" })).newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (e) => errors.push(name + ": " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(name + " console: " + m.text()));
  await page.goto(base);
  await page.waitForSelector(".page-title");
  return page;
};
const titles = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const o = indexedDB.open("slate-workspace");
        o.onsuccess = () => {
          const q = o.result.transaction("pages").objectStore("pages").getAll();
          q.onsuccess = () => (o.result.close(), res(q.result.map((p) => p.title)));
        };
      }),
  );

const a = await open("a");
const b = await open("b");
console.log("ok   the published app loads at " + base);
await a.keyboard.press("Alt+n");
await a.waitForFunction(() => document.querySelector(".page-title")?.value === "");
await a.fill(".page-title", "live check");
await a.waitForTimeout(800);

await a.locator(".sidebar .nav-row", { hasText: "設定" }).click();
await a.locator(".link .btn.primary", { hasText: "顯示連結碼" }).click();
await a.waitForSelector(".link-code");
const code = (await a.locator(".link-code").innerText()).trim();
console.log("ok   got a link code from the public meeting point");

await b.locator(".sidebar .nav-row", { hasText: "設定" }).click();
await b.locator(".link .btn", { hasText: "輸入連結碼" }).click();
await b.fill(".link-input", code);
await b.locator(".link .btn.primary").click();
await b.waitForSelector(".link-devices .link-dot.on", { timeout: 60_000 });
console.log("ok   the two devices are linked and connected");
for (let i = 0; i < 80 && !(await titles(b)).includes("live check"); i++) await b.waitForTimeout(250);
assert.ok((await titles(b)).includes("live check"), "the page did not arrive");
console.log("ok   the page written on one arrived on the other");

const sw = await a.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
const manifest = await a.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).ok);
assert.ok(sw && manifest, "not installable");
console.log("ok   installable (service worker and manifest present)");
// the first visit downloads the app for offline use in the background: wait for that
await a.evaluate(() => navigator.serviceWorker.ready);
await a.waitForFunction(async () => (await caches.keys()).length > 0 && !!navigator.serviceWorker.controller, null, { timeout: 60_000 });
await a.waitForTimeout(3000);
await a.context().setOffline(true);
await a.reload();
await a.waitForSelector(".page-title, .home");
console.log("ok   opens with the network off");
assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|WebSocket/.test(e)), []);
console.log("ok   no errors");
await browser.close();
