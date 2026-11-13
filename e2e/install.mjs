// The install offer: an iPhone gets the configuration profile, other browsers get nothing
// until they offer their own install prompt. Usage: node e2e/install.mjs [url]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://localhost:5183/";
const browser = await chromium.launch({ channel: "msedge" });
const open = async (opts) => {
  const page = await (await browser.newContext({ locale: "zh-TW", ...opts })).newPage();
  await page.goto(base);
  await page.waitForSelector(".page-title");
  return page;
};

const iphone = await open({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
});
await iphone.waitForSelector(".install-bar");
const href = await iphone.locator(".install-bar a.btn").getAttribute("href");
assert.equal(href, "slate.mobileconfig");
// the bar sits above the bottom navigation, not on top of it
const bar = await iphone.locator(".install-bar").boundingBox();
const tabs = await iphone.locator(".tabbar").boundingBox();
assert.ok(bar.y + bar.height <= tabs.y, "install bar covers the tab bar");
console.log("ok   iPhone Safari is offered the profile");

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

await iphone.locator('.install-bar [aria-label="關閉"]').tap();
await iphone.reload();
await iphone.waitForSelector(".page-title");
await iphone.waitForTimeout(3200);
assert.equal(await iphone.locator(".install-bar").count(), 0);
console.log("ok   dismissing it is remembered");

const chromeIos = await open({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
});
await chromeIos.waitForSelector(".install-bar >> text=請改用 Safari");
console.log("ok   other iPhone browsers are pointed to Safari");
await browser.close();
