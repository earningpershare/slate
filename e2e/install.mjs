// The install offer: an iPhone gets the configuration profile, other browsers get nothing
// until they offer their own install prompt. Usage: node e2e/install.mjs [url]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://localhost:5183/";
const browser = await chromium.launch({ channel: "msedge" });
const open = async (opts) => {
  const page = await (await browser.newContext({ locale: "zh-TW", ...opts })).newPage();
  await page.goto(base);
  return page;
};

const iphone = await open({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
});
// a phone lands on the download page, with the button waiting until the profile can be served properly
await iphone.waitForSelector(".landing-download");
if (process.argv[3]) await iphone.screenshot({ path: process.argv[3] + "/landing-home.png" });
await iphone.locator(".landing-download").tap();
// the app's own page: the button there is the profile itself
await iphone.waitForSelector(".get a.get-btn", { timeout: 60_000 });
const href = await iphone.locator(".get a.get-btn").getAttribute("href");
const broken = await iphone.evaluate(async () => {
  const imgs = [...document.querySelectorAll(".get img")];
  await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
  return imgs.filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src"));
});
assert.deepEqual(broken, [], "pictures missing on the app page");
assert.equal(await iphone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "page scrolls sideways");
assert.equal(href, "slate.mobileconfig");
assert.equal(await iphone.locator(".page-title").count(), 0);
if (process.argv[3]) await iphone.screenshot({ path: process.argv[3] + "/landing-detail.png", fullPage: false });
console.log("ok   iPhone Safari lands on the download page");

// once the app's service worker is in charge, the profile arrives with Apple's content type
// (a plain static host would send it as a generic download)
await iphone.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60_000 });
const got = await iphone.evaluate(async (href) => {
  const res = await fetch(href);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}, href);
assert.equal(got.status, 200);
assert.equal(got.type, "application/x-apple-aspen-config");
assert.match(got.body, /com\.apple\.webClip\.managed/);
assert.ok(!got.body.includes("<html"), "the profile address returned the app page");
console.log("ok   the profile is served as " + got.type);

await iphone.locator(".landing-skip").tap();
await iphone.waitForSelector(".page-title");
await iphone.reload();
await iphone.waitForSelector(".page-title");
assert.equal(await iphone.locator(".landing").count(), 0);
console.log("ok   choosing the browser instead is remembered");
// the smaller offer is still there, above the bottom navigation and not on top of it
await iphone.waitForSelector(".install-bar");
const bar = await iphone.locator(".install-bar").boundingBox();
const tabs = await iphone.locator(".tabbar").boundingBox();
assert.ok(bar.y + bar.height <= tabs.y, "install bar covers the tab bar");

const chromeIos = await open({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
});
// inside Messenger, LINE, Chrome...: the button hands the address over to Safari
await chromeIos.locator(".landing-download").click();
await chromeIos.waitForSelector(".get-panel.warn");
assert.match(await chromeIos.locator(".get a.get-btn").getAttribute("href"), /^x-safari-https?:\/\//);
if (process.argv[3]) await chromeIos.screenshot({ path: process.argv[3] + "/landing-inapp.png" });

const desktop = await open({ viewport: { width: 1280, height: 800 } });
await desktop.waitForSelector(".page-title"); // a computer goes straight to the app
await desktop.goto(base + "?get");
await desktop.waitForSelector(".landing");
if (process.argv[3]) await desktop.screenshot({ path: process.argv[3] + "/landing-desktop.png" });
console.log("ok   computers go straight to the app; ?get shows the download page");
console.log("ok   other iPhone browsers are pointed to Safari");
await browser.close();
