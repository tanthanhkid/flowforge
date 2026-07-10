/**
 * SPEC-step2.md §9 — vbee.test.ts. `fetch` fully mocked; VBEE_TOKEN/VBEE_APP_ID
 * only ever test-local dummy values (never the real Vbee credentials).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../src/engine/context.js';
import type { ExecutionContext } from '../src/engine/types.js';
import { ttsAsync } from '../src/nodes/providers/vbee.js';

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

function makeCtx(): ExecutionContext {
  const controller = new AbortController();
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    signal: controller.signal,
    artifactsDir: '/tmp/does-not-matter',
    log: () => {},
    saveArtifact: async () => 'fake.mp3',
    poll: (check, opts) => poll(check, controller.signal, opts),
  };
}

beforeEach(() => {
  process.env.VBEE_TOKEN = 'test-vbee-token';
  process.env.VBEE_APP_ID = 'test-vbee-app-id';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const SUBMIT_URL = 'https://api.vbee.vn/v1/tts';
const STATUS_URL = 'https://api.vbee.vn/v1/tts/requests/req-1';

describe('ttsAsync', () => {
  it('submits the correct body/headers, polls PROCESSING -> SUCCESS+audioLink, and downloads immediately', async () => {
    const audioLink = 'https://cdn.vbee.vn/audio/req-1.mp3';
    const audioBytes = new Uint8Array([9, 9, 9]);
    let statusCall = 0;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === SUBMIT_URL && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-vbee-token');
        expect(headers['App-Id']).toBe('test-vbee-app-id');

        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          text: 'Xin chào',
          voiceCode: 'hn_female_ngochuyen_full_48k-fhg',
          mode: 'async',
          webhookUrl: 'https://example.com/vbee-callback',
          outputFormat: 'mp3',
          bitrate: 128,
          speed: 1,
        });

        return jsonResponse(200, { requestId: 'req-1' });
      }

      if (url === STATUS_URL && method === 'GET') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-vbee-token');
        expect(headers['App-Id']).toBe('test-vbee-app-id');

        statusCall += 1;
        if (statusCall === 1) return jsonResponse(200, { status: 'PROCESSING' });
        return jsonResponse(200, { status: 'SUCCESS', audioLink });
      }

      if (url === audioLink && method === 'GET') {
        return binaryResponse(200, audioBytes, 'audio/mpeg');
      }

      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const promise = ttsAsync({
      text: 'Xin chào',
      voiceCode: 'hn_female_ngochuyen_full_48k-fhg',
      speed: 1,
      format: 'mp3',
      bitrate: 128,
      ctx,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const { data, contentType } = await promise;

    expect(statusCall).toBe(2);
    expect(contentType).toBe('audio/mpeg');
    expect(Buffer.from(audioBytes).equals(data)).toBe(true);
  });

  it('throws when the request ends up FAILED', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === SUBMIT_URL && method === 'POST') return jsonResponse(200, { requestId: 'req-fail' });
      if (url.includes('/requests/req-fail')) return jsonResponse(200, { status: 'FAILED' });
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const promise = ttsAsync({ text: 'x', voiceCode: 'v', speed: 1, format: 'mp3', bitrate: 128, ctx });
    await expect(promise).rejects.toThrow(/FAILED|thất bại/i);
  });

  it('throws a clear error when the submit response is missing requestId', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;

    const ctx = makeCtx();
    await expect(ttsAsync({ text: 'x', voiceCode: 'v', speed: 1, format: 'mp3', bitrate: 128, ctx })).rejects.toThrow(
      /requestId/,
    );
  });
});
