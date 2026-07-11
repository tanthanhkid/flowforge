/**
 * SPEC-step2.md §9 — nodes-registry.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/nodes/index.js';

const EXPECTED_TYPES = [
  'input.text',
  'input.file',
  'input.image',
  'input.pdf',
  'input.markdown',
  'text.template',
  'output.collect',
  'llm.generate',
  'llm.transform',
  'fal.image',
  'fal.video',
  'vbee.tts',
  'video.compose',
];

describe('createDefaultRegistry', () => {
  it('registers exactly the 13 node types (9 MVP + step10 input.image/pdf/markdown + step12 video.compose)', () => {
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
