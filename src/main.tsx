import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-tw";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";
import "./styles-extra.css";

dayjs.locale("zh-tw");
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
