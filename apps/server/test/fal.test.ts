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
import { mediaToImageUrl, runFalQueue, uploadToFal } from '../src/nodes/providers/fal.js';
import { inputImageNode } from '../src/nodes/input.image.js';
import { inputTextNode } from '../src/nodes/input.text.js';
import { falImageNode, setLiveImageCatalog } from '../src/nodes/fal.image.js';
import { falVideoNode, setFalVideoLiveCatalog } from '../src/nodes/fal.video.js';

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

// SPEC-step33.md §33a — `uploadToFal` (fal storage upload: initiate -> PUT
// -> file_url), used by `video.transcribe` to hand fal.ai's queue API a
// real URL for a multi-MB audio file instead of a base64 data URI.
describe('uploadToFal', () => {
  it('POSTs initiate with Authorization + content_type/file_name, PUTs the bytes to upload_url, and returns file_url', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    let capturedInitiateBody: unknown;
    let capturedInitiateHeaders: Record<string, string> | undefined;
    let capturedPutBody: unknown;
    let capturedPutHeaders: Record<string, string> | undefined;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3' && method === 'POST') {
        capturedInitiateBody = JSON.parse(init?.body as string);
        capturedInitiateHeaders = init?.headers as Record<string, string>;
        return jsonResponse(200, {
          file_url: 'https://cdn.fal.ai/files/uploaded-audio.mp3',
          upload_url: 'https://storage.fal.ai/upload/signed-put-url',
        });
      }
      if (url === 'https://storage.fal.ai/upload/signed-put-url' && method === 'PUT') {
        capturedPutBody = init?.body;
        capturedPutHeaders = init?.headers as Record<string, string>;
        return { ok: true, status: 200, text: async () => '' } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const url = await uploadToFal(bytes, 'audio.mp3', 'audio/mpeg', ctx);

    expect(url).toBe('https://cdn.fal.ai/files/uploaded-audio.mp3');
    expect(capturedInitiateBody).toEqual({ content_type: 'audio/mpeg', file_name: 'audio.mp3' });
    expect(capturedInitiateHeaders?.Authorization).toBe('Key test-fal-key-id:test-fal-key-secret');
    expect(capturedPutBody).toBe(bytes);
    expect(capturedPutHeaders?.['Content-Type']).toBe('audio/mpeg');
  });

  it('throws a clear error when initiate fails (HTTP error)', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(401, { error: 'bad key' })) as unknown as typeof fetch;

    const ctx = makeCtx();
    await expect(uploadToFal(Buffer.from([1]), 'x.mp3', 'audio/mpeg', ctx)).rejects.toThrow(/storage upload/);
  });

  it('throws a clear error when initiate response is missing file_url/upload_url', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;

    const ctx = makeCtx();
    await expect(uploadToFal(Buffer.from([1]), 'x.mp3', 'audio/mpeg', ctx)).rejects.toThrow(/file_url/);
  });

  it('throws a clear error when the PUT upload fails', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3' && method === 'POST') {
        return jsonResponse(200, { file_url: 'https://cdn.fal.ai/files/x.mp3', upload_url: 'https://storage.fal.ai/put' });
      }
      if (url === 'https://storage.fal.ai/put' && method === 'PUT') {
        return { ok: false, status: 500, text: async () => 'server error' } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    await expect(uploadToFal(Buffer.from([1]), 'x.mp3', 'audio/mpeg', ctx)).rejects.toThrow(/storage upload/);
  });

  it('respects abort (ctx.signal) during the initiate call', async () => {
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });
    controller.abort();

    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    await expect(uploadToFal(Buffer.from([1]), 'x.mp3', 'audio/mpeg', ctx)).rejects.toThrow();
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
    // Not "fal-ai/flux/dev" on purpose (SPEC-step29.md §3): that preset is
    // now marked t2i, and the new t2i+image guard would throw before this
    // test ever reaches the param-mapping assertions below. A custom/
    // uncatalogued id keeps `imageKind` unknown, same as before this step.
    const modelId = 'fal-ai/custom-mapping-model';
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

// SPEC-step17.md — guard against silently-billed text-to-video runs that
// ignore a connected image input (real money wasted bug report).
describe('fal.video node — t2v + image guard (SPEC-step17.md)', () => {
  it('throws BEFORE calling fetch when the catalog modelId is a text-to-video preset and an image is connected', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };

    await expect(
      falVideoNode.execute({
        inputs: { prompt: 'a cat', image },
        params: { modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video' },
        ctx,
      }),
    ).rejects.toThrow(/là text-to-video nên sẽ bỏ qua ảnh đầu vào/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes the same-family image-to-video suggestion when the catalog has one', async () => {
    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };

    await expect(
      falVideoNode.execute({
        inputs: { prompt: 'a cat', image },
        params: { modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video' },
        ctx,
      }),
    ).rejects.toThrow('fal-ai/kling-video/v2.5-turbo/pro/image-to-video');
  });

  it('does not throw and does submit image_url for a catalog image-to-video model + image', async () => {
    const modelId = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';
    const resultVideoUrl = 'https://cdn.fal.ai/files/i2v-result.mp4';
    const videoBytes = new Uint8Array([1, 2, 3]);
    let capturedSubmitBody: unknown;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        capturedSubmitBody = JSON.parse(init?.body as string);
        return jsonResponse(200, {
          request_id: 'i2v-req',
          status_url: 'https://queue.fal.run/i2v/status',
          response_url: 'https://queue.fal.run/i2v/response',
        });
      }
      if (url === 'https://queue.fal.run/i2v/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/i2v/response') {
        return jsonResponse(200, { video: { url: resultVideoUrl } });
      }
      if (url === resultVideoUrl) {
        return binaryResponse(200, videoBytes, 'video/mp4');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falVideoNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId },
      ctx,
    });

    expect((capturedSubmitBody as Record<string, unknown>).image_url).toBe('https://example.test/ref.png');
    expect((outputs.video as MediaValue).kind).toBe('video');
  });

  it('does not throw for a custom (non-catalog) modelId + image — unchanged behavior', async () => {
    const modelId = 'fal-ai/some-custom-video-model';
    const resultVideoUrl = 'https://cdn.fal.ai/files/custom-result.mp4';
    const videoBytes = new Uint8Array([4, 5, 6]);
    let capturedSubmitBody: unknown;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        capturedSubmitBody = JSON.parse(init?.body as string);
        return jsonResponse(200, {
          request_id: 'custom-req',
          status_url: 'https://queue.fal.run/custom/status',
          response_url: 'https://queue.fal.run/custom/response',
        });
      }
      if (url === 'https://queue.fal.run/custom/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/custom/response') {
        return jsonResponse(200, { video: { url: resultVideoUrl } });
      }
      if (url === resultVideoUrl) {
        return binaryResponse(200, videoBytes, 'video/mp4');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falVideoNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId },
      ctx,
    });

    expect((capturedSubmitBody as Record<string, unknown>).image_url).toBe('https://example.test/ref.png');
    expect((outputs.video as MediaValue).kind).toBe('video');
  });
});

// SPEC-step19.md §1.6 — the t2v/i2v guard also consults the live-merged
// catalog (pushed in by routes/modelCatalog.ts via setFalVideoLiveCatalog)
// once it's been populated, so it also blocks a live-only t2v id that isn't
// in the hand-curated static preset list.
describe('fal.video node — t2v + image guard against the live catalog (SPEC-step19.md §1.6)', () => {
  afterEach(() => {
    // Reset so this describe block never leaks its pushed catalog into
    // another test in this file (each `it` above assumes the pre-step-19
    // static-only default).
    setFalVideoLiveCatalog(undefined);
  });

  it('throws for a live-only (non-preset) t2v modelId + image, once a live catalog has been pushed', async () => {
    setFalVideoLiveCatalog([
      { id: 'fal-ai/brand-new/text-to-video', label: 'Brand New T2V', kind: 'video-t2v', tier: 're', estUsd: 0.2, estBasis: 'x', createdAt: null, featured: false },
    ]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };

    await expect(
      falVideoNode.execute({
        inputs: { prompt: 'a cat', image },
        params: { modelId: 'fal-ai/brand-new/text-to-video' },
        ctx,
      }),
    ).rejects.toThrow(/là text-to-video nên sẽ bỏ qua ảnh đầu vào/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suggests the live-catalog same-family image-to-video sibling when there is no static-preset sibling', async () => {
    setFalVideoLiveCatalog([
      { id: 'fal-ai/brand-new/text-to-video', label: 'Brand New T2V', kind: 'video-t2v', tier: 're', estUsd: 0.2, estBasis: 'x', createdAt: null, featured: false },
      { id: 'fal-ai/brand-new/image-to-video', label: 'Brand New I2V', kind: 'video-i2v', tier: 're', estUsd: 0.2, estBasis: 'x', createdAt: null, featured: false },
    ]);
    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };

    await expect(
      falVideoNode.execute({
        inputs: { prompt: 'a cat', image },
        params: { modelId: 'fal-ai/brand-new/text-to-video' },
        ctx,
      }),
    ).rejects.toThrow('fal-ai/brand-new/image-to-video');
  });

  it('a live-only (non-preset) i2v modelId + image does not throw', async () => {
    const modelId = 'fal-ai/brand-new/image-to-video';
    const resultVideoUrl = 'https://cdn.fal.ai/files/live-i2v-result.mp4';
    const videoBytes = new Uint8Array([7, 8, 9]);

    setFalVideoLiveCatalog([{ id: modelId, label: 'Brand New I2V', kind: 'video-i2v', tier: 're', estUsd: 0.2, estBasis: 'x', createdAt: null, featured: false }]);

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'live-i2v-req',
          status_url: 'https://queue.fal.run/live-i2v/status',
          response_url: 'https://queue.fal.run/live-i2v/response',
        });
      }
      if (url === 'https://queue.fal.run/live-i2v/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/live-i2v/response') {
        return jsonResponse(200, { video: { url: resultVideoUrl } });
      }
      if (url === resultVideoUrl) {
        return binaryResponse(200, videoBytes, 'video/mp4');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falVideoNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId },
      ctx,
    });
    expect((outputs.video as MediaValue).kind).toBe('video');
  });

  it('still does not throw for a modelId unknown to both the static preset AND the pushed live catalog', async () => {
    setFalVideoLiveCatalog([
      { id: 'fal-ai/brand-new/text-to-video', label: 'Brand New T2V', kind: 'video-t2v', tier: 're', estUsd: 0.2, estBasis: 'x', createdAt: null, featured: false },
    ]);
    const modelId = 'fal-ai/some-other-custom-model';
    const resultVideoUrl = 'https://cdn.fal.ai/files/still-custom-result.mp4';
    const videoBytes = new Uint8Array([1, 1, 1]);

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'still-custom-req',
          status_url: 'https://queue.fal.run/still-custom/status',
          response_url: 'https://queue.fal.run/still-custom/response',
        });
      }
      if (url === 'https://queue.fal.run/still-custom/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/still-custom/response') {
        return jsonResponse(200, { video: { url: resultVideoUrl } });
      }
      if (url === resultVideoUrl) {
        return binaryResponse(200, videoBytes, 'video/mp4');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falVideoNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId },
      ctx,
    });
    expect((outputs.video as MediaValue).kind).toBe('video');
  });
});

// SPEC-step29.md §3 — guard against silently-billed text-to-image runs that
// ignore a connected reference image (real 2026-07-13 session: the agent
// picked t2i "fal-ai/flux/dev" for 4 fal.image nodes that each had an image
// edge wired in — each run "succeeded" but threw the input image away).
describe('fal.image node — t2i + image guard (SPEC-step29.md §3)', () => {
  afterEach(() => {
    // Reset so this describe block never leaks its pushed catalog into
    // another test in this file.
    setLiveImageCatalog(undefined);
  });

  it('throws BEFORE calling fetch when the catalog modelId is a t2i preset and an image is connected', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };

    await expect(
      falImageNode.execute({
        inputs: { prompt: 'xoá vật thể trong ảnh', image },
        params: { modelId: 'fal-ai/flux/dev' },
        ctx,
      }),
    ).rejects.toThrow(/là text-to-image nên sẽ bỏ qua ảnh đầu vào/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // None of the 12 static image presets are i2i today (falModels.ts §2 —
  // every FLUX/Recraft/Imagen4/... preset here is a base text-to-image
  // endpoint), so the "up to 2 i2i suggestions" guard rule can only be
  // exercised against the live-merged catalog snapshot in this test suite —
  // exactly the fallback path SPEC-step29.md §3 describes.
  it('includes up to 2 i2i suggestions from the live catalog (capped, in order) when no static preset is i2i', async () => {
    setLiveImageCatalog([
      { id: 'fal-ai/flux-pro/kontext', label: 'FLUX Kontext', kind: 'image', tier: 'xin', estUsd: 0.04, estBasis: 'x', createdAt: null, featured: false, imageKind: 'i2i' },
      { id: 'fal-ai/qwen-image-edit', label: 'Qwen Image Edit', kind: 'image', tier: 'kha', estUsd: 0.03, estBasis: 'x', createdAt: null, featured: false, imageKind: 'i2i' },
      { id: 'fal-ai/some-third-i2i-model', label: 'Third', kind: 'image', tier: 're', estUsd: 0.01, estBasis: 'x', createdAt: null, featured: false, imageKind: 'i2i' },
    ]);

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const error = await falImageNode
      .execute({ inputs: { prompt: 'a cat', image }, params: { modelId: 'fal-ai/flux/dev' }, ctx })
      .catch((e: unknown) => e as Error);

    expect(error.message).toContain('fal-ai/flux-pro/kontext');
    expect(error.message).toContain('fal-ai/qwen-image-edit');
    expect(error.message).not.toContain('fal-ai/some-third-i2i-model'); // capped at 2
  });

  it('omits the suggestion clause entirely when neither the static preset nor the live catalog has an i2i model', async () => {
    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const error = await falImageNode
      .execute({ inputs: { prompt: 'a cat', image }, params: { modelId: 'fal-ai/flux/dev' }, ctx })
      .catch((e: unknown) => e as Error);

    expect(error.message).toBe(
      'Model "fal-ai/flux/dev" là text-to-image nên sẽ bỏ qua ảnh đầu vào. Chọn model image-to-image hoặc ngắt kết nối ảnh.',
    );
  });

  it('does not throw and submits image_url for an i2i model (live-tagged) + image', async () => {
    const modelId = 'fal-ai/flux-pro/kontext';
    setLiveImageCatalog([
      { id: modelId, label: 'FLUX Kontext', kind: 'image', tier: 'xin', estUsd: 0.04, estBasis: 'x', createdAt: null, featured: false, imageKind: 'i2i' },
    ]);
    const resultImageUrl = 'https://cdn.fal.ai/files/i2i-result.png';
    const imageBytes = new Uint8Array([1, 2, 3]);
    let capturedSubmitBody: unknown;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        capturedSubmitBody = JSON.parse(init?.body as string);
        return jsonResponse(200, {
          request_id: 'i2i-req',
          status_url: 'https://queue.fal.run/i2i/status',
          response_url: 'https://queue.fal.run/i2i/response',
        });
      }
      if (url === 'https://queue.fal.run/i2i/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/i2i/response') {
        return jsonResponse(200, { images: [{ url: resultImageUrl }] });
      }
      if (url === resultImageUrl) {
        return binaryResponse(200, imageBytes, 'image/png');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falImageNode.execute({
      inputs: { prompt: 'xoá vật thể trong ảnh', image },
      params: { modelId },
      ctx,
    });

    expect((capturedSubmitBody as Record<string, unknown>).image_url).toBe('https://example.test/ref.png');
    expect((outputs.image as MediaValue).kind).toBe('image');
  });

  it('does not throw for a custom (non-catalog) modelId + image — unchanged behavior', async () => {
    const modelId = 'fal-ai/some-custom-image-model';
    const resultImageUrl = 'https://cdn.fal.ai/files/custom-result.png';
    const imageBytes = new Uint8Array([4, 5, 6]);

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'custom-req',
          status_url: 'https://queue.fal.run/custom-img/status',
          response_url: 'https://queue.fal.run/custom-img/response',
        });
      }
      if (url === 'https://queue.fal.run/custom-img/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/custom-img/response') {
        return jsonResponse(200, { images: [{ url: resultImageUrl }] });
      }
      if (url === resultImageUrl) {
        return binaryResponse(200, imageBytes, 'image/png');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falImageNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId },
      ctx,
    });

    expect((outputs.image as MediaValue).kind).toBe('image');
  });

  it('does not throw for a t2i model when no image is connected', async () => {
    const modelId = 'fal-ai/flux/dev';
    const resultImageUrl = 'https://cdn.fal.ai/files/no-image-result.png';
    const imageBytes = new Uint8Array([7, 8, 9]);

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'no-image-req',
          status_url: 'https://queue.fal.run/no-image/status',
          response_url: 'https://queue.fal.run/no-image/response',
        });
      }
      if (url === 'https://queue.fal.run/no-image/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/no-image/response') {
        return jsonResponse(200, { images: [{ url: resultImageUrl }] });
      }
      if (url === resultImageUrl) {
        return binaryResponse(200, imageBytes, 'image/png');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const outputs = await falImageNode.execute({
      inputs: { prompt: 'a cat' },
      params: { modelId },
      ctx,
    });

    expect((outputs.image as MediaValue).kind).toBe('image');
  });
});

// SPEC-step19.md §1.6 style — the t2i/i2i guard also consults the
// live-merged catalog (pushed in by routes/modelCatalog.ts via
// setLiveImageCatalog) once it's been populated, so it also blocks a
// live-only t2i id that isn't in the hand-curated static preset list.
describe('fal.image node — t2i + image guard against the live catalog (SPEC-step29.md §3)', () => {
  afterEach(() => {
    setLiveImageCatalog(undefined);
  });

  it('throws for a live-only (non-preset) t2i modelId + image, once a live catalog has been pushed', async () => {
    setLiveImageCatalog([
      { id: 'fal-ai/brand-new/t2i-model', label: 'Brand New T2I', kind: 'image', tier: 're', estUsd: 0.02, estBasis: 'x', createdAt: null, featured: false, imageKind: 't2i' },
    ]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };

    await expect(
      falImageNode.execute({
        inputs: { prompt: 'a cat', image },
        params: { modelId: 'fal-ai/brand-new/t2i-model' },
        ctx,
      }),
    ).rejects.toThrow(/là text-to-image nên sẽ bỏ qua ảnh đầu vào/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still does not throw for a modelId unknown to both the static preset AND the pushed live catalog', async () => {
    setLiveImageCatalog([
      { id: 'fal-ai/brand-new/t2i-model', label: 'Brand New T2I', kind: 'image', tier: 're', estUsd: 0.02, estBasis: 'x', createdAt: null, featured: false, imageKind: 't2i' },
    ]);
    const modelId = 'fal-ai/some-other-custom-image-model';
    const resultImageUrl = 'https://cdn.fal.ai/files/still-custom-result.png';
    const imageBytes = new Uint8Array([1, 1, 1]);

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://queue.fal.run/${modelId}` && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'still-custom-req',
          status_url: 'https://queue.fal.run/still-custom-img/status',
          response_url: 'https://queue.fal.run/still-custom-img/response',
        });
      }
      if (url === 'https://queue.fal.run/still-custom-img/status?logs=0') {
        return jsonResponse(200, { status: 'COMPLETED' });
      }
      if (url === 'https://queue.fal.run/still-custom-img/response') {
        return jsonResponse(200, { images: [{ url: resultImageUrl }] });
      }
      if (url === resultImageUrl) {
        return binaryResponse(200, imageBytes, 'image/png');
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeCtx();
    const image: MediaValue = { kind: 'image', url: 'https://example.test/ref.png' };
    const outputs = await falImageNode.execute({
      inputs: { prompt: 'a cat', image },
      params: { modelId },
      ctx,
    });
    expect((outputs.image as MediaValue).kind).toBe('image');
  });
});

// SPEC-step29.md §5.4 — regression test for the exact real session bug: a
// workflow with 1 input.image feeding 4 separate fal.image nodes, all left
// on the default/AI-picked "fal-ai/flux/dev" (a t2i preset). Before this
// step every one of those 4 nodes would "succeed" while silently discarding
// the input image; now every one of them must fail fast, before ever
// spending fal.ai credit (fetch never called).
describe('fal.image guard — regression: real 2026-07-13 user session (SPEC-step29.md §5.4)', () => {
  it('input.image -> 4x fal.image (flux/dev): all 4 nodes fail with the guard message, fetch never called', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-regression-t2i-'));
    try {
      writeFileSync(path.join(tmp, 'user-photo.png'), Buffer.from([137, 80, 78, 71]));

      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const registry = new NodeRegistry();
      registry.register(inputImageNode);
      registry.register(inputTextNode);
      registry.register(falImageNode);
      const engine = new Engine(
        registry,
        { runs: new InMemoryRunStore(), cache: new InMemoryCacheStore() },
        { artifactsDir: tmp },
      );

      const editNodeIds = ['edit1', 'edit2', 'edit3', 'edit4'];
      const wf: Workflow = {
        version: 1,
        id: 'regression-real-session-bug',
        name: '',
        nodes: [
          { id: 'photo', type: 'input.image', params: { path: 'user-photo.png' } },
          { id: 'topic', type: 'input.text', params: { value: 'xoá vật thể trong ảnh' } },
          ...editNodeIds.map((id) => ({ id, type: 'fal.image', params: { modelId: 'fal-ai/flux/dev' } })),
        ],
        edges: editNodeIds.flatMap((id, i) => [
          { id: `img-e${i}`, from: { node: 'photo', port: 'image' }, to: { node: id, port: 'image' } },
          { id: `txt-e${i}`, from: { node: 'topic', port: 'text' }, to: { node: id, port: 'prompt' } },
        ]),
      };

      const result = await engine.run(wf);

      expect(result.status).toBe('error');
      for (const id of editNodeIds) {
        expect(result.nodes[id]?.state).toBe('error');
        expect(result.nodes[id]?.error).toMatch(/là text-to-image nên sẽ bỏ qua ảnh đầu vào/);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
