import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-tw";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { db } from "./db";
import { start } from "./lib/account";
import "./styles.css";
import "./styles-extra.css";
import "./styles-mobile.css";

dayjs.locale("zh-tw");
registerSW({ immediate: true });

// who is signed in (if this address offers accounts at all) is known before the first render
void start(db).then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
