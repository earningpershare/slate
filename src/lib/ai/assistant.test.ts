import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConfigured, listModels, loadSettings, saveSettings, SERVICES, withService } from "./assistant";

// a stand-in for the browser's storage
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("model settings", () => {
  it("start on Claude with nothing filled in", () => {
    const s = loadSettings();
    expect(s).toMatchObject({ service: "anthropic", provider: "claude", claudeModel: "claude-opus-5-5" });
    expect(isConfigured(s)).toBe(false);
    expect(isConfigured({ ...s, claudeKey: "sk-ant-x" })).toBe(true);
  });

  it("a hosted service needs a key and a model; its address comes with it", () => {
    let s = withService(loadSettings(), "openai");
    expect(s).toMatchObject({ provider: "local", localUrl: "https://api.openai.com/v1", localKey: "", localModel: "" });
    expect(isConfigured(s)).toBe(false);
    s = { ...s, localKey: "sk-openai" };
    expect(isConfigured(s)).toBe(false); // no model yet
    expect(isConfigured({ ...s, localModel: "gpt-x" })).toBe(true);
  });

  it("a model on the computer needs no key", () => {
    const s = { ...withService(loadSettings(), "ollama"), localModel: "qwen2.5" };
    expect(s.localUrl).toBe("http://localhost:11434/v1");
    expect(isConfigured(s)).toBe(true);
  });

  it("switching between services brings back what each was using", () => {
    let s = { ...loadSettings(), claudeKey: "sk-ant-1" };
    s = { ...withService(s, "openai"), localKey: "sk-openai", localModel: "gpt-x" };
    s = { ...withService(s, "gemini"), localKey: "AIza-1", localModel: "gemini-x" };
    s = withService(s, "openai");
    expect(s).toMatchObject({ localKey: "sk-openai", localModel: "gpt-x", localUrl: "https://api.openai.com/v1" });
    s = withService(s, "anthropic");
    expect(s).toMatchObject({ provider: "claude", claudeKey: "sk-ant-1" });
    s = withService(s, "gemini");
    expect(s).toMatchObject({ localKey: "AIza-1", localModel: "gemini-x" }); // one service's key never ends up at another
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it("settings saved by an older version still open", () => {
    store.set("ai-settings", JSON.stringify({ provider: "local", localUrl: "http://localhost:11434/v1", localModel: "llama3.1", localKey: "", claudeKey: "", claudeModel: "claude-opus-5-5" }));
    expect(loadSettings()).toMatchObject({ service: "ollama", provider: "local", localModel: "llama3.1" });
    store.set("ai-settings", JSON.stringify({ provider: "local", localUrl: "http://192.168.1.5:8080/v1", localModel: "m" }));
    expect(loadSettings()).toMatchObject({ service: "local-custom", provider: "local" });
    store.set("ai-settings", JSON.stringify({ provider: "claude", claudeKey: "k" }));
    expect(loadSettings()).toMatchObject({ service: "anthropic", provider: "claude", claudeKey: "k" });
    store.set("ai-settings", "not json");
    expect(loadSettings().service).toBe("anthropic");
  });

  it("every hosted service has a secure address and a place to get a key", () => {
    for (const s of SERVICES) {
      if (s.id === "anthropic" || s.id === "custom") continue;
      expect(s.url).toMatch(/^https:\/\/[a-z0-9.-]+\//);
      expect(s.keys).toMatch(/^[a-z0-9.-]+(\/|$)/);
    }
    expect(new Set(SERVICES.map((s) => s.id)).size).toBe(SERVICES.length);
  });
});

describe("listing a service's models", () => {
  const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("keeps chat models, drops the rest, and sends the key as a bearer token", async () => {
    answer(200, { data: [{ id: "gpt-x" }, { id: "text-embedding-3" }, { id: "whisper-1" }, { id: "models/gemini-x" }, { id: "gpt-x" }, { id: "dall-e-3" }, { id: "a-mini" }] });
    expect(await listModels("https://api.example.com/v1/", " sk-1 ")).toEqual(["a-mini", "gemini-x", "gpt-x"]);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/models");
    expect(init.headers).toEqual({ authorization: "Bearer sk-1" });
  });

  it("understands a bare list, and sends no header without a key", async () => {
    answer(200, [{ id: "llama" }, { id: "nomic-embed-text" }]);
    expect(await listModels("http://localhost:11434/v1", "")).toEqual(["llama"]);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers).toEqual({});
  });

  it("says plainly when the key is refused or the address is wrong", async () => {
    answer(401, { error: "no" });
    await expect(listModels("https://x/v1", "bad")).rejects.toThrow("金鑰無效");
    answer(500, {});
    await expect(listModels("https://x/v1", "k")).rejects.toThrow("讀不到模型清單（500）");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(listModels("https://x/v1", "k")).rejects.toThrow("連不上這個位址");
  });
});
