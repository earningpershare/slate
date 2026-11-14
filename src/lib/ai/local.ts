// Every model that is not Claude: the hosted services in SERVICES (OpenAI, Gemini,
// OpenRouter, ...) and programs on the person's own computer (Ollama, LM Studio, ...).
// They all speak the OpenAI-style chat-completions format with tool calls, so one
// provider serves them all. Nothing here is specific to one vendor; Claude has its own
// provider in claude.ts.
import { AiError, type AiSettings, type Assistant, type Hooks, isLocalService, runTool, serviceName, stamp } from "./assistant";
import { SYSTEM_PROMPT, type Tool } from "./tools";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type Reply = { content: string; tool_calls: ToolCall[] };

const MAX_ROUNDS = 24; // tool-call rounds for one message: a small model can loop

/** Read a streamed reply: text goes to the panel as it arrives, tool calls are pieced together. */
async function readStream(res: Response, hooks: Hooks): Promise<Reply> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const calls: ToolCall[] = [];
  let content = "";
  let buffer = "";
  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; error?: { message?: string } };
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // a keep-alive or a partial line
    }
    if (chunk.error) throw new AiError("模型回報錯誤：" + (chunk.error.message ?? "未知的錯誤"));
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      hooks.onText(delta.content);
    }
    for (const [n, piece] of (delta.tool_calls ?? []).entries()) {
      // a call arrives in pieces that share an index; some services send it whole, without one
      const at = piece.index ?? (piece.id ? calls.length : Math.max(0, calls.length - 1 + n));
      const call = (calls[at] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.function.name += piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) take(line);
    if (done) break;
  }
  return { content, tool_calls: calls.filter(Boolean).map((c, n) => ({ ...c, id: c.id || `call_${Date.now()}_${n}` })) };
}

export function createLocal(settings: AiSettings, tools: Tool[]): Assistant {
  const base = settings.localUrl.trim().replace(/\/+$/, "");
  const local = isLocalService(settings.service);
  const who = serviceName(settings.service);
  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const definitions = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  // Hosted services stream; programs on the person's computer differ too much in how they stream tool calls.
  let stream = !local;

  const ask = async (hooks: Hooks): Promise<Reply> => {
    let res: Response;
    try {
      res = await fetch(base + "/chat/completions", {
        method: "POST",
        signal: hooks.signal,
        headers: { "content-type": "application/json", ...(settings.localKey.trim() ? { authorization: "Bearer " + settings.localKey.trim() } : {}) },
        body: JSON.stringify({ model: settings.localModel.trim(), messages: history, tools: definitions, stream }),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError(
        local
          ? `連不上 ${base}。請檢查三件事：一、模型程式有在執行；二、它允許這個網站連線（Ollama 要設定環境變數 OLLAMA_ORIGINS=${location.origin} 後重新啟動）；` +
              `三、瀏覽器問「是否允許這個網站連線到這台裝置上的應用程式」時要按允許（按錯的話，到網址列左邊的網站設定把「本機網路存取」改成允許）。`
          : `連不上 ${who}。請確認這台裝置有網路。`,
      );
    }
    if (!res.ok) {
      const raw = (await res.text().catch(() => "")).slice(0, 400);
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } | string } | { error?: { message?: string } }[];
        const err = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
        detail = (typeof err === "string" ? err : err?.message) ?? raw;
      } catch {
        /* not JSON */
      }
      // a service that will not stream tool calls: ask once more the plain way, and remember
      if (stream && res.status === 400 && /stream/i.test(detail)) {
        stream = false;
        return ask(hooks);
      }
      if (res.status === 401 || res.status === 403) throw new AiError(`${who} 不接受這把金鑰（無效、已停用，或沒有這個模型的權限）。請到模型設定檢查。`);
      if (res.status === 402 || /insufficient_quota|credit|billing|balance/i.test(detail)) throw new AiError(`${who} 的帳戶額度不足。請到它的網站儲值或檢查方案。（${detail}）`);
      if (res.status === 429) throw new AiError(`${who} 的用量達到上限了，請稍等一下再試。`);
      if (res.status === 404) throw new AiError(`找不到模型「${settings.localModel}」，或這個位址不是聊天接口。${detail}`);
      if (res.status === 400 && /tool|function/i.test(detail)) throw new AiError(`「${settings.localModel}」不支援工具呼叫，沒辦法操作 Slate。請換一個支援工具（tools／function calling）的模型。`);
      throw new AiError(`${who} 回報錯誤（${res.status}）：${detail}`);
    }
    if (res.body && /event-stream/i.test(res.headers.get("content-type") ?? "")) return readStream(res, hooks);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
    const message = body.choices?.[0]?.message;
    if (!message) throw new AiError("模型沒有回覆內容。");
    if (message.content) hooks.onText(message.content);
    return { content: message.content ?? "", tool_calls: message.tool_calls ?? [] };
  };

  return {
    async send(text, hooks) {
      history.push({ role: "user", content: `${stamp()}\n${text}` });
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const message = await ask(hooks);
        const calls = message.tool_calls;
        history.push({ role: "assistant", content: message.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (calls.length === 0) return;
        for (const call of calls) {
          let input: unknown;
          try {
            input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            history.push({ role: "tool", tool_call_id: call.id, content: "The arguments were not valid JSON. Send the call again with valid JSON." });
            continue;
          }
          const result = await runTool(tools, call.function.name, input, hooks);
          history.push({ role: "tool", tool_call_id: call.id, content: result.text });
        }
      }
      throw new AiError("模型一直在重複呼叫工具，已經先停下來。可以換個說法再試，或換一個較強的模型。");
    },
  };
}
