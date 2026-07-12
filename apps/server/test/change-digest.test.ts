/**
 * SPEC-step21.md §6.2 — buildChangeDigest.
 */
import { describe, expect, it } from 'vitest';
import { buildChangeDigest } from '../src/agent/changeDigest.js';
import type { WorkflowChange } from '../src/db/changes.js';

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

describe('buildChangeDigest', () => {
  it('returns "" for an empty input', () => {
    expect(buildChangeDigest([])).toBe('');
  });

  it('returns "" when every op is move-node (nothing worth reporting)', () => {
    const digest = buildChangeDigest([
      change({ ops: [{ op: 'move-node', nodeId: 'a', position: { x: 1, y: 2 } }] }),
    ]);
    expect(digest).toBe('');
  });

  it('prefixes [tay] for source=user and [AI] for source=ai', () => {
    const digest = buildChangeDigest([
      change({ source: 'user', ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } }] }),
      change({ source: 'ai', ops: [{ op: 'add-node', node: { id: 'n2', type: 'vbee.tts', params: {} } }] }),
    ]);
    const lines = digest.split('\n');
    expect(lines).toEqual([
      '[tay] thêm node input.text (id n1)',
      '[AI] thêm node vbee.tts (id n2)',
    ]);
  });

  it('formats each op kind per the SPEC-step21.md §3 templates', () => {
    const digest = buildChangeDigest([
      change({
        source: 'user',
        ops: [
          { op: 'add-node', node: { id: 'n1', type: 'fal.image', params: {} } },
          { op: 'remove-node', nodeId: 'n0' },
          { op: 'update-node', nodeId: 'n1', params: { size: '1024x1024' } },
          { op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'in1' } } },
          { op: 'remove-edge', edgeId: 'e0' },
        ],
      }),
    ]);
    expect(digest.split('\n')).toEqual([
      '[tay] thêm node fal.image (id n1)',
      '[tay] xoá node n0',
      '[tay] node n1: size = "1024x1024"',
      '[tay] nối n1.image → n2.in1',
      '[tay] xoá edge e0',
    ]);
  });

  it('dedupes update-node params by (nodeId, paramKey), keeping only the LAST value, at the position of its last occurrence', () => {
    const digest = buildChangeDigest([
      change({
        ops: [
          { op: 'update-node', nodeId: 'n1', params: { prompt: 'a cat' } },
          { op: 'add-node', node: { id: 'n2', type: 'input.text', params: {} } },
          { op: 'update-node', nodeId: 'n1', params: { prompt: 'a dog' } },
          { op: 'update-node', nodeId: 'n1', params: { prompt: 'a fox' } },
        ],
      }),
    ]);
    // "add-node n2" line first (its position in original order didn't
    // change), THEN the n1/prompt line — because the LAST update to n1's
    // prompt happened after add-node.
    expect(digest.split('\n')).toEqual([
      '[tay] thêm node input.text (id n2)',
      '[tay] node n1: prompt = "a fox"',
    ]);
  });

  it('dedupes label separately from params, keyed by (nodeId, "label")', () => {
    const digest = buildChangeDigest([
      change({
        ops: [
          { op: 'update-node', nodeId: 'n1', label: 'First label' },
          { op: 'update-node', nodeId: 'n1', params: { temperature: 0.5 } },
          { op: 'update-node', nodeId: 'n1', label: 'Final label' },
        ],
      }),
    ]);
    expect(digest.split('\n')).toEqual([
      '[tay] node n1: temperature = 0.5',
      '[tay] node n1: label = "Final label"',
    ]);
  });

  it('truncates a param value JSON to 120 chars with an ellipsis', () => {
    const longValue = 'x'.repeat(200);
    const digest = buildChangeDigest([
      change({ ops: [{ op: 'update-node', nodeId: 'n1', params: { prompt: longValue } }] }),
    ]);
    const line = digest.split('\n')[0]!;
    // JSON.stringify(longValue) is `"` + 200 x's + `"` (202 chars); sliced to
    // the first 120 chars keeps the opening quote + 119 x's, then '…' is
    // appended.
    expect(line).toMatch(/^\[tay\] node n1: prompt = ".{119}…$/);
  });

  it('ignores move-node interspersed among structural ops (no line emitted for it)', () => {
    const digest = buildChangeDigest([
      change({
        ops: [
          { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } },
          { op: 'move-node', nodeId: 'n1', position: { x: 10, y: 20 } },
        ],
      }),
    ]);
    expect(digest.split('\n')).toEqual(['[tay] thêm node input.text (id n1)']);
  });

  it('caps at 40 lines, keeping the newest, with a rollup line counting the dropped ones', () => {
    const ops = Array.from({ length: 45 }, (_, i) => ({
      op: 'add-node' as const,
      node: { id: `n${i}`, type: 'input.text', params: {} },
    }));
    const digest = buildChangeDigest([change({ ops })]);
    const lines = digest.split('\n');
    expect(lines[0]).toBe('… (5 thay đổi cũ hơn đã lược bớt)');
    expect(lines).toHaveLength(1 + 40);
    // The newest 40 (n5..n44) are kept, the oldest 5 (n0..n4) are dropped.
    expect(lines[1]).toBe('[tay] thêm node input.text (id n5)');
    expect(lines.at(-1)).toBe('[tay] thêm node input.text (id n44)');
  });

  it('caps total output at ~6000 chars, trimming further from the oldest kept line', () => {
    // Each line is long enough that even 40 of them blow the 6000-char
    // budget, forcing the char-cap path to trim beyond the line-cap.
    const longId = 'n'.repeat(200);
    const ops = Array.from({ length: 40 }, (_, i) => ({
      op: 'add-node' as const,
      node: { id: `${longId}${i}`, type: 'input.text', params: {} },
    }));
    const digest = buildChangeDigest([change({ ops })]);
    expect(digest.length).toBeLessThanOrEqual(6000);
    const lines = digest.split('\n');
    expect(lines[0]).toMatch(/^… \(\d+ thay đổi cũ hơn đã lược bớt\)$/);
    // The very newest line must still have survived the char-cap trim.
    expect(lines.at(-1)).toContain(`${longId}39`);
  });
});
