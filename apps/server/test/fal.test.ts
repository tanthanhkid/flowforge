/**
 * SPEC-step2.md §9 — fal.test.ts. `fetch` fully mocked; FAL_KEY only ever a
 * test-local dummy value.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../src/engine/context.js';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import type { ExecutionContext, MediaValue } from '../src/engine/types.js';
import { mediaToImageUrl, runFalQueue } from '../src/nodes/providers/fal.js';
import { inputTextNode } from '../src/nodes/input.text.js';
import { falImageNode } from '../src/nodes/fal.image.js';
import { falVideoNode } from '../src/nodes/fal.video.js';

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

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const controller = new AbortController();
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    signal: controller.signal,
    artifactsDir: '/tmp/does-not-matter',
    log: () => {},
    saveArtifact: async () => 'fake-artifact.bin',
    poll: (check, opts) => poll(check, controller.signal, opts),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.FAL_KEY = 'test-fal-key-id:test-fal-key-secret';
});

describe('runFalQueue — full submit -> poll -> response flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the server-provided status_url/response_url (not the manually-built fallback) and returns the raw result JSON', async () => {
    const modelId = 'fal-ai/flux/dev';
    const submitUrl = `https://queue.fal.run/${modelId}`;
    const serverStatusUrl = 'https://queue.fal.run/fal-ai/flux/dev/custom-status-path';
    const serverResponseUrl = 'https://queue.fal.run/fal-ai/flux/dev/custom-response-path';
    const resultImageUrl = 'https://cdn.fal.ai/files/result123.png';

    let statusCall = 0;
    const statusSequence = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === submitUrl && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Key test-fal-key-id:test-fal-key-secret');
        expect(JSON.parse(init?.body as string)).toEqual({ prompt: 'a cat' });
        return jsonResponse(200, {
          request_id: 'req-1',
          status_url: serverStatusUrl,
          response_url: serverResponseUrl,
        });
      }
      if (url === `${serverStatusUrl}?logs=0`) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Key test-fal-key-id:test-fal-key-secret');
        const status = statusSequence[statusCall] ?? 'COMPLETED';
        statusCall += 1;
        return jsonResponse(200, { status });
      }
      if (url === serverResponseUrl) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Key test-fal-key-id:test-fal-key-secret');
        return jsonResponse(200, { images: [{ url: resultImageUrl }], seed: 42 });
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const promise = runFalQueue({ modelId, input: { prompt: 'a cat' }, ctx });
    await vi.advanceTimersByTimeAsync(30_000);
    const json = await promise;

    expect(json).toEqual({ images: [{ url: resultImageUrl }], seed: 42 });
    expect(statusCall).toBe(3);

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls).toContain(`${serverStatusUrl}?logs=0`);
    expect(calledUrls).toContain(serverResponseUrl);
    // The manually-built fallback URL shape must NOT be used since the
    // server provided its own status_url/response_url.
    expect(calledUrls.some((u) => u.includes(`${modelId}/requests/req-1`))).toBe(false);
  });

  it('throws an error containing the modelId when the queue reports a failed/unknown status', async () => {
    const modelId = 'fal-ai/some-model';
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        return jsonResponse(200, { request_id: 'req-2' });
      }
      if (url.includes('/requests/req-2/status')) {
        return jsonResponse(200, { status: 'FAILED' });
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    await expect(runFalQueue({ modelId, input: { prompt: 'x' }, ctx })).rejects.toThrow(
      new RegExp(modelId.replace(/[/\\]/g, '\\$&')),
    );
  });

  it('wraps an HTTP failure during submit with the modelId and a body snippet', async () => {
    const modelId = 'fal-ai/broken-model';
    globalThis.fetch = vi.fn(async () => jsonResponse(400, { error: 'bad model id' })) as unknown as typeof fetch;

    const ctx = makeCtx();
    await expect(runFalQueue({ modelId, input: {}, ctx })).rejects.toThrow(new RegExp(modelId.replace(/[/\\]/g, '\\$&')));
  });
});

describe('mediaToImageUrl', () => {
  it('returns an existing url as-is', async () => {
    const media: MediaValue = { kind: 'image', url: 'https://example.test/already-hosted.png' };
    const url = await mediaToImageUrl(media, '/unused');
    expect(url).toBe('https://example.test/already-hosted.png');
  });

  it('turns a local path into a base64 data URI with the correct mime', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-mediatourl-'));
    try {
      const bytes = Buffer.from([137, 80, 78, 71]); // arbitrary bytes, PNG-ish header
      writeFileSync(path.join(tmp, 'pic.png'), bytes);

      const media: MediaValue = { kind: 'image', path: 'pic.png' };
      const url = await mediaToImageUrl(media, tmp);

      expect(url).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fal.image node — end to end through the Engine (mocked fetch)', () => {
  it('produces a MediaValue whose artifact file actually exists on disk in a tmp artifactsDir', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-falimage-e2e-'));
    try {
      const modelId = 'fal-ai/flux/schnell';
      const resultImageUrl = 'https://cdn.fal.ai/files/e2e-result.png';
      const imageBytes = new Uint8Array([1, 2, 3, 4, 5]);

      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
          return jsonResponse(200, {
            request_id: 'e2e-req',
            status_url: 'https://queue.fal.run/e2e/status',
            response_url: 'https://queue.fal.run/e2e/response',
          });
        }
        if (url === 'https://queue.fal.run/e2e/status?logs=0') {
          return jsonResponse(200, { status: 'COMPLETED' });
        }
        if (url === 'https://queue.fal.run/e2e/response') {
          return jsonResponse(200, { images: [{ url: resultImageUrl }] });
        }
        if (url === resultImageUrl) {
          return binaryResponse(200, imageBytes, 'image/png');
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const registry = new NodeRegistry();
      registry.register(inputTextNode);
      registry.register(falImageNode);
      const engine = new Engine(
        registry,
        { runs: new InMemoryRunStore(), cache: new InMemoryCacheStore() },
        { artifactsDir: tmp },
      );

      const wf: Workflow = {
        version: 1,
        id: 'fal-image-e2e',
        name: '',
        nodes: [
          { id: 'in', type: 'input.text', params: { value: 'a cute robot' } },
          { id: 'img', type: 'fal.image', params: { modelId } },
        ],
        edges: [{ id: 'e1', from: { node: 'in', port: 'text' }, to: { node: 'img', port: 'prompt' } }],
      };

      const result = await engine.run(wf);
      expect(result.status).toBe('success');
      const media = result.nodes.img?.outputs?.image as MediaValue;
      expect(media.kind).toBe('image');
      expect(media.path).toBeDefined();
      expect(existsSync(path.join(tmp, media.path!))).toBe(true);
      expect(media.mime).toBe('image/png');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('maps imageSize/seed/image_url/extra into the submit body and populates MediaValue.meta from the response', async () => {
    const modelId = 'fal-ai/flux/dev';
    const resultImageUrl = 'https://cdn.fal.ai/files/mapping-result.jpg';
    const imageBytes = new Uint8Array([9, 8, 7]);
    let capturedSubmitBody: unknown;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        capturedSubmitBody = JSON.parse(init?.body as string);
        return jsonResponse(200, {
          request_id: 'mapping-req',
          status_url: 'https://queue.fal.run/mapping/status',
          response_url: 'https://queue.fal.run/mapping/response',
        });
      }
      if (url === 'https://queue.fal.run/mapping/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/mapping/response') {
        return jsonResponse(200, { images: [{ url: resultImageUrl }], seed: 555 });
      }
      if (url === resultImageUrl) {
        return binaryResponse(200, imageBytes, 'image/jpeg');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falImageNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId, imageSize: 'square_hd', seed: 7, extra: { guidance_scale: 3 } },
      ctx,
    });

    expect(capturedSubmitBody).toEqual({
      prompt: 'a cat',
      image_size: 'square_hd',
      seed: 7,
      image_url: 'https://example.test/ref.png',
      guidance_scale: 3,
    });

    const media = outputs.image as MediaValue;
    expect(media.meta).toEqual({ modelId, seed: 555, sourceUrl: resultImageUrl });
  });
});

describe('fal.video node — execute() directly (mocked fetch)', () => {
  it('maps duration/aspectRatio/extra to the submit body, falls back to videos[0].url, and polls with pollTimeoutMs=900_000', async () => {
    const modelId = 'fal-ai/kling-video/v2/master/text-to-video';
    const resultVideoUrl = 'https://cdn.fal.ai/files/video-result.mp4';
    const videoBytes = new Uint8Array([1, 2, 3, 4]);
    let capturedSubmitBody: unknown;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        capturedSubmitBody = JSON.parse(init?.body as string);
        return jsonResponse(200, {
          request_id: 'video-req',
          status_url: 'https://queue.fal.run/video/status',
          response_url: 'https://queue.fal.run/video/response',
        });
      }
      if (url === 'https://queue.fal.run/video/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/video/response') {
        // No top-level `video` key -> exercises the videos[0].url fallback.
        return jsonResponse(200, { videos: [{ url: resultVideoUrl }] });
      }
      if (url === resultVideoUrl) {
        return binaryResponse(200, videoBytes, 'video/mp4');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    let capturedPollOpts: { timeoutMs?: number } | undefined;
    const originalPoll = ctx.poll.bind(ctx);
    ctx.poll = ((check: Parameters<typeof originalPoll>[0], opts: Parameters<typeof originalPoll>[1]) => {
      capturedPollOpts = opts;
      return originalPoll(check, opts);
    }) as typeof ctx.poll;

    const outputs = await falVideoNode.execute({
      inputs: { prompt: 'a running dog' },
      params: { modelId, duration: 5, aspectRatio: '16:9', extra: { fps: 24 } },
      ctx,
    });

    expect(capturedSubmitBody).toEqual({
      prompt: 'a running dog',
      duration: 5,
      aspect_ratio: '16:9',
      fps: 24,
    });
    // Spec §7: fal.video must poll with a 900_000ms budget (video generation
    // is slower than image), not runFalQueue's 600_000ms default.
    expect(capturedPollOpts?.timeoutMs).toBe(900_000);

    const media = outputs.video as MediaValue;
    expect(media.kind).toBe('video');
    expect(media.mime).toBe('video/mp4');
    expect(media.meta).toEqual({ modelId, sourceUrl: resultVideoUrl });
  });
});
