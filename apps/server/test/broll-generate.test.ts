/**
 * SPEC-step33.md §33d — broll.generate.test.ts. `fetch` fully mocked (same
 * style as `fal.test.ts`) — `runFalQueue`/`downloadBinary` both go through
 * `fetch`, so nothing here ever hits the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutPlanSchema, type CutPlan } from 'shared';
import { poll } from '../src/engine/context.js';
import type { ExecutionContext } from '../src/engine/types.js';
import { brollGenerateNode } from '../src/nodes/broll.generate.js';
import { setLiveImageCatalog } from '../src/nodes/falImageKind.js';

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
    nodeId: 'broll-1',
    signal: controller.signal,
    artifactsDir: '/tmp/does-not-matter',
    log: () => {},
    saveArtifact: async () => 'fake-broll.png',
    poll: (check, opts) => poll(check, controller.signal, opts),
    ...overrides,
  };
}

function makePlan(moments: CutPlan['moments']): CutPlan {
  return CutPlanSchema.parse({ moments });
}

beforeEach(() => {
  process.env.FAL_KEY = 'test-fal-key-id:test-fal-key-secret';
});

afterEach(() => {
  setLiveImageCatalog(undefined);
  vi.restoreAllMocks();
});

describe('broll.generate — loop over moments', () => {
  it('generates an image only for moments with a non-empty brollPrompt, skips the rest', async () => {
    let submitCalls = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell' && method === 'POST') {
        submitCalls += 1;
        return jsonResponse(200, {
          request_id: 'req-1',
          status_url: 'https://queue.fal.run/tag1/status',
          response_url: 'https://queue.fal.run/tag1/response',
        });
      }
      if (url === 'https://queue.fal.run/tag1/status?logs=0') return jsonResponse(200, { status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/tag1/response') return jsonResponse(200, { images: [{ url: 'https://cdn.fal.ai/img1.png' }] });
      if (url === 'https://cdn.fal.ai/img1.png') return binaryResponse(200, new Uint8Array([1, 2, 3]), 'image/png');
      throw new Error(`unexpected fetch url: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([
      { id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'a cat sitting' },
      { id: 'm2', start: 2, end: 3, title: 'B' }, // no brollPrompt -> skipped
      { id: 'm3', start: 4, end: 5, title: 'C', brollPrompt: '   ' }, // blank -> skipped
    ]);

    const ctx = makeCtx();
    const outputs = await brollGenerateNode.execute({
      inputs: { plan },
      params: brollGenerateNode.paramsSchema.parse({}),
      ctx,
    });

    expect(submitCalls).toBe(1);
    const resultPlan = outputs.plan as CutPlan;
    expect(resultPlan.moments[0]!.brollImage?.path).toBe('fake-broll.png');
    expect(resultPlan.moments[1]!.brollImage).toBeUndefined();
    expect(resultPlan.moments[2]!.brollImage).toBeUndefined();

    // Output re-validates against CutPlanSchema.
    expect(() => CutPlanSchema.parse(resultPlan)).not.toThrow();
  });

  it('calls runFalQueue exactly once per moment with a prompt, in order', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell' && method === 'POST') {
        const body = JSON.parse(init?.body as string);
        calls.push(body.prompt);
        const tag = `t${calls.length}`;
        return jsonResponse(200, {
          request_id: `${tag}-req`,
          status_url: `https://queue.fal.run/${tag}/status`,
          response_url: `https://queue.fal.run/${tag}/response`,
        });
      }
      const match = /\/(t\d+)\/(status|response)/.exec(url);
      if (match) {
        const [, tag, kind] = match;
        if (kind === 'status') return jsonResponse(200, { status: 'COMPLETED' });
        return jsonResponse(200, { images: [{ url: `https://cdn.fal.ai/${tag}.png` }] });
      }
      if (/https:\/\/cdn\.fal\.ai\/t\d+\.png/.test(url)) {
        return binaryResponse(200, new Uint8Array([9]), 'image/png');
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([
      { id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'prompt one' },
      { id: 'm2', start: 2, end: 3, title: 'B', brollPrompt: 'prompt two' },
    ]);

    const outputs = await brollGenerateNode.execute({
      inputs: { plan },
      params: brollGenerateNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });

    expect(calls).toEqual(['prompt one', 'prompt two']);
    const resultPlan = outputs.plan as CutPlan;
    expect(resultPlan.moments[0]!.brollImage?.path).toBe('fake-broll.png');
    expect(resultPlan.moments[1]!.brollImage?.path).toBe('fake-broll.png');
  });

  it('stops the loop on abort — no fal call after the abort fires', async () => {
    const controller = new AbortController();
    let submitCalls = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell' && method === 'POST') {
        submitCalls += 1;
        return jsonResponse(200, {
          request_id: 'req-1',
          status_url: 'https://queue.fal.run/tagA/status',
          response_url: 'https://queue.fal.run/tagA/response',
        });
      }
      if (url === 'https://queue.fal.run/tagA/status?logs=0') return jsonResponse(200, { status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/tagA/response') {
        // Simulate the run being stopped right after the first moment
        // finishes — the 2nd moment's iteration must observe the abort and
        // never call fetch again.
        controller.abort();
        return jsonResponse(200, { images: [{ url: 'https://cdn.fal.ai/imgA.png' }] });
      }
      if (url === 'https://cdn.fal.ai/imgA.png') return binaryResponse(200, new Uint8Array([1]), 'image/png');
      throw new Error(`unexpected fetch url after abort: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([
      { id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'prompt one' },
      { id: 'm2', start: 2, end: 3, title: 'B', brollPrompt: 'prompt two' },
      { id: 'm3', start: 4, end: 5, title: 'C', brollPrompt: 'prompt three' },
    ]);

    const ctx = makeCtx({ signal: controller.signal });
    await expect(
      brollGenerateNode.execute({
        inputs: { plan },
        params: brollGenerateNode.paramsSchema.parse({}),
        ctx,
      }),
    ).rejects.toThrow(/hủy|abort/i);

    expect(submitCalls).toBe(1);
  });
});

describe('broll.generate — i2i model guard (opposite direction of fal.image.ts)', () => {
  afterEach(() => setLiveImageCatalog(undefined));

  it('throws BEFORE calling fetch when the model is i2i', async () => {
    setLiveImageCatalog([
      { id: 'fal-ai/flux-pro/kontext', label: 'FLUX Kontext', kind: 'image', tier: 'xin', estUsd: 0.04, estBasis: 'x', createdAt: null, featured: false, imageKind: 'i2i' },
    ]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([{ id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'a cat' }]);

    await expect(
      brollGenerateNode.execute({
        inputs: { plan },
        params: brollGenerateNode.paramsSchema.parse({ model: 'fal-ai/flux-pro/kontext' }),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/image-to-image/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suggests up to 2 t2i models — static presets take priority over the live catalog (12/12 static image presets are t2i, same as suggestI2IModels() finding no static i2i match)', async () => {
    setLiveImageCatalog([
      { id: 'fal-ai/flux-pro/kontext', label: 'FLUX Kontext', kind: 'image', tier: 'xin', estUsd: 0.04, estBasis: 'x', createdAt: null, featured: false, imageKind: 'i2i' },
      { id: 'fal-ai/brand-new/t2i-a', label: 'A', kind: 'image', tier: 're', estUsd: 0.01, estBasis: 'x', createdAt: null, featured: false, imageKind: 't2i' },
    ]);

    const plan = makePlan([{ id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'a cat' }]);
    const error = await brollGenerateNode
      .execute({
        inputs: { plan },
        params: brollGenerateNode.paramsSchema.parse({ model: 'fal-ai/flux-pro/kontext' }),
        ctx: makeCtx(),
      })
      .catch((e: unknown) => e as Error);

    // Static preset suggestions (first 2, declared order) — the live-only
    // suggestion is never reached because the static list already has t2i
    // matches (all 12 static image presets are t2i).
    expect(error.message).toContain('fal-ai/flux-pro/v1.1-ultra');
    expect(error.message).toContain('fal-ai/recraft/v3/text-to-image');
    expect(error.message).not.toContain('fal-ai/brand-new/t2i-a'); // capped at 2, static wins
  });

  it('does not throw for the default t2i model (fal-ai/flux/schnell)', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell' && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'req-1',
          status_url: 'https://queue.fal.run/tagX/status',
          response_url: 'https://queue.fal.run/tagX/response',
        });
      }
      if (url === 'https://queue.fal.run/tagX/status?logs=0') return jsonResponse(200, { status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/tagX/response') return jsonResponse(200, { images: [{ url: 'https://cdn.fal.ai/x.png' }] });
      if (url === 'https://cdn.fal.ai/x.png') return binaryResponse(200, new Uint8Array([1]), 'image/png');
      throw new Error(`unexpected fetch url: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([{ id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'a cat' }]);
    const outputs = await brollGenerateNode.execute({
      inputs: { plan },
      params: brollGenerateNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });
    expect((outputs.plan as CutPlan).moments[0]!.brollImage).toBeDefined();
  });
});

describe('broll.generate — invalid input', () => {
  it('throws a clear error when "plan" does not match CutPlanSchema', async () => {
    await expect(
      brollGenerateNode.execute({
        inputs: { plan: { moments: 'not-an-array' } },
        params: brollGenerateNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/CutPlan/);
  });
});

describe('broll.generate — skipEmptyPrompt (Opus review fix: false is no longer a no-op)', () => {
  it('skipEmptyPrompt=false throws BEFORE any fal call when a moment is missing brollPrompt, naming the moment', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([
      { id: 'm1', start: 0, end: 1, title: 'Có prompt', brollPrompt: 'a cat' },
      { id: 'm2', start: 2, end: 3, title: 'Thiếu prompt' },
      { id: 'm3', start: 4, end: 5, title: 'Prompt rỗng', brollPrompt: '   ' },
    ]);

    const error = await brollGenerateNode
      .execute({
        inputs: { plan },
        params: brollGenerateNode.paramsSchema.parse({ skipEmptyPrompt: false }),
        ctx: makeCtx(),
      })
      .catch((e: unknown) => e as Error);

    expect(error.message).toContain('2/3');
    expect(error.message).toContain('Thiếu prompt');
    expect(error.message).toContain('Prompt rỗng');
    expect(error.message).not.toContain('Có prompt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skipEmptyPrompt=false does NOT throw when every moment has a brollPrompt', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell' && method === 'POST') {
        return jsonResponse(200, {
          request_id: 'req-1',
          status_url: 'https://queue.fal.run/tagY/status',
          response_url: 'https://queue.fal.run/tagY/response',
        });
      }
      if (url === 'https://queue.fal.run/tagY/status?logs=0') return jsonResponse(200, { status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/tagY/response') return jsonResponse(200, { images: [{ url: 'https://cdn.fal.ai/y.png' }] });
      if (url === 'https://cdn.fal.ai/y.png') return binaryResponse(200, new Uint8Array([1]), 'image/png');
      throw new Error(`unexpected fetch url: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const plan = makePlan([{ id: 'm1', start: 0, end: 1, title: 'A', brollPrompt: 'a cat' }]);
    const outputs = await brollGenerateNode.execute({
      inputs: { plan },
      params: brollGenerateNode.paramsSchema.parse({ skipEmptyPrompt: false }),
      ctx: makeCtx(),
    });
    expect((outputs.plan as CutPlan).moments[0]!.brollImage).toBeDefined();
  });
});
