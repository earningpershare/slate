// Getting Slate onto the device with as few steps as the platform allows:
//   Windows / Android / desktop Chrome and Edge   one button (the browser's own install prompt)
//   iPhone / iPad                                 a configuration profile that puts Slate on the
//                                                 home screen (public/slate.mobileconfig)
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, X } from "lucide-react";

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
/** on iPhone only Safari can install a profile */
const isSafari = () => !/CriOS|FxiOS|EdgiOS|OPiOS|Line\/|FBAN|FBAV|Instagram/.test(navigator.userAgent);

type Way = "prompt" | "profile" | "open-safari" | null;
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
  if (isApple()) return isSafari() ? "profile" : "open-safari";
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
  if (way === "profile") {
    return (
      <a className="btn primary" href={PROFILE}>
        <Download size={15} /> 下載描述檔
      </a>
    );
  }
  return null;
}

const HINT: Record<Exclude<Way, null>, string> = {
  prompt: "把 Slate 安裝到這台裝置，之後不連網也能開。",
  profile: "安裝到 iPhone：下載描述檔 → 打開「設定」→ 最上方「已下載描述檔」→「安裝」。完成後主畫面就會有 Slate。",
  "open-safari": "要安裝到 iPhone，請改用 Safari 開啟這個網址。",
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
  const [started, setStarted] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = location.origin + location.pathname;
  const useInBrowser = () => {
    try {
      localStorage.setItem("landing-done", "1");
    } catch {
      /* ignore */
    }
    if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    onContinue();
  };

  return (
    <div className="landing">
      <div className="landing-card">
        <img className="landing-icon" src="icon-192.png" alt="" width={96} height={96} />
        <h1>Slate</h1>
        <p className="landing-tag">離線的筆記、資料庫與待辦。不用註冊，資料只在你的裝置上。</p>

        {way === "profile" && (
          <>
            {ready ? (
              <a className="btn primary landing-main" href={PROFILE} onClick={() => setStarted(true)}>
                <Download size={18} /> 下載安裝（iPhone／iPad）
              </a>
            ) : (
              <button className="btn primary landing-main" disabled>
                準備中…
              </button>
            )}
            <ol className={"landing-steps" + (started ? " on" : "")}>
              <li>在跳出的視窗按「允許」，再按「關閉」。</li>
              <li>打開「設定」App，點最上方的「已下載描述檔」。</li>
              <li>按右上角「安裝」，輸入手機密碼，再按兩次「安裝」。</li>
              <li>回到主畫面，點 Slate 圖示就能開始用，之後不連網也能開。</li>
            </ol>
            <p className="landing-note">描述檔只會在主畫面加一個圖示。因為沒有付費簽署，安裝畫面會顯示「未簽署」。</p>
          </>
        )}

        {way === "open-safari" && (
          <>
            <p className="landing-warn">這個瀏覽器不能安裝。請複製網址，改用 Safari 開啟。</p>
            <button
              className="btn primary landing-main"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(address);
                  setCopied(true);
                } catch {
                  prompt("請複製這個網址，貼到 Safari：", address);
                }
              }}
            >
              {copied ? "已複製，請到 Safari 貼上" : "複製網址"}
            </button>
          </>
        )}

        {way === "prompt" && (
          <button
            className="btn primary landing-main"
            onClick={async () => {
              const o = offer;
              if (!o) return;
              await o.prompt();
              if ((await o.userChoice).outcome === "accepted") useInBrowser();
            }}
          >
            <Download size={18} /> 下載安裝
          </button>
        )}

        {way === null && (
          <p className="landing-note">
            {/Android/.test(navigator.userAgent)
              ? "請用 Chrome 開啟，按右上角選單 →「安裝應用程式」（或「加到主畫面」）。"
              : "在 Chrome 或 Edge 的網址列右邊按「安裝」圖示；iPhone 請用 Safari 開啟這個網址。"}
          </p>
        )}

        <button className="btn ghost landing-skip" onClick={useInBrowser}>
          不安裝，直接在瀏覽器裡用
        </button>
      </div>
    </div>
  );
}
