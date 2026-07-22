/**
 * SPEC-step33.md §33b — llm-select-moments.test.ts. `providers/openrouter.js`'s
 * `chatCompletion` fully mocked (vi.mock, no real network/secrets) — mirrors
 * the validate-and-retry loop covered for `agent/generateWorkflow.ts` /
 * `agent/editNode.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../src/engine/types.js';

const chatCompletionMock = vi.fn();

vi.mock('../src/nodes/providers/openrouter.js', () => ({
  chatCompletion: chatCompletionMock,
}));

const { llmSelectMomentsNode } = await import('../src/nodes/llm.selectMoments.js');

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
      throw new Error('llm.selectMoments should never poll');
    },
  };
}

const SEGMENTS = [
  { start: 0, end: 5, text: 'Xin chào mọi người.' },
  { start: 5, end: 12, text: 'Hôm nay chúng ta nói về AI.' },
  { start: 12, end: 20, text: 'Đây là phần quan trọng nhất.' },
  { start: 20, end: 30, text: 'Kết luận và cảm ơn đã theo dõi.' },
];

beforeEach(() => {
  chatCompletionMock.mockReset();
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
});

function validPlanJson(overrides?: Partial<{ generateBroll: boolean }>) {
  const withBroll = overrides?.generateBroll !== false;
  return JSON.stringify({
    moments: [
      {
        id: 'm2',
        start: 12,
        end: 20,
        title: 'Phần quan trọng',
        reason: 'Nội dung chính',
        ...(withBroll ? { brollPrompt: 'a person explaining an important idea' } : {}),
      },
      {
        start: 0,
        end: 5,
        title: 'Mở đầu',
        reason: 'Chào hỏi',
        ...(withBroll ? { brollPrompt: 'a friendly greeting scene' } : {}),
      },
    ],
  });
}

describe('llm.selectMoments — execute()', () => {
  it('parses a valid plan and returns moments sorted by start (even when the LLM returned them out of order)', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPlanJson());

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: 'full text' } },
      params,
      ctx: makeCtx(),
    });

    const plan = result.plan as { moments: Array<{ id: string; start: number; end: number }> };
    expect(plan.moments.map((m) => m.start)).toEqual([0, 12]);
    expect(plan.moments[0]!.id).toBe('m1'); // missing id auto-assigned
    expect(plan.moments[1]!.id).toBe('m2'); // explicit id kept
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('accepts segments given as a bare array (not wrapped in {segments:...})', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPlanJson());
    const params = llmSelectMomentsNode.paramsSchema.parse({});

    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: SEGMENTS },
      params,
      ctx: makeCtx(),
    });

    const plan = result.plan as { moments: unknown[] };
    expect(plan.moments).toHaveLength(2);
  });

  it('retries when the first response is invalid JSON, then succeeds on the second attempt', async () => {
    chatCompletionMock.mockResolvedValueOnce('not json at all, sorry');
    chatCompletionMock.mockResolvedValueOnce(validPlanJson());

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
    const plan = result.plan as { moments: unknown[] };
    expect(plan.moments).toHaveLength(2);
  });

  it('retries when the first response fails CutPlanSchema (e.g. end <= start), then succeeds', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({ moments: [{ id: 'bad', start: 10, end: 10, title: 'x' }] }),
    );
    chatCompletionMock.mockResolvedValueOnce(validPlanJson());

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
    const plan = result.plan as { moments: unknown[] };
    expect(plan.moments).toHaveLength(2);
  });

  it('throws a clear Vietnamese error after 3 failed attempts', async () => {
    chatCompletionMock.mockResolvedValue('still not json');

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    await expect(
      llmSelectMomentsNode.execute({
        inputs: { segments: { segments: SEGMENTS, text: '' } },
        params,
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/llm\.selectMoments.*không trả JSON hợp lệ.*3 lần thử/s);
    expect(chatCompletionMock).toHaveBeenCalledTimes(3);
  });

  it('generateBrollPrompts:false strips any brollPrompt the model still returned and asks the model not to include it', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPlanJson()); // model returns brollPrompt anyway

    const params = llmSelectMomentsNode.paramsSchema.parse({ generateBrollPrompts: false });
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    const plan = result.plan as { moments: Array<{ brollPrompt?: string }> };
    for (const m of plan.moments) {
      expect(m.brollPrompt).toBeUndefined();
    }

    const systemPrompt = chatCompletionMock.mock.calls[0]![0].messages[0].content as string;
    expect(systemPrompt).toMatch(/KHÔNG thêm trường "brollPrompt"/);
  });

  it('weaves the instruction input into the prompt sent to the LLM', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPlanJson());

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' }, instruction: 'Chỉ chọn đoạn nói về AI' },
      params,
      ctx: makeCtx(),
    });

    const userPrompt = chatCompletionMock.mock.calls[0]![0].messages[1].content as string;
    expect(userPrompt).toMatch(/Chỉ chọn đoạn nói về AI/);
  });

  it('runs fine with an empty/omitted instruction', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPlanJson());

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    expect((result.plan as { moments: unknown[] }).moments.length).toBeGreaterThan(0);
  });

  it('clamps a moment\'s "end" to the transcript\'s max segment end time, dropping it if that collapses the span', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        moments: [
          { id: 'm1', start: 25, end: 999, title: 'Kết luận' }, // end far beyond transcript -> clamp to 30, still > start -> kept
          { id: 'm2', start: 30, end: 999, title: 'Sau khi hết' }, // clamp -> end(30) === start -> dropped
        ],
      }),
    );

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    const plan = result.plan as { moments: Array<{ id: string; end: number }> };
    expect(plan.moments).toHaveLength(1);
    expect(plan.moments[0]!.id).toBe('m1');
    expect(plan.moments[0]!.end).toBe(30);
  });

  it('resolves params.model to OPENROUTER_DEFAULT_MODEL when omitted (cache-key stability)', async () => {
    process.env.OPENROUTER_DEFAULT_MODEL = 'env/default-select-model';
    const params = llmSelectMomentsNode.paramsSchema.parse({});
    expect(params.model).toBe('env/default-select-model');
    expect(params.model.length).toBeGreaterThan(0);
  });

  it('dedupes colliding ids: two explicit "m1"s and a later moment missing an id all get distinct ids', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        moments: [
          { id: 'm1', start: 0, end: 5, title: 'Đầu tiên' },
          { id: 'm1', start: 5, end: 10, title: 'Trùng id' }, // explicit collision with the one above
          { start: 10, end: 15, title: 'Thiếu id' }, // missing id -> would auto-assign "m1" without the fix
        ],
      }),
    );

    const params = llmSelectMomentsNode.paramsSchema.parse({});
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    const plan = result.plan as { moments: Array<{ id: string }> };
    const ids = plan.moments.map((m) => m.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3); // all unique
  });

  it('enforces maxMoments: truncates an over-long LLM response to the first N (model priority order) before sorting', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        moments: [
          { id: 'a', start: 20, end: 25, title: 'Ưu tiên 1' },
          { id: 'b', start: 0, end: 5, title: 'Ưu tiên 2' },
          { id: 'c', start: 10, end: 12, title: 'Ưu tiên 3 (bị cắt)' },
        ],
      }),
    );

    const params = llmSelectMomentsNode.paramsSchema.parse({ maxMoments: 2 });
    const result = await llmSelectMomentsNode.execute({
      inputs: { segments: { segments: SEGMENTS, text: '' } },
      params,
      ctx: makeCtx(),
    });

    const plan = result.plan as { moments: Array<{ id: string }> };
    expect(plan.moments).toHaveLength(2);
    expect(plan.moments.map((m) => m.id)).toEqual(['b', 'a']); // "c" truncated away; survivors sorted by start
  });

  it('throws a clear Vietnamese error before calling the LLM when segments is empty', async () => {
    const params = llmSelectMomentsNode.paramsSchema.parse({});
    await expect(
      llmSelectMomentsNode.execute({
        inputs: { segments: { segments: [], text: '' } },
        params,
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/segments rỗng/);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });
});
