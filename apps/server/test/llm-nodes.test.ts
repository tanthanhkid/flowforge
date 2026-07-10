/**
 * llm-nodes.test.ts — coverage for `llm.generate` (SPEC-step2.md §7), which
 * (unlike llm.transform, exercised indirectly by e2e-mocked.test.ts) had zero
 * execution coverage: its OPENROUTER_DEFAULT_MODEL fallback, system-message
 * inclusion, and context-appending behavior were entirely unverified. Also
 * covers two review-fix regressions shared by both llm nodes:
 *  - the empty/omitted `model` param must already be resolved by the time
 *    paramsSchema.parse() returns, so the engine's cache key reflects the
 *    actual model used (not the literal '' default) — see llm.generate.ts.
 *  - a raw OpenRouter HttpError must be wrapped with node/model context
 *    (SPEC §7: "tên node + nguyên nhân + gợi ý sửa") — see providers/openrouter.ts.
 *
 * `fetch` fully mocked; no real network/secrets involved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import type { ExecutionContext } from '../src/engine/types.js';
import { inputTextNode } from '../src/nodes/input.text.js';
import { llmGenerateNode } from '../src/nodes/llm.generate.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
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
    saveArtifact: async () => 'fake-artifact.bin',
    poll: async () => {
      throw new Error('llm.generate should never poll');
    },
  };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
});

describe('llm.generate — execute()', () => {
  it('resolves params.model to OPENROUTER_DEFAULT_MODEL when the model param is empty/omitted, and sends it to OpenRouter', async () => {
    process.env.OPENROUTER_DEFAULT_MODEL = 'env/default-model';
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(OPENROUTER_URL);
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;

    const params = llmGenerateNode.paramsSchema.parse({});
    expect(params.model).toBe('env/default-model');

    await llmGenerateNode.execute({ inputs: { prompt: 'hi' }, params, ctx: makeCtx() });
    expect(capturedBody.model).toBe('env/default-model');
  });

  it('resolves an explicit empty-string model param the same way as an omitted one', async () => {
    process.env.OPENROUTER_DEFAULT_MODEL = 'env/default-model-2';
    const params = llmGenerateNode.paramsSchema.parse({ model: '' });
    expect(params.model).toBe('env/default-model-2');
  });

  it('keeps an explicitly-set model param untouched', async () => {
    process.env.OPENROUTER_DEFAULT_MODEL = 'env/default-model';
    const params = llmGenerateNode.paramsSchema.parse({ model: 'explicit/model' });
    expect(params.model).toBe('explicit/model');
  });

  it('omits the system message when params.system is empty, includes it when non-empty', async () => {
    let bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;

    const paramsNoSystem = llmGenerateNode.paramsSchema.parse({ system: '' });
    await llmGenerateNode.execute({ inputs: { prompt: 'hi' }, params: paramsNoSystem, ctx: makeCtx() });
    expect(bodies[0].messages).toEqual([{ role: 'user', content: 'hi' }]);

    const paramsWithSystem = llmGenerateNode.paramsSchema.parse({ system: 'be nice' });
    await llmGenerateNode.execute({ inputs: { prompt: 'hi' }, params: paramsWithSystem, ctx: makeCtx() });
    expect(bodies[1].messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('appends "\\n\\nContext:\\n{context}" to the user message only when a context input is connected', async () => {
    let bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;

    const params = llmGenerateNode.paramsSchema.parse({});
    await llmGenerateNode.execute({ inputs: { prompt: 'hi' }, params, ctx: makeCtx() });
    expect(bodies[0].messages.at(-1).content).toBe('hi');

    await llmGenerateNode.execute({ inputs: { prompt: 'hi', context: 'extra info' }, params, ctx: makeCtx() });
    expect(bodies[1].messages.at(-1).content).toBe('hi\n\nContext:\nextra info');
  });

  it('wraps an OpenRouter HttpError with the node/model name and a remediation hint', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(401, { error: 'invalid api key' })) as unknown as typeof fetch;

    const params = llmGenerateNode.paramsSchema.parse({ model: 'some/model' });
    await expect(llmGenerateNode.execute({ inputs: { prompt: 'hi' }, params, ctx: makeCtx() })).rejects.toThrow(
      /OpenRouter.*some\/model.*OPENROUTER_API_KEY/s,
    );
  });
});

describe('llm.generate — cache key reflects the resolved model (regression)', () => {
  it('does NOT reuse a cached output from a different OPENROUTER_DEFAULT_MODEL after the env default changes', async () => {
    const registry = new NodeRegistry();
    registry.register(inputTextNode);
    registry.register(llmGenerateNode);
    const cacheStore = new InMemoryCacheStore();
    const engine = new Engine(registry, { runs: new InMemoryRunStore(), cache: cacheStore }, { artifactsDir: '/tmp/unused' });

    const wf: Workflow = {
      version: 1,
      id: 'llm-cache-wf',
      name: '',
      nodes: [
        { id: 'in', type: 'input.text', params: { value: 'Say hi' } },
        { id: 'gen', type: 'llm.generate', params: {} }, // model omitted -> uses env default
      ],
      edges: [{ id: 'e1', from: { node: 'in', port: 'text' }, to: { node: 'gen', port: 'prompt' } }],
    };

    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      fetchCalls += 1;
      const body = JSON.parse(init.body as string);
      return jsonResponse(200, { choices: [{ message: { content: `reply from ${body.model}` } }] });
    }) as unknown as typeof fetch;

    process.env.OPENROUTER_DEFAULT_MODEL = 'model/A';
    const result1 = await engine.run(wf);
    expect(result1.nodes.gen?.cached).toBe(false);
    expect((result1.nodes.gen?.outputs?.text as string)).toBe('reply from model/A');
    expect(fetchCalls).toBe(1);

    // Same workflow JSON, but the configured default model changed —
    // without the fix, this would silently replay model/A's cached reply.
    process.env.OPENROUTER_DEFAULT_MODEL = 'model/B';
    const result2 = await engine.run(wf);
    expect(result2.nodes.gen?.cached).toBe(false);
    expect((result2.nodes.gen?.outputs?.text as string)).toBe('reply from model/B');
    expect(fetchCalls).toBe(2);

    // Re-running with model/B again (env unchanged) IS a legitimate cache hit.
    const result3 = await engine.run(wf);
    expect(result3.nodes.gen?.cached).toBe(true);
    expect(fetchCalls).toBe(2);
  });
});
