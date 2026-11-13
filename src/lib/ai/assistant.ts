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

export interface AiSettings {
  provider: "claude" | "local";
  claudeKey: string;
  claudeModel: string;
  /** OpenAI-compatible endpoint of a local model server (Ollama, LM Studio, ...) */
  localUrl: string;
  localModel: string;
  localKey: string;
}

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "建議：聰明、價格適中" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "較快、較便宜" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "最快、最便宜" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", note: "最強、最貴" },
] as const;

const DEFAULTS: AiSettings = {
  provider: "claude",
  claudeKey: "",
  claudeModel: "claude-opus-5-5",
  localUrl: "http://localhost:11434/v1",
  localModel: "",
  localKey: "",
};

// Kept on this device only: never synced, never put in a backup.
const KEY = "ai-settings";
export function loadSettings(): AiSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AiSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveSettings(s: AiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the settings last until the tab closes */
  }
}
export const isConfigured = (s: AiSettings) => (s.provider === "claude" ? !!s.claudeKey.trim() : !!s.localUrl.trim() && !!s.localModel.trim());

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
    if (tool && input && typeof input === "object") label = tool.describe(input as Record<string, unknown>);
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
