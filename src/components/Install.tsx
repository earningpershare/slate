// Getting Slate onto the device with as few steps as the platform allows:
//   Windows / Android / desktop Chrome and Edge   one button (the browser's own install prompt)
//   iPhone / iPad                                 a configuration profile that puts Slate on the
//                                                 home screen (public/slate.mobileconfig)
import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronLeft, Download, RefreshCw, Share, Smartphone, X } from "lucide-react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// the browser offers its prompt once, possibly before anything is on screen: keep hold of it
let offer: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  offer = e as InstallPrompt;
  changed();
});
window.addEventListener("appinstalled", () => {
  offer = null;
  changed();
});

const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const isApple = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** another real browser on iPhone (Chrome, Edge, Firefox...): no profiles, but it can add to the home screen */
const isOtherBrowser = () => /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Brave/.test(navigator.userAgent);
/** a window inside another app (Messenger, LINE, Instagram...): it can install nothing */
const isInApp = () => /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|KAKAOTALK/.test(navigator.userAgent) || !/Safari\//.test(navigator.userAgent);

type Way = "prompt" | "profile" | "ios-share" | "open-safari" | null;
function useInstallWay(): Way {
  const prompt = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => offer,
  );
  if (standalone()) return null;
  if (prompt) return "prompt";
  if (isApple()) return isOtherBrowser() ? "ios-share" : isInApp() ? "open-safari" : "profile";
  return null;
}

const PROFILE = "slate.mobileconfig";

function InstallAction({ way, onDone }: { way: Exclude<Way, null>; onDone?: () => void }) {
  if (way === "prompt") {
    return (
      <button
        className="btn primary"
        onClick={async () => {
          const o = offer;
          if (!o) return;
          await o.prompt();
          if ((await o.userChoice).outcome === "accepted") onDone?.();
        }}
      >
        <Download size={15} /> 安裝
      </button>
    );
  }
  // on an iPhone the download page explains the steps for the browser at hand
  return (
    <a className="btn primary" href="?get">
      <Download size={15} /> 安裝
    </a>
  );
}

const HINT: Record<Exclude<Way, null>, string> = {
  prompt: "把 Slate 安裝到這台裝置，之後不連網也能開。",
  profile: "把 Slate 裝到主畫面，之後不連網也能開。",
  "ios-share": "把 Slate 裝到主畫面，之後不連網也能開。",
  "open-safari": "把 Slate 裝到主畫面，之後不連網也能開。",
};

/** A bar offered once to people using Slate in a browser tab. */
export function InstallBar() {
  const way = useInstallWay();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("install-dismissed") === "1";
    } catch {
      return false;
    }
  });
  // not in the way of the very first look at the app
  const [due, setDue] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDue(true), 2500);
    return () => clearTimeout(t);
  }, []);
  if (!way || hidden || !due) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem("install-dismissed", "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="install-bar" role="region" aria-label="安裝 Slate">
      <span className="install-text">{HINT[way]}</span>
      <InstallAction way={way} onDone={dismiss} />
      <button className="btn ghost" aria-label="關閉" onClick={dismiss}>
        <X size={16} />
      </button>
    </div>
  );
}

/** The same offer, always available in the settings. */
export function InstallSection() {
  const way = useInstallWay();
  if (standalone()) return <p className="muted">已經安裝在這台裝置上了。</p>;
  if (!way) {
    return <p className="muted">在 Chrome 或 Edge 的網址列右邊按「安裝」圖示；iPhone 請用 Safari 開啟這個網址。</p>;
  }
  return (
    <div className="row wrap">
      <p className="muted" style={{ flex: 1, margin: 0, minWidth: 200 }}>
        {HINT[way]}
      </p>
      <InstallAction way={way} />
    </div>
  );
}

// ---------- the download page ----------

const isPhone = () => isApple() || /Android/.test(navigator.userAgent);

/**
 * Whether a visitor should land on the download page instead of the app: someone on a phone
 * who has not installed Slate and has not chosen to use it in the browser. "?get" in the
 * address shows the page on any device.
 */
export function wantsLanding(): boolean {
  if (standalone()) return false;
  if (location.hash.startsWith("#/pair/")) return false; // on the way to connect Claude, not to install
  if (new URLSearchParams(location.search).has("get")) return true;
  try {
    if (localStorage.getItem("landing-done") === "1") return false;
  } catch {
    return false;
  }
  return isPhone();
}

/** true once the service worker can hand out the profile with the type iOS expects */
function useProfileReady(): boolean {
  const [ready, setReady] = useState(() => !("serviceWorker" in navigator) || !!navigator.serviceWorker.controller);
  useEffect(() => {
    if (ready) return;
    const on = () => setReady(true);
    navigator.serviceWorker.addEventListener("controllerchange", on);
    const t = setTimeout(on, 12_000); // never leave the button dead
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", on);
      clearTimeout(t);
    };
  }, [ready]);
  return ready;
}

export function Landing({ onContinue }: { onContinue: () => void }) {
  const way = useInstallWay();
  const ready = useProfileReady();
  const [view, setView] = useState<"home" | "detail">("home");
  const [started, setStarted] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = location.origin + location.pathname;
  const android = /Android/.test(navigator.userAgent);

  const useInBrowser = () => {
    try {
      localStorage.setItem("landing-done", "1");
    } catch {
      /* ignore */
    }
    if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    onContinue();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      prompt("請複製這個網址，貼到 Safari：", address);
    }
  };

  // ---- first screen: one big button and what happens next ----
  if (view === "home") {
    return (
      <div className="landing">
        <header className="landing-top">
          <img src="icon-192.png" alt="" width={34} height={34} />
          <b>Slate</b>
          <button className="landing-top-get" onClick={() => setView("detail")}>
            下載
          </button>
        </header>
        <section className="landing-hero">
          <h1>
            下載 Slate
            <br />
            一分鐘開始用
          </h1>
          <p>離線的筆記、資料庫與待辦。不用註冊，資料只在你的裝置上。</p>
          <button className="landing-download" onClick={() => setView("detail")}>
            下載 <Download size={22} />
          </button>
        </section>
        <ol className="landing-flow">
          <li>
            <span className="landing-flow-icon">
              <Download size={22} />
            </span>
            <div>
              <small>步驟 1</small>
              下載並安裝
            </div>
          </li>
          <li>
            <span className="landing-flow-icon">
              <Smartphone size={22} />
            </span>
            <div>
              <small>步驟 2</small>
              從主畫面打開 Slate
            </div>
          </li>
          <li>
            <span className="landing-flow-icon">
              <RefreshCw size={22} />
            </span>
            <div>
              <small>步驟 3</small>
              用連結碼和電腦同步
            </div>
          </li>
        </ol>
        <button className="btn ghost landing-skip" onClick={useInBrowser}>
          不安裝，直接在瀏覽器裡用
        </button>
      </div>
    );
  }

  // ---- second screen: the app's own page, with the button that actually installs ----
  const getButton =
    way === "profile" ? (
      ready ? (
        <a className="get-btn" href={PROFILE} onClick={() => setStarted(true)}>
          取得
        </a>
      ) : (
        <button className="get-btn" disabled>
          準備中
        </button>
      )
    ) : way === "prompt" ? (
      <button
        className="get-btn"
        onClick={async () => {
          const o = offer;
          if (!o) return;
          await o.prompt();
          if ((await o.userChoice).outcome === "accepted") useInBrowser();
        }}
      >
        取得
      </button>
    ) : way === "open-safari" || way === "ios-share" ? (
      <a className="get-btn" href={"x-safari-" + address}>
        用 Safari 開啟
      </a>
    ) : (
      <button className="get-btn" onClick={() => setStarted(true)}>
        取得
      </button>
    );

  return (
    <div className="landing get">
      <nav className="get-nav">
        <button onClick={() => setView("home")} aria-label="返回">
          <ChevronLeft size={22} /> 返回
        </button>
      </nav>

      <header className="get-head">
        <img src="icon-512.png" alt="" width={118} height={118} />
        <div className="get-head-text">
          <h1>Slate</h1>
          <p>離線筆記・資料庫・待辦</p>
          <div className="get-head-action">
            {getButton}
            <small>免費・不需帳號</small>
          </div>
        </div>
      </header>

      {way === "open-safari" && (
        <div className="get-panel warn">
          <b>這個視窗（Messenger、LINE、IG 等內建瀏覽器）不能安裝。</b>
          <span>按上面的「用 Safari 開啟」；如果沒有反應，複製網址後自己到 Safari 貼上。</span>
          <button className="btn" onClick={() => void copy()}>
            {copied ? "已複製，請到 Safari 貼上" : "複製網址"}
          </button>
        </div>
      )}

      {way === "ios-share" && (
        <div className="get-panel">
          <b>你現在用的不是 Safari（是 Chrome、Edge 這類瀏覽器）</b>
          <span>兩種裝法擇一：</span>
          <ol>
            <li>按上面的「用 Safari 開啟」，到 Safari 後再按一次「取得」。</li>
            <li>
              或直接在這裡裝：按網址列旁的分享鈕 <Share size={15} style={{ verticalAlign: "-2px" }} />，往下找「加入主畫面」，再按「加入」。
            </li>
          </ol>
          <span>Safari 的圖示是藍色指南針，網址列在畫面最下方。</span>
        </div>
      )}

      {way === "profile" && started && (
        <div className="get-panel">
          <b>再三步就完成</b>
          <ol>
            <li>在跳出的視窗按「允許」，再按「關閉」。</li>
            <li>打開「設定」App，點最上方的「已下載描述檔」。</li>
            <li>按右上角「安裝」，輸入手機密碼，再按兩次「安裝」。</li>
          </ol>
          <span>完成後主畫面會出現 Slate 圖示。安裝畫面顯示「未簽署」是正常的：描述檔只會加一個圖示。</span>
        </div>
      )}

      {way === null && started && (
        <div className="get-panel">
          <b>{android ? "用 Chrome 安裝" : "用瀏覽器安裝"}</b>
          <span>
            {android
              ? "按 Chrome 右上角選單 →「安裝應用程式」（或「加到主畫面」）。"
              : "在 Chrome 或 Edge 的網址列右邊按「安裝」圖示。"}
          </span>
        </div>
      )}

      <ul className="get-facts">
        <li>
          <small>價格</small>
          <b>免費</b>
          <span>沒有內購</span>
        </li>
        <li>
          <small>帳號</small>
          <b>不需要</b>
          <span>打開就能用</span>
        </li>
        <li>
          <small>大小</small>
          <b>5</b>
          <span>MB</span>
        </li>
        <li>
          <small>語言</small>
          <b>中文</b>
          <span>繁體</span>
        </li>
        <li>
          <small>原始碼</small>
          <b>公開</b>
          <span>GPL-3.0</span>
        </li>
      </ul>

      <section className="get-section">
        <h2>預覽</h2>
        <div className="get-shots">
          {[1, 2, 3].map((n) => (
            <img key={n} src={`shots/${n}.jpg`} alt="" loading="lazy" width={230} height={498} />
          ))}
        </div>
      </section>

      <section className="get-section">
        <h2>簡介</h2>
        <p>
          Slate 是一個離線的工作區：寫筆記、用表格和看板整理資料、管理待辦事項，全部在同一個地方。資料只存在你自己的裝置上，沒有帳號、沒有雲端；
          要讓手機和電腦同步時，輸入一組連結碼，兩台裝置就會加密後直接互相傳送。
        </p>
        <ul>
          <li>筆記：標題、清單、表格、圖片、多欄排版、頁面互相連結</li>
          <li>資料庫：表格、看板、月曆、篩選與排序、公式</li>
          <li>待辦：今天與最近 7 天、重複任務、番茄鐘、習慣打卡</li>
          <li>不連網也能用，裝置之間用連結碼同步</li>
        </ul>
      </section>

      <section className="get-section">
        <h2>資訊</h2>
        <dl className="get-info">
          <div>
            <dt>提供者</dt>
            <dd>Slate 開源專案</dd>
          </div>
          <div>
            <dt>可用於</dt>
            <dd>iPhone、iPad、Android、電腦</dd>
          </div>
          <div>
            <dt>隱私</dt>
            <dd>不收集任何資料</dd>
          </div>
          <div>
            <dt>原始碼</dt>
            <dd>
              <a href="https://github.com/earningpershare/slate" target="_blank" rel="noreferrer">
                GitHub
              </a>
            </dd>
          </div>
        </dl>
        <p className="get-fine">
          Slate 是從這個網站直接安裝的網頁應用程式，不是透過 App Store 或 Google Play 發行，也沒有經過它們審查。
        </p>
      </section>

      <button className="btn ghost landing-skip" onClick={useInBrowser}>
        不安裝，直接在瀏覽器裡用
      </button>
    </div>
  );
}
