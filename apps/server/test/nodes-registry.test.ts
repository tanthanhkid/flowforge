/**
 * SPEC-step2.md §9 — nodes-registry.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/nodes/index.js';

const EXPECTED_TYPES = [
  'input.text',
  'input.file',
  'text.template',
  'output.collect',
  'llm.generate',
  'llm.transform',
  'fal.image',
  'fal.video',
  'vbee.tts',
];

describe('createDefaultRegistry', () => {
  it('registers exactly the 9 MVP node types', () => {
    const registry = createDefaultRegistry();
    const types = registry.list().map((def) => def.type).sort();
    expect(types).toEqual([...EXPECTED_TYPES].sort());
  });

  it('describeForAgent() includes a paramsJsonSchema for every node', () => {
    const registry = createDefaultRegistry();
    const described = registry.describeForAgent();
    expect(described).toHaveLength(EXPECTED_TYPES.length);
    for (const entry of described) {
      expect(EXPECTED_TYPES).toContain(entry.type);
      expect(entry.paramsJsonSchema).toBeDefined();
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
    }
  });
});
