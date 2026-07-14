/**
 * SPEC-step32.md B2/B3 — diff counts on `GET /api/conversations/:id`'s
 * reload path (join `workflow_changes` per message, count ops, omit the key
 * when there's no `changeId`), plus `changeDigest.ts`'s/`chatTurn.ts`'s
 * optional `workflow` param that enriches update-node/add-edge digest lines
 * and single-op AI summaries with a resolved `"<label>" (<type> <id>)` node
 * reference — both additive, byte-identical when the new param is omitted
 * (existing change-digest.test.ts / api-conversations.test.ts assertions
 * must keep passing unchanged).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChangeDigest, resolveNodeRef } from '../src/agent/changeDigest.js';
import { summarizeOps } from '../src/agent/chatTurn.js';
import type { WorkflowChange } from '../src/db/changes.js';
import { emptyWorkflow, type Workflow } from '../src/engine/schema.js';
import { buildServer } from '../src/server.js';

let nextId = 1;

function change(overrides: Partial<WorkflowChange> & { ops: unknown[] }): WorkflowChange {
  return {
    id: nextId++,
    workflowId: 'wf-1',
    conversationId: 'c1',
    source: 'user',
    scope: 'structural',
    summary: '',
    snapshotAfter: {},
    createdAt: 0,
    ...overrides,
  };
}

function workflowWith(nodes: Array<{ id: string; type: string; label?: string }>): Workflow {
  const wf = emptyWorkflow('wf-1', '');
  return { ...wf, nodes: nodes.map((n) => ({ id: n.id, type: n.type, params: {}, label: n.label })) };
}

describe('resolveNodeRef (SPEC-step32.md B3)', () => {
  const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh minh hoạ' }]);

  it('renders "<label>" (<type> <id>) when the node is found', () => {
    expect(resolveNodeRef(workflow, 'n1')).toBe('"Ảnh minh hoạ" (fal.image n1)');
  });

  it('falls back to a label-less node id when the label is unset', () => {
    const wf = workflowWith([{ id: 'n2', type: 'input.text' }]);
    expect(resolveNodeRef(wf, 'n2')).toBe('"n2" (input.text n2)');
  });

  it('falls back to a bare quoted id when the node is not found', () => {
    expect(resolveNodeRef(workflow, 'ghost')).toBe('"ghost"');
  });
});

describe('buildChangeDigest — workflow param (SPEC-step32.md B3)', () => {
  it('omitting workflow renders byte-identically to the pre-step32 format', () => {
    const changes = [
      change({ source: 'user', ops: [{ op: 'update-node', nodeId: 'n1', params: { size: '1024x1024' } }] }),
    ];
    expect(buildChangeDigest(changes)).toBe('[tay] node n1: size = "1024x1024"');
  });

  it('with workflow, update-node resolves the node label/type into the line', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh minh hoạ' }]);
    const changes = [
      change({ source: 'ai', ops: [{ op: 'update-node', nodeId: 'n1', params: { modelId: 'flux/dev' } }] }),
    ];
    expect(buildChangeDigest(changes, workflow)).toBe(
      '[AI] sửa modelId của "Ảnh minh hoạ" (fal.image n1): "flux/dev"',
    );
  });

  it('with workflow, an update-node label change resolves too', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Mới' }]);
    const changes = [change({ source: 'user', ops: [{ op: 'update-node', nodeId: 'n1', label: 'Mới' }] })];
    expect(buildChangeDigest(changes, workflow)).toBe('[tay] sửa label của "Mới" (fal.image n1): "Mới"');
  });

  it('with workflow, a node no longer present falls back to the bare id (same as without workflow)', () => {
    const workflow = workflowWith([{ id: 'other', type: 'input.text' }]);
    const changes = [change({ source: 'user', ops: [{ op: 'update-node', nodeId: 'gone', params: { x: 1 } }] })];
    expect(buildChangeDigest(changes, workflow)).toBe('[tay] sửa x của "gone": 1');
  });

  it('with workflow, add-edge resolves both endpoint node refs', () => {
    const workflow = workflowWith([
      { id: 'n1', type: 'fal.image', label: 'Ảnh' },
      { id: 'n2', type: 'output.collect' },
    ]);
    const changes = [
      change({
        source: 'ai',
        ops: [{ op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'in1' } } }],
      }),
    ];
    expect(buildChangeDigest(changes, workflow)).toBe(
      '[AI] nối "Ảnh" (fal.image n1).image → "n2" (output.collect n2).in1',
    );
  });

  it('remove-edge and move-node are unaffected by workflow (no nodeId in either op to resolve)', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh' }]);
    const changes = [
      change({ source: 'user', ops: [{ op: 'remove-edge', edgeId: 'e1' }] }),
      change({ source: 'user', ops: [{ op: 'move-node', nodeId: 'n1', position: { x: 1, y: 2 } }] }),
    ];
    expect(buildChangeDigest(changes, workflow)).toBe('[tay] xoá edge e1');
  });

  it('multiple param keys on the same node still dedupe per (nodeId, paramKey), each enriched independently', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh' }]);
    const changes = [
      change({ source: 'ai', ops: [{ op: 'update-node', nodeId: 'n1', params: { modelId: 'a' } }] }),
      change({ source: 'ai', ops: [{ op: 'update-node', nodeId: 'n1', params: { modelId: 'b', seed: 1 } }] }),
    ];
    expect(buildChangeDigest(changes, workflow).split('\n')).toEqual([
      '[AI] sửa modelId của "Ảnh" (fal.image n1): "b"',
      '[AI] sửa seed của "Ảnh" (fal.image n1): 1',
    ]);
  });
});

describe('summarizeOps — workflow param (SPEC-step32.md B3)', () => {
  it('omitting workflow renders byte-identically to the pre-step32 aggregate', () => {
    const ops = [{ op: 'add-node' as const, node: { id: 'n1', type: 'input.text', params: {} } }];
    expect(summarizeOps(ops)).toBe('AI: +1 node');
  });

  it('a single add-node op + workflow appends the resolved node detail', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh minh hoạ' }]);
    const ops = [{ op: 'add-node' as const, node: { id: 'n1', type: 'fal.image', params: {} } }];
    expect(summarizeOps(ops, workflow)).toBe('AI: +1 node — thêm "Ảnh minh hoạ" (fal.image n1)');
  });

  it('a single update-node op with several params joins all changed keys', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh minh hoạ' }]);
    const ops = [{ op: 'update-node' as const, nodeId: 'n1', params: { modelId: 'x', seed: 1 } }];
    expect(summarizeOps(ops, workflow)).toBe(
      'AI: ±1 node — sửa modelId, seed của "Ảnh minh hoạ" (fal.image n1)',
    );
  });

  it('a single add-edge op resolves both endpoints', () => {
    const workflow = workflowWith([
      { id: 'n1', type: 'fal.image', label: 'Ảnh' },
      { id: 'n2', type: 'output.collect' },
    ]);
    const ops = [
      { op: 'add-edge' as const, edge: { id: 'e1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'in1' } } },
    ];
    expect(summarizeOps(ops, workflow)).toBe('AI: +1 edge — nối "Ảnh" (fal.image n1) → "n2" (output.collect n2)');
  });

  it('a single remove-edge or move-node op adds no detail (nothing resolvable)', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh' }]);
    expect(summarizeOps([{ op: 'remove-edge' as const, edgeId: 'e1' }], workflow)).toBe('AI: -1 edge');
    expect(
      summarizeOps([{ op: 'move-node' as const, nodeId: 'n1', position: { x: 0, y: 0 } }], workflow),
    ).toBe('AI: ~1 vị trí');
  });

  it('multi-op turns keep the plain aggregate even with workflow available (no single node to attribute)', () => {
    const workflow = workflowWith([{ id: 'n1', type: 'fal.image', label: 'Ảnh' }]);
    const ops = [
      { op: 'add-node' as const, node: { id: 'n1', type: 'fal.image', params: {} } },
      { op: 'add-edge' as const, edge: { id: 'e1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'in1' } } },
    ];
    expect(summarizeOps(ops, workflow)).toBe('AI: +1 node, +1 edge');
  });
});

describe('GET /api/conversations/:id — diff counts (SPEC-step32.md B2)', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-step32-diff-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null } as unknown as Headers,
    } as unknown as Response;
  }

  function chatResponse(content: string): Response {
    return jsonResponse(200, { choices: [{ message: { content } }] });
  }

  async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function createConversation(): Promise<{ id: string; workflowId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    return (res.json() as { conversation: { id: string; workflowId: string } }).conversation;
  }

  it('a message whose turn applied ops gets a diff object with all 6 kinds (0s included)', async () => {
    const conv = await createConversation();
    const ops = [
      { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } },
      { op: 'add-node', node: { id: 'n2', type: 'output.collect', params: {} } },
      { op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'in1' } } },
    ];
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'Đã tạo.', ops }))) as unknown as typeof fetch;

    const post = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'tạo workflow' },
    });
    expect(post.statusCode).toBe(202);
    const { assistantMessageId } = post.json() as { assistantMessageId: string };
    await wait(20);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
    const messages = (
      detail.json() as {
        messages: Array<{
          id: string;
          diff?: { addNode: number; removeNode: number; updateNode: number; addEdge: number; removeEdge: number; moveNode: number };
        }>;
      }
    ).messages;
    const assistant = messages.find((m) => m.id === assistantMessageId)!;
    expect(assistant.diff).toEqual({ addNode: 2, removeNode: 0, updateNode: 0, addEdge: 1, removeEdge: 0, moveNode: 0 });
  });

  it('a message from a no-op (pure Q&A) turn has no diff key at all', async () => {
    const conv = await createConversation();
    globalThis.fetch = vi.fn(async () =>
      chatResponse(JSON.stringify({ reply: 'Chào bạn!', ops: [] })),
    ) as unknown as typeof fetch;

    const post = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'xin chào' },
    });
    const { assistantMessageId, userMessageId } = post.json() as { assistantMessageId: string; userMessageId: string };
    await wait(20);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
    const messages = (detail.json() as { messages: Array<{ id: string; diff?: unknown }> }).messages;
    expect(messages.find((m) => m.id === assistantMessageId)!.diff).toBeUndefined();
    expect(messages.find((m) => m.id === userMessageId)!.diff).toBeUndefined();
  });
});
