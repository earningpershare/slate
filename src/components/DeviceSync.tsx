import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { beginPairing, cancelPairing, joinWithCode, LinkError, unlink, useLink } from "../lib/link";

const explain = (e: unknown) => (e instanceof LinkError ? e.message : "發生錯誤，請再試一次。");

/** Settings section: link this device with another using a code, and see what it is linked to. */
export function SyncSection({ onMessage }: { onMessage: (m: string) => void }) {
  const link = useLink();
  const [panel, setPanel] = useState<"none" | "join">("none");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lastSync = useLiveQuery(async () => ((await db.meta.get("sync:last"))?.value as number | undefined) ?? 0, []);

  // leaving the settings takes the code down with it
  useEffect(() => () => cancelPairing(), []);

  const showCode = async () => {
    setError("");
    setPanel("none");
    setBusy(true);
    try {
      await beginPairing();
    } catch (e) {
      setError(explain(e));
    }
    setBusy(false);
  };

  const join = async () => {
    setError("");
    setBusy(true);
    try {
      const replaced = await joinWithCode(code);
      setPanel("none");
      setCode("");
      if (replaced) location.hash = "#/home";
      onMessage("已連結，正在同步。");
    } catch (e) {
      setError(explain(e));
    }
    setBusy(false);
  };

  if (!crypto.subtle) {
    return <p className="muted">這個網址不是安全連線（HTTPS），無法使用裝置同步。</p>;
  }

  return (
    <div className="link">
      {link.linked ? (
        <>
          <ul className="link-devices">
            {link.devices.map((d) => (
              <li key={d.id}>
                <span className={"link-dot" + (d.online ? " on" : "")} />
                <span>{d.name}</span>
                <span className="muted small">{d.online ? "連線中，變更會立刻同步" : "目前沒有開著"}</span>
              </li>
            ))}
            {link.devices.length === 0 && <li className="muted">沒有其他裝置了。</li>}
          </ul>
          <p className="muted small">
            {link.reach === "unreachable" ? "目前連不上配對服務（沒有網路？），連上後會自動繼續。" : ""}
            {lastSync ? ` 上次收到其他裝置的變更：${new Date(lastSync).toLocaleString("zh-TW")}。` : ""}
            兩台裝置同時開著 Slate 就會自動同步，不用再輸入連結碼；分開時各自的修改會在下次同時開啟時合併。
          </p>
        </>
      ) : (
        <p className="muted">
          用一組連結碼把這台裝置和另一台連起來，兩邊的筆記就會互相同步。資料加密後直接在兩台裝置之間傳送，不經過也不存放在任何伺服器。
        </p>
      )}

      {link.code ? (
        <div className="link-code-box">
          <div className="muted small">在另一台裝置開啟 Slate →「設定與備份」→「跨裝置同步」→「輸入連結碼」</div>
          <div className="link-code" aria-label="連結碼">
            {link.code}
          </div>
          <div className="muted small">等待另一台裝置輸入…（10 分鐘內有效）</div>
          <button className="btn" onClick={cancelPairing}>
            取消
          </button>
        </div>
      ) : panel === "join" ? (
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <label>
            另一台裝置上顯示的連結碼
            <input
              className="input link-input"
              autoFocus
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="XXXX-XXXX"
              maxLength={12}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy}>
              {busy ? "連線中…" : "連結"}
            </button>
            <button type="button" className="btn" onClick={() => setPanel("none")}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <div className="row wrap">
          <button className="btn primary" disabled={busy} onClick={() => void showCode()}>
            {busy ? "準備中…" : link.linked ? "再連結一台：顯示連結碼" : "顯示連結碼"}
          </button>
          <button
            className="btn"
            onClick={() => {
              setError("");
              setPanel("join");
            }}
          >
            輸入連結碼
          </button>
          {link.linked && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm("停止這台裝置的同步？這台裝置上的資料會保留，之後要再同步需要重新輸入連結碼。")) return;
                await unlink();
                onMessage("已停止同步。這台裝置上的資料都還在。");
              }}
            >
              停止同步
            </button>
          )}
        </div>
      )}
      {error && <p className="auth-error">{error}</p>}
    </div>
  );
}
