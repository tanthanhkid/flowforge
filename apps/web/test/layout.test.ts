/**
 * SPEC-step16.md §4 — `layoutWorkflow` (apps/web/src/canvas/layout.ts): a
 * pure client-side auto-layout used both by the Toolbar "🪄 Sắp xếp" button
 * and automatically after a successful ✨ generate.
 */
import { describe, expect, it } from 'vitest';
import type { Workflow } from '../src/api/types.ts';
import { FALLBACK_NODE_HEIGHT, FALLBACK_NODE_WIDTH, layoutWorkflow } from '../src/canvas/layout.ts';

function wf(nodes: Workflow['nodes'], edges: Workflow['edges']): Workflow {
  return { version: 1, id: 'wf', name: 'test', nodes, edges };
}

function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: { width: number; height: number },
): boolean {
  return Math.abs(a.x - b.x) < size.width && Math.abs(a.y - b.y) < size.height;
}

describe('layoutWorkflow', () => {
  it('is pure: never mutates its inputs and returns a new object', () => {
    const input = wf(
      [{ id: 'a', type: 'input.text', params: {}, position: { x: 999, y: 999 } }],
      [],
    );
    const snapshot = JSON.parse(JSON.stringify(input));
    const sizes = { a: { width: 300, height: 200 } };
    const sizesSnapshot = JSON.parse(JSON.stringify(sizes));

    const result = layoutWorkflow(input, sizes);

    expect(input).toEqual(snapshot);
    expect(sizes).toEqual(sizesSnapshot);
    expect(result).not.toBe(input);
    expect(result.nodes[0]).not.toBe(input.nodes[0]);
  });

  it('assigns diamond dependencies to the expected depth columns (0,1,1,2)', () => {
    // a -> b, a -> c, b -> d, c -> d  (classic diamond)
    const workflow = wf(
      [
        { id: 'a', type: 'input.text', params: {} },
        { id: 'b', type: 'llm.generate', params: {} },
        { id: 'c', type: 'llm.generate', params: {} },
        { id: 'd', type: 'output.collect', params: {} },
      ],
      [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } },
        { id: 'e2', from: { node: 'a', port: 'text' }, to: { node: 'c', port: 'prompt' } },
        { id: 'e3', from: { node: 'b', port: 'text' }, to: { node: 'd', port: 'in1' } },
        { id: 'e4', from: { node: 'c', port: 'text' }, to: { node: 'd', port: 'in2' } },
      ],
    );

    const result = layoutWorkflow(workflow);
    const posOf = (id: string) => result.nodes.find((n) => n.id === id)!.position!;

    // Same column (b, c at depth 1) -> same x, different y.
    expect(posOf('b').x).toBe(posOf('c').x);
    expect(posOf('b').y).not.toBe(posOf('c').y);
    // Columns strictly increase left to right: a < b/c < d.
    expect(posOf('a').x).toBeLessThan(posOf('b').x);
    expect(posOf('b').x).toBeLessThan(posOf('d').x);
  });

  it('produces non-overlapping bounding boxes given real (fake) measured sizes', () => {
    const workflow = wf(
      [
        { id: 'a', type: 'input.text', params: {} },
        { id: 'b', type: 'llm.generate', params: {} },
        { id: 'c', type: 'llm.generate', params: {} },
        { id: 'd', type: 'output.collect', params: {} },
      ],
      [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } },
        { id: 'e2', from: { node: 'a', port: 'text' }, to: { node: 'c', port: 'prompt' } },
        { id: 'e3', from: { node: 'b', port: 'text' }, to: { node: 'd', port: 'in1' } },
        { id: 'e4', from: { node: 'c', port: 'text' }, to: { node: 'd', port: 'in2' } },
      ],
    );
    const sizes = {
      a: { width: 300, height: 150 },
      b: { width: 300, height: 220 },
      c: { width: 300, height: 90 },
      d: { width: 300, height: 150 },
    };

    const result = layoutWorkflow(workflow, sizes);
    const positions = result.nodes.map((n) => ({ id: n.id, pos: n.position! }));

    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i]!;
        const b = positions[j]!;
        const size = sizes[a.id as keyof typeof sizes];
        expect(overlaps(a.pos, b.pos, size)).toBe(false);
      }
    }
  });

  it('is cycle-safe: a cyclic graph still gets every node a finite, distinct-enough position without hanging', () => {
    // a -> b -> c -> a (pure cycle), plus a lone unrelated node.
    const workflow = wf(
      [
        { id: 'a', type: 'llm.generate', params: {} },
        { id: 'b', type: 'llm.generate', params: {} },
        { id: 'c', type: 'llm.generate', params: {} },
        { id: 'lone', type: 'input.text', params: {} },
      ],
      [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } },
        { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'c', port: 'prompt' } },
        { id: 'e3', from: { node: 'c', port: 'text' }, to: { node: 'a', port: 'prompt' } },
      ],
    );

    const result = layoutWorkflow(workflow);
    for (const node of result.nodes) {
      expect(node.position).toBeDefined();
      expect(Number.isFinite(node.position!.x)).toBe(true);
      expect(Number.isFinite(node.position!.y)).toBe(true);
    }
    // The lone node (no edges at all) is a source -> depth 0 -> column x=0.
    expect(result.nodes.find((n) => n.id === 'lone')?.position?.x).toBe(0);
  });

  it('falls back to the nominal 300x200 box for any node missing a measured size', () => {
    const workflow = wf(
      [
        { id: 'a', type: 'input.text', params: {} },
        { id: 'b', type: 'llm.generate', params: {} },
      ],
      [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } }],
    );

    const result = layoutWorkflow(workflow);
    const posB = result.nodes.find((n) => n.id === 'b')!.position!;
    // Column 1's x = column 0's fallback width (300) + gap (100) = 400.
    expect(posB.x).toBe(FALLBACK_NODE_WIDTH + 100);
    expect(FALLBACK_NODE_HEIGHT).toBeGreaterThan(0);
  });
});
