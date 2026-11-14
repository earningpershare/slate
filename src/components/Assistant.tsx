// The assistant panel: talk to a model that works in this workspace through the Slate tools.
// Which model is the person's choice: a Claude API key, or a model on their own computer.
import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, Download, LoaderCircle, Plus, Send, Settings, Square, TriangleAlert, X } from "lucide-react";
import {
  AiError,
  type AiSettings,
  type Assistant,
  CLAUDE_MODELS,
  isConfigured,
  isLocalService,
  listModels,
  LOCAL_APPS,
  type LocalProbe,
  loadSettings,
  probeLocal,
  saveSettings,
  SERVICES,
  type ServiceId,
  serviceName,
  type ToolEvent,
  withService,
} from "../lib/ai/assistant";
import { bridgeCode, bridgeEnabled, setBridgeCode, setBridgeEnabled, useBridge, validCode } from "../lib/ai/bridge";
import { useLocalState } from "../ui";

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

/** A block of text with a button that copies it. */
function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ai-copy">
      <pre>{text}</pre>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch {
            prompt("請複製：", text);
          }
        }}
      >
        {copied ? "已複製" : label}
      </button>
    </div>
  );
}

/**
 * Using a Claude plan instead of a key. Two ways in, neither needing anything typed by hand:
 * Claude Desktop installs an extension file, and Claude Code is told in one pasted message to
 * set itself up. Either way, Claude then hands over a link that pairs this browser with it.
 */
function SubscriptionSetup() {
  const state = useBridge();
  const [on, setOn] = useState(bridgeEnabled);
  const [code, setCode] = useState(bridgeCode);
  const [app, setApp] = useLocalState<"desktop" | "code">("ai-plan-app", "desktop");
  const connected = state === "connected";
  const site = location.origin + location.pathname.replace(/[^/]*$/, "");
  const file = site + "slate-mcp.mjs";
  // what the person pastes into Claude Code: it downloads the bridge and lets it register itself
  const ask = `請幫我把 Slate 接上 Claude Code，依序做這三件事：
1. 把 ${file} 下載到暫存資料夾。
2. 用 node 執行它，並加上參數 install（例如：node slate-mcp.mjs install）。
3. 把它印出來的內容原樣告訴我，包含裡面的連結。`;
  const command = /Windows/.test(navigator.userAgent)
    ? `curl.exe -fsSL ${file} -o "$env:TEMP\\slate-mcp.mjs"; node "$env:TEMP\\slate-mcp.mjs" install`
    : `curl -fsSL ${file} -o /tmp/slate-mcp.mjs && node /tmp/slate-mcp.mjs install`;

  return (
    <div className="ai-mcp">
      <p className="muted small">
        不用 API 金鑰：讓這台電腦上的 Claude 直接在你的 Slate 裡做事，用的是你原本的方案（Pro／Max 等）。對話在 Claude 那邊進行，Slate 要開著。只能在電腦上使用。
      </p>

      {connected ? (
        <p className="ai-bridge-state connected" role="status">
          已經連上 Claude 了。在 Claude 裡直接說想做的事，例如「看看我 Slate 今天的任務」。
        </p>
      ) : (
        <>
          <div className="seg ai-app-choice" role="group" aria-label="你用的是哪一種 Claude">
            <button type="button" className={"seg-btn" + (app === "desktop" ? " active" : "")} onClick={() => setApp("desktop")}>
              Claude 桌面版
            </button>
            <button type="button" className={"seg-btn" + (app === "code" ? " active" : "")} onClick={() => setApp("code")}>
              Claude Code（VS Code／終端機）
            </button>
          </div>

          {app === "desktop" ? (
            <ol className="ai-steps">
              <li>
                <b>先確認電腦上有 Claude 桌面版</b>
                <span>
                  沒有的話到{" "}
                  <a href="https://claude.ai/download" target="_blank" rel="noreferrer">
                    claude.ai/download
                  </a>{" "}
                  安裝並登入。
                </span>
                <span className="muted small">要的是獨立的「Claude」應用程式。你用的如果是 VS Code 裡的 Claude Code，請改選上面的另一個選項，不用另外裝東西。</span>
              </li>
              <li>
                <b>把 Slate 裝進 Claude</b>
                <a className="btn primary" href="slate.mcpb" download>
                  <Download size={15} /> 下載 Claude 擴充功能
                </a>
                <span className="muted small">下載後點兩下那個檔案，Claude 桌面版會問你要不要安裝，按「安裝」。</span>
                <details className="ai-help">
                  <summary>點兩下沒有反應？</summary>
                  <p>通常是電腦上還沒有 Claude 桌面版（見上一步），或是它裝好後還沒開過。裝好並開啟一次之後再點兩下。</p>
                  <p>
                    還是不行的話，從 Claude 裡面裝：打開 Claude 桌面版 → 設定（Settings）→ Extensions → Advanced settings → Install Extension…，選剛才下載的{" "}
                    <code className="inline">slate.mcpb</code>。
                  </p>
                </details>
              </li>
              <li>
                <b>連接</b>
                <span>
                  在 Claude 裡說：<q>連接我的 Slate</q>，然後點它給你的連結。
                </span>
                <span className="muted small">連結會打開 Slate 並問你一次是否允許。請用你平常開 Slate 的這個瀏覽器打開它。</span>
              </li>
            </ol>
          ) : (
            <ol className="ai-steps">
              <li>
                <b>把這段話貼給 Claude Code</b>
                <span className="muted small">它會自己下載並登記，不用另外安裝任何東西。過程中它會問你能不能執行指令，請允許。</span>
                <Copyable text={ask} label="複製這段話" />
              </li>
              <li>
                <b>重新載入，然後連接</b>
                <span>
                  照它說的重新啟動 Claude Code（VS Code 是「重新載入視窗」），再說：<q>連接我的 Slate</q>，點它給你的連結。
                </span>
                <span className="muted small">連結會打開 Slate 並問你一次是否允許。上一步印出來的連結也可以直接點。</span>
              </li>
              <li className="ai-step-plain">
                <details className="ai-help">
                  <summary>想自己在終端機做？</summary>
                  <p>貼上這一行就好：</p>
                  <Copyable text={command} label="複製指令" />
                </details>
              </li>
            </ol>
          )}
        </>
      )}

      {on && !connected && (
        <p className={"ai-bridge-state " + state} role="status">
          {state === "unpaired"
            ? validCode(code)
              ? "配對不符：請在 Claude 裡再說一次「連接我的 Slate」，點新的連結。"
              : "還沒配對：請在 Claude 裡說「連接我的 Slate」，點它給的連結。"
            : "正在等 Claude：請確認 Claude 開著，而且已經照上面的步驟裝好。瀏覽器問是否允許連線到這台裝置時，請按允許。"}
        </p>
      )}

      {(on || connected) && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOn(false);
            setBridgeEnabled(false);
          }}
        >
          中斷與 Claude 的連接
        </button>
      )}

      <details className="ai-advanced">
        <summary>進階：其他支援 MCP 的程式，或手動配對</summary>
        <p className="muted small">
          任何支援 MCP 的程式都能用同一個橋接程式：下載{" "}
          <a href="slate-mcp.mjs" download>
            slate-mcp.mjs
          </a>
          （需要 Node.js 18 以上），在該程式的 MCP 設定裡把指令設成 <code className="inline">node 下載的路徑/slate-mcp.mjs</code>。
        </p>
        <label>
          配對碼（執行 <code className="inline">node slate-mcp.mjs pair</code> 取得）
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
      </details>

      <p className="muted small">
        橋接程式不儲存任何資料，只和這個網站上配對過的 Slate 溝通；Slate 也只執行有配對簽章的指令。Claude 要刪除東西時，Slate 會先跳出視窗問你。 Claude
        讀到的頁面內容會送給 Anthropic 處理。
      </p>
    </div>
  );
}

/** Lists the models a service offers once there is enough to ask with; typing a name by hand always works too. */
function ModelPicker({ url, apiKey, needsKey, value, onChange }: { url: string; apiKey: string; needsKey: boolean; value: string; onChange: (model: string) => void }) {
  const [found, setFound] = useState<{ state: "idle" | "loading" | "ok" | "error"; models: string[]; message?: string }>({ state: "idle", models: [] });
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!url.trim() || (needsKey && apiKey.trim().length < 8)) return void setFound({ state: "idle", models: [] });
    const controller = new AbortController();
    setFound((f) => ({ ...f, state: "loading" }));
    // wait for the typing to stop before asking
    const timer = setTimeout(() => {
      listModels(url, apiKey, controller.signal).then(
        (models) => setFound({ state: "ok", models }),
        (e) => !controller.signal.aborted && setFound({ state: "error", models: [], message: e instanceof AiError ? e.message : "讀不到模型清單。" }),
      );
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, apiKey, needsKey]);

  const listed = found.state === "ok" && found.models.length > 0;
  return (
    <>
      <label>
        模型
        {listed && !manual ? (
          <select className="input ai-models" value={found.models.includes(value) ? value : ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">請選擇模型（共 {found.models.length} 個）</option>
            {found.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input className="input" autoComplete="off" spellCheck={false} placeholder="模型名稱" aria-label="模型名稱" value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </label>
      <p className={"muted small ai-model-state" + (found.state === "error" ? " error" : "")} role="status">
        {found.state === "idle" && needsKey && "貼上金鑰後，這裡會自動列出可以用的模型。"}
        {found.state === "loading" && "正在讀取模型清單…"}
        {found.state === "error" && `${found.message} 也可以直接輸入模型名稱。`}
        {found.state === "ok" && !listed && "這個服務沒有提供模型清單，請直接輸入模型名稱。"}
        {listed && (
          <button type="button" className="ai-link" onClick={() => setManual((m) => !m)}>
            {manual ? "從清單選" : "清單裡沒有？手動輸入"}
          </button>
        )}
      </p>
    </>
  );
}

function KeySetup({ s, set, pick }: { s: AiSettings; set: (patch: Partial<AiSettings>) => void; pick: (service: ServiceId) => void }) {
  const service = SERVICES.find((x) => x.id === s.service) ?? SERVICES[0];
  const where = service.keys && (
    <a href={"https://" + service.keys} target="_blank" rel="noreferrer">
      {service.keys.split("/")[0]}
    </a>
  );
  return (
    <>
      <label>
        服務
        <select className="input" value={service.id} onChange={(e) => pick(e.target.value as ServiceId)}>
          {SERVICES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      {service.id === "anthropic" ? (
        <>
          <label>
            API 金鑰
            <input className="input" type="password" autoComplete="off" placeholder={service.hint} value={s.claudeKey} onChange={(e) => set({ claudeKey: e.target.value })} />
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
            金鑰在 {where} 申請，用量依 API 價格另外計費；Claude 的 Pro／Max 訂閱請改用「Claude 訂閱」那一頁。金鑰只會從這台裝置直接送到 Anthropic。
            你的訊息和助理讀到的頁面內容會送給 Anthropic 處理。
          </p>
        </>
      ) : (
        <>
          {service.id === "custom" && (
            <label>
              位址
              <input className="input" autoComplete="off" spellCheck={false} placeholder="https://…/v1" value={s.localUrl} onChange={(e) => set({ localUrl: e.target.value })} />
            </label>
          )}
          <label>
            API 金鑰{service.id === "custom" ? "（沒有就留空）" : ""}
            <input className="input" type="password" autoComplete="off" placeholder={service.hint} value={s.localKey} onChange={(e) => set({ localKey: e.target.value })} />
          </label>
          <ModelPicker url={s.localUrl} apiKey={s.localKey} needsKey={service.id !== "custom"} value={s.localModel} onChange={(localModel) => set({ localModel })} />
          <p className="muted small">
            {where && <>金鑰在 {where} 申請，用量由該服務另外計費。</>}
            金鑰只會從這台裝置直接送到這個服務。你的訊息和助理讀到的頁面內容會送給它處理。請選支援工具呼叫（tools／function calling）的模型，否則助理沒辦法動手做事。
          </p>
        </>
      )}
    </>
  );
}

/** The line that lets Ollama accept requests from this site, for the computer at hand. */
function ollamaCommand(): string {
  const origin = location.origin;
  if (/Windows/.test(navigator.userAgent)) return `setx OLLAMA_ORIGINS "${origin}"`;
  if (/Macintosh/.test(navigator.userAgent)) return `launchctl setenv OLLAMA_ORIGINS "${origin}"`;
  return `OLLAMA_ORIGINS="${origin}" ollama serve`;
}

function LocalSetup({ s, set, choose }: { s: AiSettings; set: (patch: Partial<AiSettings>) => void; choose: (service: ServiceId, model: string) => void }) {
  const [probes, setProbes] = useState<Record<string, LocalProbe | "checking">>({});
  const [copied, setCopied] = useState(false);
  const detect = () => {
    setProbes(Object.fromEntries(LOCAL_APPS.map((a) => [a.id, "checking" as const])));
    for (const app of LOCAL_APPS) void probeLocal(app.url).then((p) => setProbes((cur) => ({ ...cur, [app.id]: p })));
  };
  useEffect(detect, []);
  const command = ollamaCommand();
  const windows = /Windows/.test(navigator.userAgent);

  return (
    <div className="ai-local">
      <p className="muted small">
        在自己電腦上執行的模型，資料完全不離開這台電腦。下面會自動尋找已經在執行的程式。第一次瀏覽器會問是否允許這個網站連線到這台裝置上的應用程式，請按允許。
      </p>
      {LOCAL_APPS.map((app) => {
        const p = probes[app.id];
        const mine = s.service === app.id;
        return (
          <section key={app.id} className={"ai-app" + (mine ? " chosen" : "")}>
            <header>
              <b>{app.name}</b>
              <span className={"ai-app-state" + (p && p !== "checking" ? " " + p.state : "")}>
                {!p || p === "checking" ? "尋找中…" : p.state === "ok" ? `已找到，${p.models.length} 個模型` : p.state === "blocked" ? "有在執行，但還不允許這個網站連線" : "沒有偵測到"}
              </span>
            </header>
            {p && p !== "checking" && p.state === "ok" && (
              <label>
                模型
                <select className="input ai-models" value={mine ? s.localModel : ""} onChange={(e) => choose(app.id, e.target.value)}>
                  <option value="">{p.models.length ? "請選擇模型" : "還沒有下載任何模型"}</option>
                  {p.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {p && p !== "checking" && p.state === "blocked" && app.id === "ollama" && (
              <ol className="ai-fix">
                <li>
                  複製這一行：
                  <code>{command}</code>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      await navigator.clipboard.writeText(command).catch(() => undefined);
                      setCopied(true);
                    }}
                  >
                    {copied ? "已複製" : "複製"}
                  </button>
                </li>
                <li>{windows ? "按 Windows 鍵，輸入 cmd 開啟「命令提示字元」，貼上後按 Enter。" : "打開「終端機」，貼上後按 Enter。"}</li>
                <li>把 Ollama 完全結束（{windows ? "右下角工作列圖示按右鍵 → Quit" : "選單列圖示 → Quit"}），再重新打開。</li>
                <li>回到這裡按「重新偵測」。</li>
              </ol>
            )}
            {p && p !== "checking" && p.state === "blocked" && app.id === "lmstudio" && (
              <ol className="ai-fix">
                <li>在 LM Studio 左側打開「Developer」（開發者）頁。</li>
                <li>在伺服器的設定（Settings）裡打開「Enable CORS」，並確認伺服器是啟動狀態。</li>
                <li>回到這裡按「重新偵測」。</li>
              </ol>
            )}
            {p && p !== "checking" && p.state === "absent" && (
              <p className="muted small">
                還沒安裝的話可以到{" "}
                <a href={"https://" + app.site} target="_blank" rel="noreferrer">
                  {app.site}
                </a>{" "}
                下載；已經安裝的話請先打開它{app.id === "lmstudio" ? "，並在 Developer 頁啟動伺服器" : ""}。
              </p>
            )}
          </section>
        );
      })}
      <button type="button" className="btn" onClick={detect}>
        重新偵測
      </button>
      <details className="ai-advanced" open={s.service === "local-custom"}>
        <summary>其他程式或不同的連接埠</summary>
        <label>
          位址
          <input
            className="input"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://localhost:8080/v1"
            value={s.service === "local-custom" ? s.localUrl : ""}
            onChange={(e) => (s.service === "local-custom" ? set({ localUrl: e.target.value }) : set({ ...withService(s, "local-custom"), localUrl: e.target.value }))}
          />
        </label>
        <label>
          模型名稱
          <input
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={s.service === "local-custom" ? s.localModel : ""}
            onChange={(e) => (s.service === "local-custom" ? set({ localModel: e.target.value }) : set({ ...withService(s, "local-custom"), localModel: e.target.value }))}
          />
        </label>
      </details>
      <p className="muted small">模型要支援工具呼叫（tools）才能操作 Slate。小模型操作工具的能力比大型模型弱，複雜的要求比較容易出錯。</p>
    </div>
  );
}

function Setup({ initial, onSave, onCancel }: { initial: AiSettings; onSave: (s: AiSettings) => void; onCancel?: () => void }) {
  const [s, setS] = useState(initial);
  const [tab, setTab] = useState<"key" | "local" | "plan">(isLocalService(initial.service) ? "local" : "key");
  const set = (patch: Partial<AiSettings>) => setS((cur) => ({ ...cur, ...patch }));
  const pick = (service: ServiceId) => setS((cur) => withService(cur, service));
  const ready = isConfigured(s) && (tab === "local") === isLocalService(s.service);
  return (
    <form
      className="ai-setup auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSave(s);
      }}
    >
      <p className="muted">助理可以幫你找資料、寫頁面、整理任務。選一個模型來源；設定只存在這台裝置上，不會同步，也不會進備份。</p>
      <div className="seg">
        <button
          type="button"
          className={"seg-btn" + (tab === "key" ? " active" : "")}
          onClick={() => {
            setTab("key");
            if (isLocalService(s.service)) pick("anthropic");
          }}
        >
          API 金鑰
        </button>
        <button type="button" className={"seg-btn" + (tab === "local" ? " active" : "")} onClick={() => setTab("local")}>
          本機模型
        </button>
        <button type="button" className={"seg-btn" + (tab === "plan" ? " active" : "")} onClick={() => setTab("plan")}>
          Claude 訂閱
        </button>
      </div>
      {tab === "plan" ? (
        <SubscriptionSetup />
      ) : tab === "key" ? (
        <KeySetup s={s} set={set} pick={pick} />
      ) : (
        <LocalSetup s={s} set={set} choose={(service, model) => setS((cur) => ({ ...withService(cur, service), localModel: model }))} />
      )}
      <div className="row" style={tab === "plan" ? { display: "none" } : undefined}>
        <button className="btn primary" disabled={!ready}>
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
          {isConfigured(settings)
            ? settings.provider === "claude"
              ? CLAUDE_MODELS.find((m) => m.id === settings.claudeModel)?.name
              : `${serviceName(settings.service)}・${settings.localModel}`
            : ""}
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
