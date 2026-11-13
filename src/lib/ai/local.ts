// A model running on the person's own computer (Ollama, LM Studio, llama.cpp, ...), or
// any other server that speaks the OpenAI-style chat-completions format with tool calls.
// Nothing here is specific to one vendor; Claude has its own provider in claude.ts.
import { AiError, type AiSettings, type Assistant, runTool, stamp } from "./assistant";
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

const MAX_ROUNDS = 16; // tool-call rounds for one message: a small model can loop

export function createLocal(settings: AiSettings, tools: Tool[]): Assistant {
  const base = settings.localUrl.trim().replace(/\/+$/, "");
  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const definitions = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));

  const ask = async (signal: AbortSignal) => {
    let res: Response;
    try {
      res = await fetch(base + "/chat/completions", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(settings.localKey.trim() ? { authorization: "Bearer " + settings.localKey.trim() } : {}) },
        body: JSON.stringify({ model: settings.localModel.trim(), messages: history, tools: definitions, stream: false }),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError(
        `連不上 ${base}。請檢查三件事：一、模型程式有在執行；二、它允許這個網站連線（Ollama 要設定環境變數 OLLAMA_ORIGINS=${location.origin} 後重新啟動）；` +
          `三、瀏覽器問「是否允許這個網站連線到這台裝置上的應用程式」時要按允許（按錯的話，到網址列左邊的網站設定把「本機網路存取」改成允許）。`,
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 404) throw new AiError(`找不到模型「${settings.localModel}」，或這個位址不是聊天接口。${detail}`);
      if (res.status === 400 && /tool/i.test(detail)) throw new AiError(`「${settings.localModel}」不支援工具呼叫，沒辦法操作 Slate。請換一個支援 tools 的模型（例如 qwen2.5、llama3.1、mistral-nemo）。`);
      throw new AiError(`模型回報錯誤（${res.status}）：${detail}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
    const message = body.choices?.[0]?.message;
    if (!message) throw new AiError("模型沒有回覆內容。");
    return message;
  };

  return {
    async send(text, hooks) {
      history.push({ role: "user", content: `${stamp()}\n${text}` });
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const message = await ask(hooks.signal);
        const calls = message.tool_calls ?? [];
        history.push({ role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (message.content) hooks.onText(message.content);
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
