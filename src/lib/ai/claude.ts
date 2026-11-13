// Claude, called straight from the browser with the person's own API key.
// There is no server in between: the key and the conversation go from this device to
// Anthropic and nowhere else.
import Anthropic from "@anthropic-ai/sdk";
import { AiError, type AiSettings, type Assistant, runTool, stamp } from "./assistant";
import { SYSTEM_PROMPT, type Tool, validate } from "./tools";



const MAX_ROUNDS = 40; // tool-call rounds for one message
/** Models that can hand a declined request to another model on the server (Haiku cannot). */
const HAS_FALLBACK = /^claude-(opus|sonnet|fable|mythos)-/;

function explain(e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError("API 金鑰無效或已停用。請到模型設定重新貼上金鑰。");
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError("這把金鑰沒有使用這個模型的權限。可以到模型設定換一個模型。");
  if (e instanceof Anthropic.NotFoundError) return new AiError("找不到這個模型。請到模型設定換一個模型。");
  if (e instanceof Anthropic.RateLimitError) return new AiError("用量達到上限了，請稍等一下再試。");
  if (e instanceof Anthropic.BadRequestError) return new AiError("Anthropic 不接受這個請求：" + e.message);
  if (e instanceof Anthropic.APIConnectionError) return new AiError("連不上 Anthropic。請確認這台裝置有網路。");
  if (e instanceof Anthropic.APIError) return new AiError(`Anthropic 回報錯誤（${e.status ?? "?"}），請稍後再試。`);
  return e instanceof Error ? e : new Error(String(e));
}

export function createClaude(settings: AiSettings, tools: Tool[]): Assistant {
  const client = new Anthropic({
    apiKey: settings.claudeKey.trim(),
    // a key the person typed in themselves, on their own device: there is no server of ours to keep it on
    dangerouslyAllowBrowser: true,
  });
  const model = settings.claudeModel;
  const definitions: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
    eager_input_streaming: true, // long page bodies stream as they are written
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [];

  return {
    async send(text, hooks) {
      messages.push({ role: "user", content: `${stamp()}\n${text}` });
      let jsonRetries = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let message: Anthropic.Beta.BetaMessage;
        try {
          const stream = client.beta.messages.stream(
            {
              model,
              max_tokens: 64000,
              // tools and system never change, so every turn after the first reads them from the cache;
              // the top-level marker extends the cached part to the conversation so far
              system: SYSTEM_PROMPT,
              tools: definitions,
              cache_control: { type: "ephemeral" },
              thinking: { type: "adaptive" },
              output_config: { effort: "medium" },
              messages,
              // if the model declines for a policy reason, let the server retry on another model
              ...(HAS_FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
            },
            { signal: hooks.signal },
          );
          stream.on("text", (delta) => hooks.onText(delta));
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (e) {
          // with eager input streaming, a tool input that is not JSON at all rejects here: ask again
          if (e instanceof Anthropic.APIError || hooks.signal.aborted || jsonRetries++ >= 2) throw explain(e);
          continue;
        }

        if (message.stop_reason === "refusal") throw new AiError("模型拒絕了這個要求。換個說法，或把你想做的事講得更具體一點。");
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason === "max_tokens" && calls.length) throw new AiError("回覆太長被截斷了，沒有執行任何動作。請把要求拆小一點再試。");
        messages.push({ role: "assistant", content: message.content });
        if (calls.length === 0) return;

        // every call of the turn is answered in one message, failures included
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          const tool = tools.find((t) => t.name === call.name);
          // eager streaming skips the server's own check, so a cut-off input is caught here
          if (tool && validate(tool, call.input).length) {
            results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), problems: validate(tool, call.input) }) });
            continue;
          }
          const result = await runTool(tools, call.name, call.input, hooks);
          results.push({ type: "tool_result", tool_use_id: call.id, content: result.text, ...(result.error ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        if (hooks.signal.aborted) throw new Anthropic.APIUserAbortError();
      }
      throw new AiError("這件事做了很多步還沒完成，已經先停下來。可以說「繼續」讓它接著做。");
    },
  };
}
