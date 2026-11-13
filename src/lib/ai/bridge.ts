// The Slate tab's end of the MCP bridge (public/slate-mcp.mjs). When the person has
// switched it on, this tab asks the bridge program on this computer for tool calls coming
// from Claude Desktop / Claude Code, runs them with the same tools the built-in assistant
// uses, and sends the answers back. Nothing is listening unless the switch is on.
import { useSyncExternalStore } from "react";
import { toast } from "../../stores";
import type { Tool } from "./tools";

/** "unpaired": something answers on the port, but it does not know this tab's pairing code */
export type BridgeState = "off" | "searching" | "unpaired" | "connected";

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

// ---- pairing: both ends prove they know the code, and the code itself is never sent ----
const CODE_KEY = "ai-bridge-code";
export const bridgeCode = () => read(CODE_KEY) ?? "";
const normalCode = (code: string) => code.toUpperCase().replace(/[^0-9A-F]/g, "");
export const validCode = (code: string) => normalCode(code).length === 16;

const text = new TextEncoder();
async function signer(code: string) {
  const key = await crypto.subtle.importKey("raw", text.encode(normalCode(code)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return async (message: string) =>
    Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, text.encode(message))), (b) => b.toString(16).padStart(2, "0")).join("");
}
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

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
  const sign = await signer(bridgeCode());
  while (mine === run) {
    let call: { id: string; name: string; input: unknown } | null = null;
    try {
      if (state !== "connected") {
        // Is the program on that port the bridge this tab is paired with? Only it can sign our random number.
        // (Another program could be sitting on the port; it gets no further than this.)
        const n = randomHex();
        const hello = await fetch(`${url}/hello?n=${n}`, { cache: "no-store", signal });
        const answer = hello.ok ? ((await hello.json()) as { mac?: string }) : {};
        if (mine !== run) return;
        if (answer.mac !== (await sign("hello:" + n))) {
          set("unpaired");
          await sleep(5000);
          continue;
        }
      }
      set("connected");
      wait = 2000;
      const t = Date.now();
      // v: is this the tab the person is looking at? With several Slate tabs open, the bridge asks that one first.
      const v = document.visibilityState === "visible" ? 1 : 0;
      const res = await fetch(`${url}/poll?t=${t}&m=${await sign("poll:" + t)}&v=${v}`, { cache: "no-store", signal });
      if (mine !== run) return;
      if (res.status === 401) {
        set("unpaired");
        await sleep(5000);
        continue;
      }
      if (res.status === 200) {
        const got = (await res.json()) as { id: string; name: string; args: string; mac: string };
        // every call is signed; one that is not came from somewhere else and is dropped unread
        if (got.mac !== (await sign(`call:${got.id}:${got.name}:${got.args}`))) {
          set("unpaired");
          continue;
        }
        call = { id: got.id, name: got.name, input: JSON.parse(got.args) };
      }
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
      const t = Date.now();
      await fetch(url + "/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: call.id, ...result, t, m: await sign(`result:${call.id}:${t}`) }),
      });
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
  if (!validCode(bridgeCode()) || !crypto.subtle) return void set("unpaired");
  set("searching");
  hangUp = new AbortController();
  void loop(run, hangUp.signal);
}

export function setBridgeCode(code: string) {
  try {
    localStorage.setItem(CODE_KEY, code.trim());
  } catch {
    /* storage unavailable */
  }
  startBridge();
}

/** Does the program on the bridge port prove that it holds this code? */
async function bridgeHolds(code: string): Promise<boolean> {
  try {
    const n = randomHex();
    const res = await fetch(`${bridgeUrl()}/hello?n=${n}`, { cache: "no-store" });
    if (!res.ok) return false;
    const { mac } = (await res.json()) as { mac?: string };
    return mac === (await (await signer(code))("hello:" + n));
  } catch {
    return false;
  }
}

/**
 * The link Claude hands over ("…/#/pair/CODE"). Anyone can make such a link, so it is only a
 * request: the person is asked (and shown the end of the code, which Claude shows too), a code
 * that would replace an existing pairing gets a plain warning, and the code is kept only if the
 * program on this computer's bridge port proves it holds that very code.
 * Returns true when the address was such a link, whatever came of it.
 */
export function followPairLink(): boolean {
  const m = /^#\/pair\/([0-9A-Fa-f-]{16,19})$/.exec(location.hash);
  if (!m) return false;
  // out of the address bar and the history at once
  history.replaceState(null, "", location.pathname + location.search + "#/home");
  const code = m[1];
  if (!validCode(code) || !crypto.subtle) return true;
  // a page that some other page opened and can still steer is not the place to pair
  if (window.opener) return true;
  const tail = normalCode(code).slice(-4);
  const current = bridgeCode();
  const replacing = validCode(current) && normalCode(current) !== normalCode(code);
  const ok = window.confirm(
    (replacing
      ? "注意：這個 Slate 已經和這台電腦上的 Claude 配對過，這個連結卻帶著不同的配對碼。\n如果你沒有重新安裝 Claude 的 Slate 擴充功能，請按「取消」。\n\n"
      : "") +
      `要讓這台電腦上的 Claude 連進這個 Slate 嗎？（配對碼末四碼：${tail}，應該和 Claude 顯示的相同）\n\n` +
      "Claude 將可以讀取和修改這裡的筆記與任務；刪除前仍會先問你。\n只有在你剛從自己的 Claude 點了連結時才按確定。",
  );
  if (!ok) return true;
  void bridgeHolds(code).then((genuine) => {
    if (!genuine) {
      toast("沒有連上：這台電腦上找不到對應這個連結的 Claude 擴充功能。請確認 Claude 桌面版開著，再點一次連結。");
      return;
    }
    try {
      localStorage.setItem(CODE_KEY, code);
      localStorage.setItem(KEY, "1");
    } catch {
      /* storage unavailable */
    }
    startBridge();
    toast("已連接 Claude。現在可以回到 Claude 繼續。");
  });
  return true;
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
