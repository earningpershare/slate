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
