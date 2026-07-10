import { z } from 'zod';
import type { NodeRegistry } from '../../src/engine/registry.js';
import type { NodeDefinition } from '../../src/engine/types.js';

/**
 * Mock node definitions used only by tests (never imported from src/).
 * See docs/SPEC-step1.md section 10.
 */

// ---------------------------------------------------------------------------
// mock.text — params { value: string }, no input, out text:text.
// Stands in for a user-provided text input node.
// ---------------------------------------------------------------------------
export const mockTextNode: NodeDefinition<{ value: string }> = {
  type: 'mock.text',
  category: 'utility',
  title: 'Mock Text',
  description: 'Emits a fixed text value from params.',
  inputs: {},
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({ value: z.string().default('') }),
  execute: async ({ params }) => {
    return { text: params.value };
  },
};

// ---------------------------------------------------------------------------
// mock.upper — in text:text (required), out text:text, uppercases input.
// ---------------------------------------------------------------------------
export const mockUpperNode: NodeDefinition<Record<string, never>> = {
  type: 'mock.upper',
  category: 'utility',
  title: 'Mock Upper',
  inputs: { text: { type: 'text', required: true } },
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({}),
  execute: async ({ inputs }) => {
    const text = String(inputs.text ?? '');
    return { text: text.toUpperCase() };
  },
};

// ---------------------------------------------------------------------------
// mock.concat — in a:text (required), b:text (optional), out text:text.
// ---------------------------------------------------------------------------
export const mockConcatNode: NodeDefinition<Record<string, never>> = {
  type: 'mock.concat',
  category: 'utility',
  title: 'Mock Concat',
  inputs: {
    a: { type: 'text', required: true },
    b: { type: 'text', required: false },
  },
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({}),
  execute: async ({ inputs }) => {
    const a = String(inputs.a ?? '');
    const b = String(inputs.b ?? '');
    return { text: a + b };
  },
};

// ---------------------------------------------------------------------------
// mock.delay — params { ms }, in text:text (optional), out text:text.
// Records { nodeId, start, end } into a shared log array (for overlap
// assertions) and optionally bumps a shared concurrency tracker's active
// count so tests can assert a max concurrency bound.
// ---------------------------------------------------------------------------
export interface DelayLogEntry {
  nodeId: string;
  start: number;
  end: number;
}

export interface ConcurrencyTracker {
  active: number;
  max: number;
}

export function createDelayNode(): {
  node: NodeDefinition<{ ms: number }>;
  log: DelayLogEntry[];
  tracker: ConcurrencyTracker;
} {
  const log: DelayLogEntry[] = [];
  const tracker: ConcurrencyTracker = { active: 0, max: 0 };

  const node: NodeDefinition<{ ms: number }> = {
    type: 'mock.delay',
    category: 'utility',
    title: 'Mock Delay',
    inputs: { text: { type: 'text', required: false } },
    outputs: { text: { type: 'text' } },
    paramsSchema: z.object({ ms: z.number().nonnegative().default(0) }),
    execute: async ({ inputs, params, ctx }) => {
      const start = Date.now();
      tracker.active += 1;
      tracker.max = Math.max(tracker.max, tracker.active);
      await new Promise<void>((resolve) => setTimeout(resolve, params.ms));
      tracker.active -= 1;
      const end = Date.now();
      log.push({ nodeId: ctx.nodeId, start, end });
      return { text: String(inputs.text ?? '') };
    },
  };

  return { node, log, tracker };
}

// ---------------------------------------------------------------------------
// mock.hang — execute() returns a promise that never settles. Used to freeze
// a run at status='running' indefinitely (e.g. to simulate a process
// restart orphaning a run row — see api-sse.test.ts's orphaned-run test).
// ---------------------------------------------------------------------------
export const mockHangNode: NodeDefinition<Record<string, never>> = {
  type: 'mock.hang',
  category: 'utility',
  title: 'Mock Hang',
  inputs: {},
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({}),
  execute: () => new Promise(() => {}),
};

// ---------------------------------------------------------------------------
// mock.fail — execute always throws new Error('boom').
// ---------------------------------------------------------------------------
export const mockFailNode: NodeDefinition<Record<string, never>> = {
  type: 'mock.fail',
  category: 'utility',
  title: 'Mock Fail',
  inputs: { text: { type: 'text', required: false } },
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({}),
  execute: async () => {
    throw new Error('boom');
  },
};

// ---------------------------------------------------------------------------
// mock.counter — factory producing a node that counts execute() calls.
// Used to observe cache hit/miss behavior. Also exposes a numeric `count`
// output (useful for triggering type-mismatch tests against text ports).
// ---------------------------------------------------------------------------
export function createCounterNode(opts?: { type?: string; cacheable?: boolean }): {
  node: NodeDefinition<{ value: string }>;
  counter: { count: number };
} {
  const counter = { count: 0 };
  const node: NodeDefinition<{ value: string }> = {
    type: opts?.type ?? 'mock.counter',
    category: 'utility',
    title: 'Mock Counter',
    inputs: { in: { type: 'text', required: false } },
    outputs: { text: { type: 'text' }, count: { type: 'number' } },
    paramsSchema: z.object({ value: z.string().default('x') }),
    cacheable: opts?.cacheable,
    execute: async ({ inputs, params }) => {
      counter.count += 1;
      const inText = String(inputs.in ?? '');
      return { text: `${params.value}:${inText}`, count: counter.count };
    },
  };
  return { node, counter };
}

// ---------------------------------------------------------------------------
// mock.poller — uses ctx.poll(), resolves done after N check() calls.
// N is passed via params.times.
// ---------------------------------------------------------------------------
export const mockPollerNode: NodeDefinition<{ times: number; value: string }> = {
  type: 'mock.poller',
  category: 'utility',
  title: 'Mock Poller',
  inputs: {},
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({ times: z.number().int().positive().default(3), value: z.string().default('done') }),
  execute: async ({ params, ctx }) => {
    let calls = 0;
    const value = await ctx.poll<string>(async () => {
      calls += 1;
      if (calls >= params.times) return { done: true, value: params.value };
      return { done: false };
    });
    return { text: value };
  },
};

// ---------------------------------------------------------------------------
// mock.anyIn — input value:any, to test `any` port compatibility.
// ---------------------------------------------------------------------------
export const mockAnyInNode: NodeDefinition<Record<string, never>> = {
  type: 'mock.anyIn',
  category: 'utility',
  title: 'Mock Any In',
  inputs: { value: { type: 'any', required: false } },
  outputs: { text: { type: 'text' } },
  paramsSchema: z.object({}),
  execute: async ({ inputs }) => {
    return { text: String(inputs.value ?? '') };
  },
};

// ---------------------------------------------------------------------------
// Convenience: register the stateless mock nodes (text/upper/concat/fail/
// poller/anyIn) on a fresh registry. Stateful ones (delay/counter) are
// created per-test via their factories since tests need fresh state.
// ---------------------------------------------------------------------------
export function registerBaseMocks(registry: NodeRegistry): void {
  registry.register(mockTextNode);
  registry.register(mockUpperNode);
  registry.register(mockConcatNode);
  registry.register(mockFailNode);
  registry.register(mockPollerNode);
  registry.register(mockAnyInNode);
}
