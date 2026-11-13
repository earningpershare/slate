// The assistant panel: talk to a model that works in this workspace through the Slate tools.
// Which model is the person's choice: a Claude API key, or a model on their own computer.
import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, LoaderCircle, Plus, Send, Settings, Square, TriangleAlert, X } from "lucide-react";
import {
  AiError,
  type AiSettings,
  type Assistant,
  CLAUDE_MODELS,
  isConfigured,
  loadSettings,
  saveSettings,
  type ToolEvent,
} from "../lib/ai/assistant";
import { bridgeCode, bridgeEnabled, setBridgeCode, setBridgeEnabled, useBridge, validCode } from "../lib/ai/bridge";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; tools: ToolEvent[] }
  | { kind: "error"; text: string };

const EXAMPLES = ["今天有哪些任務要做？", "幫我建一頁「讀書筆記」，放三個小標題", "把這週沒做完的任務延到下週一", "新增任務：明天下午三點交報告，放到「工作」清單"];

/** Build the assistant for the chosen provider. Loaded on demand: the model code is not part of the app's first load. */
async function connect(settings: AiSettings): Promise<Assistant> {
  const [{ slateTools }, editor] = await Promise.all([import("../lib/ai/tools"), import("./Editor")]);
  const tools = slateTools({
    toBlocks: editor.markdownToBlocks,
    toMarkdown: editor.blocksToMarkdown,
    pageWritten: (id) => window.dispatchEvent(new CustomEvent("slate:page-written", { detail: id })),
  });
  return settings.provider === "claude"
    ? (await import("../lib/ai/claude")).createClaude(settings, tools)
    : (await import("../lib/ai/local")).createLocal(settings, tools);
}

/** Using a Claude plan instead of a key: Claude Desktop / Claude Code reach this tab through a small bridge program. */
function SubscriptionSetup() {
  const state = useBridge();
  const [on, setOn] = useState(bridgeEnabled);
  const [code, setCode] = useState(bridgeCode);
  return (
    <div className="ai-mcp">
      <p className="muted small">
        不用 API 金鑰：讓你電腦上的 <b>Claude 桌面版</b>或 <b>Claude Code</b> 連進這個 Slate，用的是它們本來的方案（Pro／Max 等）。 對話在 Claude
        那邊進行，Slate 這個分頁要開著。只能在電腦上使用。
      </p>
      <ol>
        <li>
          下載橋接程式{" "}
          <a href="slate-mcp.mjs" download>
            slate-mcp.mjs
          </a>
          （單一檔案，電腦要裝有 Node.js 18 以上）。
        </li>
        <li>
          告訴 Claude 它在哪裡。Claude Code 執行：
          <code>claude mcp add slate -- node 下載的路徑/slate-mcp.mjs</code>
          Claude 桌面版：設定 → 開發人員 → 編輯設定，在 <code className="inline">mcpServers</code> 裡加入：
          <code>{'"slate": { "command": "node", "args": ["下載的路徑/slate-mcp.mjs"] }'}</code>
          然後重新啟動 Claude。
        </li>
        <li>
          取得這台電腦的配對碼：在 Claude 裡說「給我 Slate 配對碼」，或在終端機執行
          <code>node 下載的路徑/slate-mcp.mjs pair</code>
          把它貼在下面。配對碼讓 Slate 只聽你自己的橋接程式。
        </li>
        <li>打開下面的開關。瀏覽器問是否允許這個網站連線到這台裝置上的應用程式時，請按允許。</li>
      </ol>
      <label>
        配對碼
        <input
          className="input ai-code"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (validCode(e.target.value) || !e.target.value.trim()) setBridgeCode(e.target.value);
          }}
        />
      </label>
      <label className="ai-switch">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setBridgeEnabled(e.target.checked);
          }}
        />
        允許這台電腦上的 Claude 連進來
      </label>
      {on && (
        <p className={"ai-bridge-state " + state} role="status">
          {state === "connected"
            ? "已連上橋接程式。現在可以在 Claude 裡說「看看我 Slate 今天的任務」。"
            : state === "unpaired"
              ? validCode(code)
                ? "配對碼不符：那個連接埠上的程式不是用這組配對碼的橋接程式，Slate 不會聽它的。請重新取得配對碼。"
                : "請先貼上配對碼（16 個字元）。"
              : "還沒找到橋接程式。請確認 Claude 已經啟動而且設定好了；它啟動後這裡會自動連上。"}
        </p>
      )}
      <p className="muted small">
        橋接程式不儲存任何資料，只接受這個網站、而且知道配對碼的分頁；Slate 也只執行有配對碼簽章的指令。Claude 要刪除東西時，這個分頁會先跳出視窗問你。
        Claude 讀到的頁面內容會送給 Anthropic 處理。
      </p>
    </div>
  );
}

function Setup({ initial, onSave, onCancel }: { initial: AiSettings; onSave: (s: AiSettings) => void; onCancel?: () => void }) {
  const [s, setS] = useState(initial);
  const [plan, setPlan] = useState(false); // the "Claude plan" tab, which is not a chat provider
  const set = (patch: Partial<AiSettings>) => {
    setPlan(false);
    setS((cur) => ({ ...cur, ...patch }));
  };
  return (
    <form
      className="ai-setup auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(s);
      }}
    >
      <p className="muted">助理可以幫你找資料、寫頁面、整理任務。選一個模型來源；設定只存在這台裝置上，不會同步，也不會進備份。</p>
      <div className="seg">
        <button type="button" className={"seg-btn" + (!plan && s.provider === "claude" ? " active" : "")} onClick={() => set({ provider: "claude" })}>
          Claude API 金鑰
        </button>
        <button type="button" className={"seg-btn" + (!plan && s.provider === "local" ? " active" : "")} onClick={() => set({ provider: "local" })}>
          本機模型
        </button>
        <button type="button" className={"seg-btn" + (plan ? " active" : "")} onClick={() => setPlan(true)}>
          Claude 訂閱
        </button>
      </div>
      {plan ? (
        <SubscriptionSetup />
      ) : s.provider === "claude" ? (
        <>
          <label>
            API 金鑰
            <input className="input" type="password" autoComplete="off" placeholder="sk-ant-…" value={s.claudeKey} onChange={(e) => set({ claudeKey: e.target.value })} />
          </label>
          <label>
            模型
            <select className="input" value={s.claudeModel} onChange={(e) => set({ claudeModel: e.target.value })}>
              {CLAUDE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}（{m.note}）
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            金鑰在 platform.claude.com 申請，用量依 API 價格另外計費；Claude 的 Pro／Max 訂閱不能用在這裡。金鑰只會從這台裝置直接送到 Anthropic。
            你的訊息和助理讀到的頁面內容會送給 Anthropic 處理。
          </p>
        </>
      ) : (
        <>
          <label>
            位址（OpenAI 相容接口）
            <input className="input" autoComplete="off" value={s.localUrl} onChange={(e) => set({ localUrl: e.target.value })} />
          </label>
          <label>
            模型名稱
            <input className="input" autoComplete="off" placeholder="例如 qwen2.5:14b" value={s.localModel} onChange={(e) => set({ localModel: e.target.value })} />
          </label>
          <label>
            金鑰（通常不用填）
            <input className="input" type="password" autoComplete="off" value={s.localKey} onChange={(e) => set({ localKey: e.target.value })} />
          </label>
          <p className="muted small">
            適用 Ollama、LM Studio 等在自己電腦上執行的模型，資料完全不離開這台電腦。模型要支援工具呼叫（tools）。 Ollama 需要先允許這個網站連線：設定環境變數
            OLLAMA_ORIGINS={location.origin} 後重新啟動 Ollama。第一次使用時瀏覽器會問是否允許這個網站連線到這台裝置上的應用程式，請按允許。小模型操作工具的能力比 Claude 弱，複雜的要求比較容易出錯。
          </p>
        </>
      )}
      <div className="row" style={plan ? { display: "none" } : undefined}>
        <button className="btn primary" disabled={!isConfigured(s)}>
          儲存
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

const toolIcon = (status: ToolEvent["status"]) =>
  status === "running" ? <LoaderCircle size={13} className="spin" /> : status === "done" ? <Check size={13} /> : status === "declined" ? <CircleSlash size={13} /> : <TriangleAlert size={13} />;

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState(loadSettings);
  const [setup, setSetup] = useState(() => !isConfigured(loadSettings()));
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ label: string; answer: (ok: boolean) => void } | null>(null);
  const assistant = useRef<Assistant | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // braces on purpose: newer browsers return a promise from scrollIntoView, and an effect may only return a clean-up
    void end.current?.scrollIntoView({ block: "end" });
  }, [items, ask]);
  useEffect(() => () => abort.current?.abort(), []);

  const reset = () => {
    abort.current?.abort();
    assistant.current = null;
    setItems([]);
    setAsk(null);
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setDraft("");
    setBusy(true);
    setItems((cur) => [...cur, { kind: "user", text: message }, { kind: "assistant", text: "", tools: [] }]);
    /** change the reply being written (always the last item) */
    const reply = (change: (r: Extract<Item, { kind: "assistant" }>) => Extract<Item, { kind: "assistant" }>) =>
      setItems((cur) => {
        const last = cur[cur.length - 1];
        return last?.kind === "assistant" ? [...cur.slice(0, -1), change(last)] : cur;
      });
    const controller = new AbortController();
    abort.current = controller;
    try {
      assistant.current ??= await connect(settings);
      await assistant.current.send(message, {
        signal: controller.signal,
        onText: (delta) => reply((r) => ({ ...r, text: r.text + delta })),
        onTool: (ev) => reply((r) => ({ ...r, tools: r.tools.some((t) => t.id === ev.id) ? r.tools.map((t) => (t.id === ev.id ? ev : t)) : [...r.tools, ev] })),
        confirm: (label) =>
          new Promise<boolean>((resolve) => {
            const done = (ok: boolean) => {
              setAsk(null);
              resolve(ok);
            };
            controller.signal.addEventListener("abort", () => done(false), { once: true });
            setAsk({ label, answer: done });
          }),
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        const text = e instanceof AiError ? e.message : "發生錯誤：" + (e instanceof Error ? e.message : String(e));
        setItems((cur) => [...cur, { kind: "error", text }]);
        // the conversation the provider holds may be half-written: start the next message clean
        assistant.current = null;
      }
    }
    // drop a reply that never got any content (stopped before the first word)
    setItems((cur) => {
      const last = cur[cur.length - 1];
      return last?.kind === "assistant" && !last.text && last.tools.length === 0 ? cur.slice(0, -1) : cur;
    });
    setAsk(null);
    setBusy(false);
  };

  return (
    <aside className="ai-panel" aria-label="AI 助理">
      <header className="ai-head">
        <b>AI 助理</b>
        <span className="muted small ai-model">
          {isConfigured(settings) ? (settings.provider === "claude" ? CLAUDE_MODELS.find((m) => m.id === settings.claudeModel)?.name : settings.localModel) : ""}
        </span>
        <button className="btn ghost" title="新對話" aria-label="新對話" onClick={reset}>
          <Plus size={16} />
        </button>
        <button className="btn ghost" title="模型設定" aria-label="模型設定" onClick={() => setSetup((v) => !v)}>
          <Settings size={16} />
        </button>
        <button className="btn ghost" title="關閉" aria-label="關閉" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      {setup ? (
        <div className="ai-body">
          <Setup
            initial={settings}
            onCancel={isConfigured(settings) ? () => setSetup(false) : undefined}
            onSave={(s) => {
              saveSettings(s);
              setSettings(s);
              setSetup(false);
              reset();
            }}
          />
        </div>
      ) : (
        <>
          <div className="ai-body" aria-live="polite">
            {items.length === 0 && (
              <div className="ai-empty">
                <p className="muted">跟我說你想做什麼，我會直接在你的 Slate 裡動手。例如：</p>
                {EXAMPLES.map((x) => (
                  <button key={x} className="ai-example" onClick={() => void send(x)}>
                    {x}
                  </button>
                ))}
              </div>
            )}
            {items.map((it, n) =>
              it.kind === "user" ? (
                <div key={n} className="ai-msg user">
                  {it.text}
                </div>
              ) : it.kind === "error" ? (
                <div key={n} className="ai-msg error" role="alert">
                  {it.text}
                </div>
              ) : (
                <div key={n} className="ai-msg assistant">
                  {it.tools.length > 0 && (
                    <ul className="ai-tools">
                      {it.tools.map((t) => (
                        <li key={t.id} className={"ai-tool " + t.status}>
                          {toolIcon(t.status)}
                          <span>{t.label}</span>
                          {t.status === "declined" && <span className="muted">（你沒有同意）</span>}
                          {t.status === "error" && <span className="muted">（沒有成功）</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {it.text ? <div className="ai-text">{it.text}</div> : busy && n === items.length - 1 && !ask ? <LoaderCircle size={16} className="spin muted" /> : null}
                </div>
              ),
            )}
            {ask && (
              <div className="ai-confirm" role="alertdialog" aria-label="需要你的同意">
                <b>要讓助理{ask.label}嗎？</b>
                <div className="row">
                  <button className="btn danger" onClick={() => ask.answer(true)}>
                    允許
                  </button>
                  <button className="btn" onClick={() => ask.answer(false)}>
                    不要
                  </button>
                </div>
              </div>
            )}
            <div ref={end} />
          </div>
          <form
            className="ai-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              rows={1}
              placeholder="輸入你想做的事…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
            {busy ? (
              <button type="button" className="btn" aria-label="停止" title="停止" onClick={() => abort.current?.abort()}>
                <Square size={15} />
              </button>
            ) : (
              <button className="btn primary" aria-label="送出" title="送出" disabled={!draft.trim()}>
                <Send size={15} />
              </button>
            )}
          </form>
        </>
      )}
    </aside>
  );
}
