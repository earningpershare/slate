import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-tw";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { db } from "./db";
import { startLink } from "./lib/link";
import "./styles.css";
import "./styles-extra.css";
import "./styles-mobile.css";

dayjs.locale("zh-tw");
registerSW({ immediate: true });

// reconnect to the devices this one is linked with, if any
void startLink(db);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
