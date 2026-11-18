import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-tw";
import "dayjs/locale/zh-cn";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { db } from "./db";
import { startLink } from "./lib/link";
import { followPairLink, startBridge } from "./lib/ai/bridge";
import { simplified } from "./lib/lang";
import "./styles.css";
import "./styles-extra.css";
import "./styles-mobile.css";

dayjs.locale(simplified ? "zh-cn" : "zh-tw");
registerSW({
  immediate: true,
  // a tab can stay open for days: look for a new version every hour (the page reloads itself when one arrives)
  onRegisteredSW(_url, registration) {
    if (registration) setInterval(() => void registration.update().catch(() => undefined), 60 * 60_000);
  },
});

// reconnect to the devices this one is linked with, if any
void startLink(db);
// listen for Claude on this computer, if the person switched that on
followPairLink(); // arriving from the link Claude gave: pair first
startBridge();
// the same link opened in a tab that already shows Slate changes only the address
window.addEventListener("hashchange", () => void followPairLink());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
