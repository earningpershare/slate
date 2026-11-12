import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { changePassword, resolveConflict, signIn, signOut, useSession } from "../lib/account";

/** Sign-in / sign-up form. `onDone` runs once the device is signed in (or needs a conflict settled). */
export function AuthForm({ onDone }: { onDone?: () => void }) {
  const s = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canRegister = s.signup !== "closed";

  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await signIn(db, mode, name, password, invite);
          onDone?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "發生錯誤");
        }
        setBusy(false);
      }}
    >
      {canRegister && (
        <span className="seg">
          {(["login", "register"] as const).map((m) => (
            <button
              type="button"
              key={m}
              className={"seg-btn" + (mode === m ? " active" : "")}
              onClick={() => {
                setMode(m);
                setError("");
              }}
            >
              {m === "login" ? "登入" : "建立帳號"}
            </button>
          ))}
        </span>
      )}
      <label>
        帳號
        <input
          className="input"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        密碼
        <input
          className="input"
          type="password"
          name="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={mode === "register" ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {mode === "register" && s.signup === "invite" && (
        <label>
          邀請碼
          <input className="input" required value={invite} onChange={(e) => setInvite(e.target.value)} />
        </label>
      )}
      {mode === "register" && (
        <p className="muted small">密碼至少 8 個字。這裡沒有「忘記密碼」信件，忘記時要請管理者重設。</p>
      )}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <button className="btn primary" disabled={busy}>
        {busy ? "請稍候…" : mode === "login" ? "登入" : "建立帳號並登入"}
      </button>
    </form>
  );
}

/** First screen on a device with no data yet, when the site offers accounts. */
export function Welcome({ onLocalOnly, onSignedIn }: { onLocalOnly: () => void; onSignedIn: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <span className="brand">
          <span className="brand-mark" aria-hidden />
          Slate
        </span>
        <p className="muted">登入後，這台裝置會和你其他已登入的裝置互相同步。</p>
        <AuthForm onDone={onSignedIn} />
        <button className="btn ghost" onClick={onLocalOnly}>
          先不登入，只在這台裝置使用
        </button>
      </div>
    </div>
  );
}

/** The "跨裝置同步" part of the settings dialog. */
export function AccountSection({ onMessage }: { onMessage: (m: string) => void }) {
  const s = useSession();
  const lastSync = useLiveQuery(async () => ((await db.meta.get("sync:last"))?.value as number | undefined) ?? 0, []);
  const [panel, setPanel] = useState<"none" | "auth" | "password">("none");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  if (!s.server) {
    return <p className="muted">這個網址沒有提供帳號服務，資料只留在這台裝置。要搬到別台裝置請用上面的匯出與還原。</p>;
  }

  if (s.user && s.conflict) {
    return (
      <>
        <p className="muted">
          你登入的是「{s.user.name}」，但這台裝置上的資料屬於「{s.conflict}」，所以沒有開始同步。
        </p>
        <div className="row wrap">
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(`清除這台裝置上「${s.conflict}」的資料，改給「${s.user!.name}」使用？尚未同步到其他裝置的內容會消失。`)) return;
              await resolveConflict(db, true);
              location.hash = "/home";
            }}
          >
            清除這台裝置，改用「{s.user.name}」
          </button>
          <button className="btn" onClick={() => void resolveConflict(db, false)}>
            登出
          </button>
        </div>
      </>
    );
  }

  if (!s.user) {
    return (
      <>
        <p className="muted">
          {s.expired
            ? "登入已經失效，請重新登入才會繼續同步。這台裝置上的資料都還在。"
            : "登入後，這台裝置會和你其他已登入的裝置互相同步。筆記只在你的裝置之間傳遞，伺服器不保存。"}
        </p>
        {panel === "auth" ? (
          <AuthForm
            onDone={() => {
              setPanel("none");
              onMessage("已登入。");
            }}
          />
        ) : (
          <button className="btn primary" onClick={() => setPanel("auth")}>
            登入或建立帳號
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <p className="muted">
        已登入：<b>{s.user.name}</b>。
        {s.peers > 0 ? `目前有 ${s.peers} 台其他裝置連線中，變更會立刻互相同步。` : "目前沒有其他裝置連線。"}
        {lastSync ? ` 上次收到其他裝置的變更：${new Date(lastSync).toLocaleString("zh-TW")}。` : ""}
      </p>
      <p className="muted small">
        筆記只在你的裝置之間傳遞，伺服器不保存。兩台裝置要同時開著 Slate 才會同步；分開時各自的修改會在下次同時開啟時合併。
      </p>
      {panel === "password" ? (
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await changePassword(current, next);
              setPanel("none");
              setCurrent("");
              setNext("");
              onMessage("密碼已變更，其他裝置需要重新登入。");
            } catch (err) {
              onMessage(err instanceof Error ? err.message : "發生錯誤");
            }
          }}
        >
          <label>
            目前的密碼
            <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label>
            新密碼
            <input className="input" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn primary">變更密碼</button>
            <button type="button" className="btn" onClick={() => setPanel("none")}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <div className="row wrap">
          <button className="btn" onClick={() => setPanel("password")}>
            變更密碼
          </button>
          <button
            className="btn"
            onClick={async () => {
              await signOut(db, false);
              onMessage("已登出。這台裝置上的資料還在，可以繼續離線使用。");
            }}
          >
            登出
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm("登出並清除這台裝置上的所有資料？尚未同步到其他裝置的內容會消失。")) return;
              await signOut(db, true);
              try {
                localStorage.removeItem("local-only");
              } catch {
                /* ignore */
              }
              location.hash = "";
              location.reload();
            }}
          >
            登出並清除這台裝置
          </button>
        </div>
      )}
    </>
  );
}
