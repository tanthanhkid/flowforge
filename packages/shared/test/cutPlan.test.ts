/**
 * SPEC-step33.md §33a — cutPlan.test.ts. `CutPlanSchema`/`TranscriptSchema`
 * validate valid shapes and reject malformed ones.
 */
import { describe, expect, it } from 'vitest';
import { CutPlanSchema, TranscriptSchema } from '../src/cutPlan.js';

describe('CutPlanSchema', () => {
  it('accepts a valid plan with a full moment', () => {
    const plan = {
      moments: [
        {
          id: 'm1',
          start: 0,
          end: 5.5,
          title: 'Mở đầu',
          reason: 'Câu hook mạnh',
          brollPrompt: 'cận cảnh tách cà phê bốc hơi',
          brollDurationSec: 2.5,
          brollImage: { path: 'artifacts/broll1.png', mime: 'image/png' },
        },
      ],
    };
    expect(() => CutPlanSchema.parse(plan)).not.toThrow();
  });

  it('accepts a minimal moment (only required fields)', () => {
    const plan = { moments: [{ id: 'm1', start: 0, end: 1, title: 'x' }] };
    const parsed = CutPlanSchema.parse(plan);
    expect(parsed.moments[0]?.brollPrompt).toBeUndefined();
  });

  it('accepts an empty moments array', () => {
    expect(() => CutPlanSchema.parse({ moments: [] })).not.toThrow();
  });

  it('rejects a moment missing required fields (title)', () => {
    const plan = { moments: [{ id: 'm1', start: 0, end: 1 }] };
    expect(() => CutPlanSchema.parse(plan)).toThrow();
  });

  it('rejects a negative start/end', () => {
    const plan = { moments: [{ id: 'm1', start: -1, end: 1, title: 'x' }] };
    expect(() => CutPlanSchema.parse(plan)).toThrow();
  });

  it('rejects a moment where end < start', () => {
    const plan = { moments: [{ id: 'm1', start: 5, end: 3, title: 'x' }] };
    expect(() => CutPlanSchema.parse(plan)).toThrow();
  });

  it('rejects a moment where end === start (zero-length)', () => {
    const plan = { moments: [{ id: 'm1', start: 5, end: 5, title: 'x' }] };
    expect(() => CutPlanSchema.parse(plan)).toThrow();
  });

  it('accepts a moment where end > start', () => {
    const plan = { moments: [{ id: 'm1', start: 5, end: 8, title: 'x' }] };
    expect(() => CutPlanSchema.parse(plan)).not.toThrow();
  });

  it('rejects moments that is not an array', () => {
    expect(() => CutPlanSchema.parse({ moments: 'nope' })).toThrow();
  });

  it('rejects a totally missing moments key', () => {
    expect(() => CutPlanSchema.parse({})).toThrow();
  });
});

describe('TranscriptSchema', () => {
  it('accepts a valid transcript with segments', () => {
    const transcript = {
      segments: [
        { start: 0, end: 2.1, text: 'Xin chào' },
        { start: 2.1, end: 4.0, text: 'các bạn' },
      ],
      text: 'Xin chào các bạn',
    };
    expect(() => TranscriptSchema.parse(transcript)).not.toThrow();
  });

  it('accepts an empty-segments transcript', () => {
    expect(() => TranscriptSchema.parse({ segments: [], text: '' })).not.toThrow();
  });

  it('rejects a segment missing text', () => {
    const transcript = { segments: [{ start: 0, end: 1 }], text: 'x' };
    expect(() => TranscriptSchema.parse(transcript)).toThrow();
  });

  it('rejects a missing top-level text field', () => {
    const transcript = { segments: [] };
    expect(() => TranscriptSchema.parse(transcript)).toThrow();
  });
});
