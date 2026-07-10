/**
 * OpenRouter chat-completions client (SPEC-step2.md §4). Thin fetch wrapper
 * around `requestJson` — no SDK dependency.
 */
import { getEnv } from '../../config.js';
import { HttpError, requestJson } from '../../lib/http.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionArgs {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Wraps a raw HttpError/network error with the node/provider name + model id
 * + a remediation hint (SPEC-step2.md §7: every node's error message must
 * carry "tên node + nguyên nhân + gợi ý sửa"), mirroring wrapFalError /
 * wrapVbeeError in the fal/vbee provider clients. Without this, llm.generate
 * / llm.transform surfaced a bare "POST ... failed: HTTP 401 — {...}" with
 * no indication of which node/model failed or how to fix it.
 */
function wrapOpenRouterError(err: unknown, model: string): Error {
  if (err instanceof HttpError) {
    return new Error(
      `OpenRouter (model "${model}") thất bại: HTTP ${err.status ?? '?'} — ${err.bodySnippet ?? ''} — kiểm tra OPENROUTER_API_KEY hoặc model id.`,
    );
  }
  return err instanceof Error ? new Error(`OpenRouter (model "${model}"): ${err.message}`) : new Error(String(err));
}

export async function chatCompletion(args: ChatCompletionArgs): Promise<string> {
  const apiKey = getEnv('OPENROUTER_API_KEY');

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
  };
  if (args.maxTokens !== undefined) body.max_tokens = args.maxTokens;

  let json: OpenRouterResponse;
  try {
    const res = await requestJson<OpenRouterResponse>({
      url: OPENROUTER_URL,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'FlowForge',
      },
      body,
      timeoutMs: 120_000,
      retries: 2,
      signal: args.signal,
    });
    json = res.json;
  } catch (err) {
    throw wrapOpenRouterError(err, args.model);
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenRouter trả về rỗng cho model "${args.model}" — kiểm tra lại model id hoặc prompt.`);
  }
  return content;
}
