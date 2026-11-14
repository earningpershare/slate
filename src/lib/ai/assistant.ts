// What the assistant panel needs from a model, whichever model it is. Each provider
// (claude.ts, local.ts) keeps the conversation in its own format and runs the same tools.
import { callTool, type Tool } from "./tools";

export interface ToolEvent {
  id: string;
  /** one line for the person, e.g. 新增任務「買牛奶」 */
  label: string;
  status: "running" | "done" | "error" | "declined";
}

export interface Hooks {
  /** more of the reply arrived */
  onText(delta: string): void;
  onTool(event: ToolEvent): void;
  /** ask the person before something destructive; resolves to their answer */
  confirm(label: string): Promise<boolean>;
  signal: AbortSignal;
}

export interface Assistant {
  /** Send one message and run the model until it has finished answering. */
  send(text: string, hooks: Hooks): Promise<void>;
}

/** An error whose message can be shown to the person as is. */
export class AiError extends Error {}

// ---------- where a model can come from ----------

/**
 * Services reached with an API key. Every one of them was checked to accept requests made
 * straight from a web page (CORS), so the key never passes through a server of ours.
 * All but Anthropic speak the same OpenAI-style protocol (local.ts).
 */
export const SERVICES = [
  { id: "anthropic", name: "Claude（Anthropic）", url: "", keys: "platform.claude.com/settings/keys", hint: "sk-ant-…" },
  { id: "openai", name: "OpenAI（GPT）", url: "https://api.openai.com/v1", keys: "platform.openai.com/api-keys", hint: "sk-…" },
  { id: "gemini", name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", keys: "aistudio.google.com/apikey", hint: "AIza…" },
  { id: "openrouter", name: "OpenRouter（一把金鑰用很多家的模型）", url: "https://openrouter.ai/api/v1", keys: "openrouter.ai/keys", hint: "sk-or-…" },
  { id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com/v1", keys: "platform.deepseek.com/api_keys", hint: "sk-…" },
  { id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1", keys: "console.groq.com/keys", hint: "gsk_…" },
  { id: "mistral", name: "Mistral", url: "https://api.mistral.ai/v1", keys: "console.mistral.ai/api-keys", hint: "" },
  { id: "xai", name: "xAI（Grok）", url: "https://api.x.ai/v1", keys: "console.x.ai", hint: "xai-…" },
  { id: "together", name: "Together AI", url: "https://api.together.xyz/v1", keys: "api.together.ai/settings/api-keys", hint: "" },
  { id: "cerebras", name: "Cerebras", url: "https://api.cerebras.ai/v1", keys: "cloud.cerebras.ai", hint: "csk-…" },
  { id: "custom", name: "其他（任何 OpenAI 相容的接口）", url: "", keys: "", hint: "" },
] as const;

/** Programs that run models on the person's own computer, at the address each uses by default. */
export const LOCAL_APPS = [
  { id: "ollama", name: "Ollama", url: "http://localhost:11434/v1", site: "ollama.com" },
  { id: "lmstudio", name: "LM Studio", url: "http://localhost:1234/v1", site: "lmstudio.ai" },
] as const;

export type ServiceId = (typeof SERVICES)[number]["id"] | (typeof LOCAL_APPS)[number]["id"] | "local-custom";
const LOCAL_IDS: readonly string[] = ["ollama", "lmstudio", "local-custom"];
export const isLocalService = (id: string) => LOCAL_IDS.includes(id);
export const serviceName = (id: string) => [...SERVICES, ...LOCAL_APPS].find((s) => s.id === id)?.name.replace(/（.*$/, "") ?? "本機模型";

export interface AiSettings {
  /** which entry of SERVICES / LOCAL_APPS is in use */
  service: ServiceId;
  /** derived from service: Anthropic has its own protocol, everything else shares one */
  provider: "claude" | "local";
  claudeKey: string;
  claudeModel: string;
  /** base address of the OpenAI-style endpoint in use */
  localUrl: string;
  localModel: string;
  localKey: string;
  /** what was last used with each service, so switching back and forth loses nothing */
  remembered: Record<string, { key?: string; model?: string; url?: string }>;
}

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "建議：聰明、價格適中" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "較快、較便宜" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "最快、最便宜" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", note: "最強、最貴" },
] as const;

const DEFAULTS: AiSettings = {
  service: "anthropic",
  provider: "claude",
  claudeKey: "",
  claudeModel: "claude-opus-5-5",
  localUrl: "",
  localModel: "",
  localKey: "",
  remembered: {},
};

/** Point the settings at another service, bringing back what was used with it before. */
export function withService(s: AiSettings, service: ServiceId): AiSettings {
  const remembered = { ...s.remembered, [s.service]: { key: s.localKey, model: s.localModel, url: s.localUrl } };
  if (service === "anthropic") return { ...s, remembered, service, provider: "claude" };
  const preset = [...SERVICES, ...LOCAL_APPS].find((x) => x.id === service);
  const back = remembered[service] ?? {};
  return { ...s, remembered, service, provider: "local", localUrl: preset?.url || back.url || "", localKey: back.key ?? "", localModel: back.model ?? "" };
}

// Kept on this device only: never synced, never put in a backup.
const KEY = "ai-settings";
export function loadSettings(): AiSettings {
  let saved: Partial<AiSettings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AiSettings>;
  } catch {
    /* unreadable: start fresh */
  }
  const s = { ...DEFAULTS, ...saved, remembered: { ...saved.remembered } };
  // settings saved before services existed
  if (!saved.service) {
    s.service = saved.provider === "local" ? ((LOCAL_APPS.find((a) => a.url === s.localUrl)?.id ?? "local-custom") as ServiceId) : "anthropic";
  }
  s.provider = s.service === "anthropic" ? "claude" : "local";
  return s;
}
export function saveSettings(s: AiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the settings last until the tab closes */
  }
}
export const isConfigured = (s: AiSettings) =>
  s.service === "anthropic"
    ? !!s.claudeKey.trim()
    : !!s.localUrl.trim() && !!s.localModel.trim() && (isLocalService(s.service) || s.service === "custom" || !!s.localKey.trim());

// ---------- finding out what a service offers ----------

const NOT_CHAT = /embed|whisper|tts|speech|audio|transcri|dall-e|image|imagen|veo|sora|moderation|rerank|guard|realtime|aqa|computer-use|search-preview/i;

/** The chat models an OpenAI-style endpoint lists. Throws AiError with a message for the person. */
export async function listModels(baseUrl: string, key: string, signal?: AbortSignal): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(base + "/models", { signal, headers: key.trim() ? { authorization: "Bearer " + key.trim() } : {} });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AiError("連不上這個位址。");
  }
  if (res.status === 401 || res.status === 403) throw new AiError("金鑰無效，或沒有使用權限。");
  if (!res.ok) throw new AiError(`讀不到模型清單（${res.status}）。`);
  const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | { id?: string }[] | null;
  const items = Array.isArray(body) ? body : (body?.data ?? []);
  const ids = items
    .map((m) => String(m?.id ?? "").replace(/^models\//, ""))
    .filter((id) => id && !NOT_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export type LocalProbe = { state: "ok"; models: string[] } | { state: "blocked" } | { state: "absent" };

/**
 * Is a model program running at this address, and does it let this site talk to it?
 * "blocked": something answers there, but refuses requests from web pages (it needs a setting).
 */
export async function probeLocal(url: string): Promise<LocalProbe> {
  const timeout = () => AbortSignal.timeout(2500);
  try {
    return { state: "ok", models: await listModels(url, "", timeout()) };
  } catch {
    try {
      // a request the page may not read still tells us whether anything is listening
      await fetch(url.replace(/\/+$/, "") + "/models", { mode: "no-cors", signal: timeout() });
      return { state: "blocked" };
    } catch {
      return { state: "absent" };
    }
  }
}

// ---------- shared by every provider ----------

/** The moment a message is sent, for "tomorrow" and "next Friday". Goes with the message, not the system prompt, so the prompt stays cacheable. */
export function stamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  return `[now: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}, 星期${day}]`;
}

let counter = 0;
/** Run one tool call for any provider: ask first when it destroys something, report progress, never throw. */
export async function runTool(tools: Tool[], name: string, input: unknown, hooks: Hooks): Promise<{ text: string; error: boolean }> {
  const tool = tools.find((t) => t.name === name);
  const id = "t" + ++counter;
  let label = name;
  try {
    if (tool && input && typeof input === "object") label = await tool.describe(input as Record<string, unknown>);
  } catch {
    /* a malformed input: callTool reports it below */
  }
  if (tool?.danger) {
    if (!(await hooks.confirm(label))) {
      hooks.onTool({ id, label, status: "declined" });
      return { text: "The person declined this action. Do not try it again; carry on with the rest or ask what they would like instead.", error: true };
    }
  }
  hooks.onTool({ id, label, status: "running" });
  const result = await callTool(tools, name, input);
  hooks.onTool({ id, label, status: result.error ? "error" : "done" });
  return result;
}
