/**
 * SPEC-step2.md §9 — e2e-mocked.test.ts.
 * Workflow input.text -> llm.transform -> vbee.tts, run through the real
 * Engine with `fetch` mocked (OpenRouter + Vbee). Second run must be a full
 * cache hit with zero additional fetch calls.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import type { MediaValue } from '../src/engine/types.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

function binaryResponse(status: number, bytes: Uint8Array, contentType: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer,
    text: async () => '',
    headers: { get: (key: string) => (key.toLowerCase() === 'content-type' ? contentType : null) } as unknown as Headers,
  } as unknown as Response;
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.VBEE_TOKEN = 'test-vbee-token';
  process.env.VBEE_APP_ID = 'test-vbee-app-id';
});

describe('e2e: input.text -> llm.transform -> vbee.tts (mocked)', () => {
  it('runs successfully, saves a real audio artifact, and fully cache-hits on re-run with no extra fetch calls', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));
    try {
      const audioLink = 'https://cdn.vbee.vn/audio/e2e.mp3';
      const audioBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);

      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';

        if (url === 'https://openrouter.ai/api/v1/chat/completions' && method === 'POST') {
          // Assert llm.transform's spec'd message construction (SPEC-step2.md
          // §7: fixed system prompt + "Instruction: {instruction}\n\nText:\n{text}")
          // — otherwise this is the only place llm.transform ever runs and a
          // regression here (e.g. swapped instruction/text, dropped system
          // message) would go unnoticed.
          const body = JSON.parse(init?.body as string);
          expect(body.model).toBe('test/dummy-model'); // setup.ts's OPENROUTER_DEFAULT_MODEL dummy
          expect(body.messages).toEqual([
            { role: 'system', content: 'Bạn là công cụ biến đổi văn bản. Chỉ trả về văn bản kết quả, không giải thích.' },
            { role: 'user', content: 'Instruction: uppercase it\n\nText:\nhello' },
          ]);
          return jsonResponse(200, { choices: [{ message: { content: 'XIN CHAO' } }] });
        }
        if (url === 'https://api.vbee.vn/v1/tts' && method === 'POST') {
          return jsonResponse(200, { requestId: 'e2e-req' });
        }
        if (url === 'https://api.vbee.vn/v1/tts/requests/e2e-req' && method === 'GET') {
          return jsonResponse(200, { status: 'SUCCESS', audioLink });
        }
        if (url === audioLink && method === 'GET') {
          return binaryResponse(200, audioBytes, 'audio/mpeg');
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const registry = createDefaultRegistry();
      const engine = new Engine(
        registry,
        { runs: new InMemoryRunStore(), cache: new InMemoryCacheStore() },
        { artifactsDir: tmp },
      );

      const wf: Workflow = {
        version: 1,
        id: 'e2e-wf',
        name: '',
        nodes: [
          { id: 'in', type: 'input.text', params: { value: 'hello' } },
          { id: 'transform', type: 'llm.transform', params: { instruction: 'uppercase it' } },
          { id: 'tts', type: 'vbee.tts', params: {} },
        ],
        edges: [
          { id: 'e1', from: { node: 'in', port: 'text' }, to: { node: 'transform', port: 'text' } },
          { id: 'e2', from: { node: 'transform', port: 'text' }, to: { node: 'tts', port: 'text' } },
        ],
      };

      // --- Run 1: everything executes for real. ---
      const result1 = await engine.run(wf);
      expect(result1.status).toBe('success');
      expect(result1.nodes.in?.state).toBe('success');
      expect(result1.nodes.transform?.state).toBe('success');
      expect(result1.nodes.tts?.state).toBe('success');
      expect(result1.nodes.in?.cached).toBe(false);
      expect(result1.nodes.transform?.cached).toBe(false);
      expect(result1.nodes.tts?.cached).toBe(false);

      const media1 = result1.nodes.tts?.outputs?.audio as MediaValue;
      expect(media1.kind).toBe('audio');
      expect(media1.path).toBeDefined();
      const artifactPath = path.join(tmp, media1.path!);
      expect(existsSync(artifactPath)).toBe(true);

      const callsAfterRun1 = fetchMock.mock.calls.length;
      expect(callsAfterRun1).toBeGreaterThan(0);

      // --- Run 2: identical workflow -> every node should be a cache hit. ---
      const result2 = await engine.run(wf);
      expect(result2.status).toBe('success');
      expect(result2.nodes.in?.cached).toBe(true);
      expect(result2.nodes.transform?.cached).toBe(true);
      expect(result2.nodes.tts?.cached).toBe(true);

      const media2 = result2.nodes.tts?.outputs?.audio as MediaValue;
      expect(media2).toEqual(media1);

      expect(fetchMock.mock.calls.length).toBe(callsAfterRun1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
