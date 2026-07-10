/**
 * SPEC-step5.md §7 — agent-json.test.ts. `extractJson` tolerant parsing.
 */
import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/agent/json.js';

describe('extractJson', () => {
  it('parses JSON out of a ```json fenced code block', () => {
    const raw = 'Here is your workflow:\n```json\n{"a": 1, "b": [1, 2]}\n```\nLet me know if you need changes.';
    expect(extractJson(raw)).toEqual({ a: 1, b: [1, 2] });
  });

  it('parses JSON out of a plain ``` fenced code block (no "json" tag)', () => {
    const raw = '```\n{"x": true}\n```';
    expect(extractJson(raw)).toEqual({ x: true });
  });

  it('parses bare JSON with no fence and no surrounding text', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a bare JSON array', () => {
    expect(extractJson('[{"op": "update-node"}]')).toEqual([{ op: 'update-node' }]);
  });

  it('extracts JSON out of surrounding prose text (no fence)', () => {
    const raw = 'Sure! Here you go:\n\n{"a": 1, "nested": {"b": 2}}\n\nHope that helps!';
    expect(extractJson(raw)).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('ignores braces inside string literals when balancing', () => {
    const raw = 'prefix {"text": "a { fake brace } here"} suffix';
    expect(extractJson(raw)).toEqual({ text: 'a { fake brace } here' });
  });

  it('throws when the response contains no JSON at all', () => {
    expect(() => extractJson('Sorry, I cannot help with that.')).toThrow();
  });

  it('throws on an empty/blank response', () => {
    expect(() => extractJson('')).toThrow();
    expect(() => extractJson('   \n  ')).toThrow();
  });
});
