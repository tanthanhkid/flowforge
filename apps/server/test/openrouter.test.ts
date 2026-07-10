/**
 * SPEC-step2.md §9 — openrouter.test.ts. `fetch` fully mocked; `process.env`
 * only ever holds test-local dummy values (never the real OPENROUTER_API_KEY).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion } from '../src/nodes/providers/openrouter.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
});

describe('chatCompletion', () => {
  it('POSTs the expected url/headers/body and returns the message content', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-openrouter-key');
      expect(headers['X-Title']).toBe('FlowForge');

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('some/model');
      expect(body.messages).toEqual([
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hello' },
      ]);
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(100);

      return jsonResponse(200, { choices: [{ message: { content: 'hi there' } }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await chatCompletion({
      model: 'some/model',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.5,
      maxTokens: 100,
    });

    expect(result).toBe('hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error naming the model when content is empty/missing', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: '' } }] }),
    ) as unknown as typeof fetch;

    await expect(chatCompletion({ model: 'empty/model', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /empty\/model/,
    );
  });

  it('throws when choices/message is entirely missing from the response', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;

    await expect(chatCompletion({ model: 'missing/model', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /missing\/model/,
    );
  });
});
