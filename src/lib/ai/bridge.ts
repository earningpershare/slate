// The Slate tab's end of the MCP bridge (public/slate-mcp.mjs). When the person has
// switched it on, this tab asks the bridge program on this computer for tool calls coming
// from Claude Desktop / Claude Code, runs them with the same tools the built-in assistant
// uses, and sends the answers back. Nothing is listening unless the switch is on.
import { useSyncExternalStore } from "react";
import { toast } from "../../stores";
import type { Tool } from "./tools";

export type BridgeState = "off" | "searching" | "connected";

const KEY = "ai-bridge";
const DEFAULT_URL = "http://127.0.0.1:47800";

let state: BridgeState = "off";
let run = 0; // bumped whenever the bridge is switched; an older loop sees it and stops
let hangUp: AbortController | null = null; // ends the request the current loop is waiting on
const listeners = new Set<() => void>();
const set = (s: BridgeState) => {
  if (state === s) return;
  state = s;
  listeners.forEach((l) => l());
};
export function useBridge(): BridgeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
export const bridgeEnabled = () => read(KEY) === "1";
/** tests point this at their own bridge */
const bridgeUrl = () => (read("slate:bridge") || DEFAULT_URL).replace(/\/+$/, "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// loaded on the first call, so a workspace that never uses this pays nothing for it at startup
async function loadTools() {
  const [{ slateTools, callTool }, editor] = await Promise.all([import("./tools"), import("../../components/Editor")]);
  const tools: Tool[] = slateTools({
    toBlocks: editor.markdownToBlocks,
    toMarkdown: editor.blocksToMarkdown,
    pageWritten: (id) => window.dispatchEvent(new CustomEvent("slate:page-written", { detail: id })),
  });
  return { tools, callTool };
}

async function loop(mine: number, signal: AbortSignal) {
  const url = bridgeUrl();
  let kit: Awaited<ReturnType<typeof loadTools>> | null = null;
  let wait = 2000;
  while (mine === run) {
    let call: { id: string; name: string; input: unknown } | null = null;
    try {
      // a quick knock first: the poll below can stay open for a long while
      if (state !== "connected") await fetch(url + "/hello", { cache: "no-store", signal });
      if (mine !== run) return;
      set("connected");
      wait = 2000;
      const res = await fetch(url + "/poll", { cache: "no-store", signal });
      if (mine !== run) return;
      if (res.status === 200) call = await res.json();
    } catch {
      // the bridge is not running (Claude is closed), or the browser refused the connection
      if (mine !== run) return;
      set("searching");
      await sleep(wait);
      wait = Math.min(wait * 1.5, 20_000);
      continue;
    }
    if (!call) continue;

    kit ??= await loadTools();
    const { tools, callTool } = kit;
    const tool = tools.find((t) => t.name === call.name);
    let label = call.name;
    try {
      if (tool && call.input && typeof call.input === "object") label = await tool.describe(call.input as Record<string, unknown>);
    } catch {
      /* callTool reports a bad input */
    }
    let result: { text: string; error: boolean };
    // the same rule as the built-in assistant: nothing is destroyed without the person saying yes, here
    if (tool?.danger && !window.confirm(`Claude 想要${label}。\n\n要允許嗎？`)) {
      result = { text: "The person declined this action in Slate. Do not try it again; carry on with the rest or ask what they would like instead.", error: true };
    } else {
      result = await callTool(tools, call.name, call.input);
      if (tool && !result.error && !/^(search|list_|read_)/.test(tool.name)) toast("Claude：" + label);
    }
    try {
      await fetch(url + "/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: call.id, ...result }) });
    } catch {
      /* the bridge went away mid-call: Claude sees a timeout */
    }
  }
}

/** Called at startup and whenever the switch changes. */
export function startBridge() {
  run++;
  hangUp?.abort();
  hangUp = null;
  if (!bridgeEnabled()) return void set("off");
  set("searching");
  hangUp = new AbortController();
  void loop(run, hangUp.signal);
}

export function setBridgeEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  startBridge();
}
