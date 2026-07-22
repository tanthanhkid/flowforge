/**
 * `llm.selectMoments` (SPEC-step33.md §33b): picks up to `maxMoments` best
 * moments out of a transcript's timestamped segments, via OpenRouter, with
 * the same validate-and-retry loop as `agent/generateWorkflow.ts`/
 * `agent/editNode.ts` (extractJson -> zod-safeParse -> on failure, feed the
 * zod/parse error back to the model, up to 3 attempts total). Validates the
 * raw LLM response against `LlmPlanSchema` (below — a slightly looser local
 * variant of `shared`'s `CutPlanSchema` that makes `id` optional), then
 * post-processes into a `shared`-shaped `CutPlan`. Output feeds
 * `flow.approveGate` (SPEC-step33.md §33c, not part of this sub-step).
 */
import { z } from 'zod';
import type { ZodError } from 'zod';
import { CutPlanSchema, type CutMoment, type CutPlan, type TranscriptSegment } from 'shared';
import { getEnv } from '../config.js';
import type { NodeDefinition } from '../engine/types.js';
import { extractJson } from '../agent/json.js';
import { chatCompletion, type ChatMessage } from './providers/openrouter.js';

// Deliberately looser than `shared`'s `CutMomentSchema`/`CutPlanSchema`:
// those require a non-empty `id` on every moment (the review-panel/UI
// contract), but the LLM is explicitly *allowed* to omit `id` — this node's
// own post-processing step (`postProcess` below) assigns a stable one to
// any moment missing it (SPEC-step33.md §33b: "Gán id ổn định nếu LLM
// thiếu"). Validating the raw LLM output against the strict shared schema
// first would reject a perfectly fine model response (and burn a retry)
// just because `id` was left out, which defeats the point of filling it in
// afterwards. Same field-for-field shape otherwise, incl. the `end > start`
// refine.
const LlmMomentSchema = z
  .object({
    id: z.string().optional(),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    title: z.string(),
    reason: z.string().optional(),
    brollPrompt: z.string().optional(),
    brollDurationSec: z.number().positive().optional(),
  })
  .refine((m) => m.end > m.start, { message: 'CutMoment: "end" phải lớn hơn "start".' });

const LlmPlanSchema = z.object({ moments: z.array(LlmMomentSchema) });
type LlmPlan = z.infer<typeof LlmPlanSchema>;

const RawParamsSchema = z.object({
  model: z.string().default(''),
  maxMoments: z.number().int().positive().default(5),
  targetDurationSec: z.number().positive().default(45),
  temperature: z.number().min(0).max(2).default(0.4),
  generateBrollPrompts: z.boolean().default(true),
});

// See llm.generate.ts for why this resolves the default `model` via
// z.preprocess (not z.transform) before the engine computes the cache key —
// same rationale applies here: the cache key is derived from parsed params,
// so an unresolved '' would make the cache blind to OPENROUTER_DEFAULT_MODEL
// changes.
const ParamsSchema = z.preprocess((raw) => {
  const obj: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  if (!obj.model) obj.model = getEnv('OPENROUTER_DEFAULT_MODEL');
  return obj;
}, RawParamsSchema);
type Params = z.infer<typeof RawParamsSchema>;

const MAX_ATTEMPTS = 3;

/** Accepts either the raw `video.transcribe` output shape
 * (`{segments:[...], text}`) or a bare array of segments — SPEC-step33.md
 * §33b: "handle both defensively". */
function normalizeSegments(raw: unknown): TranscriptSegment[] {
  let candidate: unknown = raw;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'segments' in candidate) {
    candidate = (candidate as { segments: unknown }).segments;
  }
  if (!Array.isArray(candidate)) {
    throw new Error(
      'llm.selectMoments: input "segments" phải là mảng segment hoặc object {segments:[...]} — nối output của video.transcribe vào node này.',
    );
  }
  return candidate.map((seg, i) => {
    const s = seg as Record<string, unknown>;
    const start = typeof s.start === 'number' ? s.start : 0;
    const end = typeof s.end === 'number' ? s.end : start;
    const text = typeof s.text === 'string' ? s.text : '';
    if (typeof s.start !== 'number') {
      throw new Error(`llm.selectMoments: segment #${i} thiếu "start" hợp lệ.`);
    }
    return { start, end, text };
  });
}

function formatSegmentsForPrompt(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join('\n');
}

function buildSystemPrompt(params: Params, maxTime: number): string {
  const brollRule = params.generateBrollPrompts
    ? 'Mỗi khoảnh khắc PHẢI có "brollPrompt": một prompt sinh ảnh minh hoạ (b-roll) NGẮN GỌN, viết bằng tiếng Anh, mô tả một hình ảnh cutaway phù hợp với nội dung đoạn đó.'
    : 'KHÔNG thêm trường "brollPrompt" trong bất kỳ khoảnh khắc nào.';

  return [
    'Bạn là biên tập viên video, chọn ra những khoảnh khắc hay nhất từ transcript có timestamp để dựng thành 1 video short.',
    `Chọn tối đa ${params.maxMoments} khoảnh khắc, tổng thời lượng khoảng ${params.targetDurationSec} giây (không bắt buộc chính xác tuyệt đối, nhưng cố gắng gần đúng).`,
    `Mỗi khoảnh khắc: "start" và "end" (giây) PHẢI nằm trong khoảng thời gian transcript (0 đến ${maxTime.toFixed(2)}), và "end" phải LỚN HƠN "start".`,
    'Các khoảnh khắc PHẢI được sắp theo thời gian tăng dần ("start" tăng dần) và không cần liền kề nhau.',
    'Mỗi khoảnh khắc có "title" (tiêu đề ngắn) và "reason" (giải thích ngắn vì sao chọn).',
    brollRule,
    'CHỈ trả về JSON hợp lệ theo đúng schema, KHÔNG thêm giải thích hay markdown fence:',
    params.generateBrollPrompts
      ? '{ "moments": [ { "id": "m1", "start": 0, "end": 5, "title": "...", "reason": "...", "brollPrompt": "..." } ] }'
      : '{ "moments": [ { "id": "m1", "start": 0, "end": 5, "title": "...", "reason": "..." } ] }',
  ].join('\n');
}

function buildUserPrompt(segments: TranscriptSegment[], instruction: string): string {
  const parts = ['Transcript (mỗi dòng: [start-end] nội dung):', formatSegmentsForPrompt(segments)];
  if (instruction.trim()) {
    parts.push('', `Yêu cầu thêm của người dùng: ${instruction.trim()}`);
  }
  return parts.join('\n');
}

function zodErrorToFeedback(error: ZodError): string {
  const lines = error.issues.map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return `JSON chưa đúng schema CutPlan. Sửa và trả về JSON đầy đủ. Lỗi:\n${lines.join('\n')}`;
}

const PARSE_FEEDBACK =
  'Không parse được JSON hợp lệ từ phản hồi. Trả về DUY NHẤT một object JSON đúng schema, không kèm giải thích hay markdown fence.';

/** Post-processing (SPEC-step33.md §33b): truncate to `maxMoments` FIRST
 * (in the model's own priority order — Opus review fix #2: an unenforced
 * `maxMoments` is only a soft prompt instruction, so a model returning more
 * than asked flows through uncapped, inflating broll.generate/assembleShort
 * cost), clamp `end` to the transcript's max end time, drop any moment that
 * becomes zero/negative-length after clamping, assign a stable `id` to any
 * moment missing one OR colliding with an id already used (Opus review fix
 * #1 — the §2 "id is stable, used as resume/React key" contract breaks the
 * moment two moments share an id, whether both explicit or one auto-assigned
 * bumping into a later explicit one), then sort survivors by `start`. Strips
 * `brollPrompt` when the caller asked not to generate one (a model that
 * ignored the instruction shouldn't leak a prompt downstream). */
function postProcess(plan: LlmPlan, maxTime: number, generateBrollPrompts: boolean, maxMoments: number): CutPlan {
  const truncated = plan.moments.slice(0, maxMoments);
  const moments: CutMoment[] = [];
  const usedIds = new Set<string>();
  let autoIdCounter = 1;

  for (const m of truncated) {
    const end = Math.min(m.end, maxTime);
    if (end <= m.start) continue;

    let id = m.id && m.id.trim() ? m.id.trim() : '';
    if (!id || usedIds.has(id)) {
      while (usedIds.has(`m${autoIdCounter}`)) autoIdCounter += 1;
      id = `m${autoIdCounter}`;
      autoIdCounter += 1;
    }
    usedIds.add(id);

    const next: CutMoment = { ...m, id, end };
    if (!generateBrollPrompts) delete next.brollPrompt;
    moments.push(next);
  }

  moments.sort((a, b) => a.start - b.start);
  return { moments };
}

export const llmSelectMomentsNode: NodeDefinition<Params> = {
  type: 'llm.selectMoments',
  category: 'llm',
  title: 'LLM: Chọn khoảnh khắc',
  description: 'Chọn những khoảnh khắc hay nhất từ transcript có timestamp để dựng short, qua OpenRouter.',
  inputs: {
    segments: { type: 'json', required: true },
    instruction: { type: 'text', required: false },
  },
  outputs: { plan: { type: 'json' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params, ctx }) => {
    // params.model is already resolved (never '') by ParamsSchema's
    // preprocess step above — see llm.generate.ts for why.
    const model = params.model;
    const segments = normalizeSegments(inputs.segments);
    const instruction = inputs.instruction !== undefined && inputs.instruction !== null ? String(inputs.instruction) : '';

    const maxTime = segments.reduce((max, s) => Math.max(max, s.end, s.start), 0);

    // Opus review fix #3: an empty/near-zero transcript (silent clip, STT
    // miss) can never satisfy "0 <= start < end <= maxTime" — without this
    // guard the node would burn all 3 LLM attempts against an impossible
    // constraint before returning an empty plan late. Fail fast instead.
    if (segments.length === 0 || maxTime === 0) {
      throw new Error('llm.selectMoments: Không có transcript để chọn khoảnh khắc (segments rỗng).');
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(params, maxTime) },
      { role: 'user', content: buildUserPrompt(segments, instruction) },
    ];

    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const raw = await chatCompletion({
        model,
        messages,
        temperature: params.temperature,
        signal: ctx.signal,
      });

      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch {
        lastError = PARSE_FEEDBACK;
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: PARSE_FEEDBACK });
        continue;
      }

      const result = LlmPlanSchema.safeParse(parsed);
      if (!result.success) {
        lastError = zodErrorToFeedback(result.error);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: lastError });
        continue;
      }

      const plan = postProcess(result.data, maxTime, params.generateBrollPrompts, params.maxMoments);
      // Opus review fix #4: belt-and-suspenders — postProcess() is trusted
      // to always emit a shared-schema-valid CutPlan, but re-validating here
      // future-proofs against `shared`'s schema tightening later and turns
      // any postProcess bug into a loud, clear internal error instead of a
      // malformed `plan` silently reaching flow.approveGate/broll.generate.
      let validated: CutPlan;
      try {
        validated = CutPlanSchema.parse(plan);
      } catch (err) {
        throw new Error(
          `llm.selectMoments: lỗi nội bộ — kết quả sau xử lý không hợp lệ theo CutPlan (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
      ctx.log(`[llm.selectMoments] chọn ${validated.moments.length} khoảnh khắc.`);
      return { plan: validated };
    }

    throw new Error(
      `llm.selectMoments: model "${model}" không trả JSON hợp lệ theo CutPlan sau ${MAX_ATTEMPTS} lần thử — lỗi cuối: ${lastError}`,
    );
  },
};
