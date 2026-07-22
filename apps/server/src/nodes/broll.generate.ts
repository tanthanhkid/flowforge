/**
 * `broll.generate` (SPEC-step33.md §33d): loops over a `CutPlan`'s moments
 * and, for each one with a non-empty `brollPrompt`, generates a cutaway
 * still image via fal.ai's text-to-image queue API (same
 * submit->poll->download pattern as `fal.image.ts`), saving it into
 * `moment.brollImage`. Feeds `video.assembleShort` (SPEC-step33.md §33d,
 * same sub-step) which inserts each image as a fullscreen cutaway clip
 * after its talking segment.
 *
 * **Guard direction is the OPPOSITE of `fal.image.ts`'s** (plan-verify H2):
 * `fal.image` blocks a t2i model when an image IS connected (the model would
 * silently ignore it). `broll.generate` has NO image input at all — it only
 * ever calls a text-to-image model — so here it's an **i2i** model that
 * can't work (i2i needs a source image this node can never supply). Both
 * guards reuse the same `findImageKind` catalog lookup extracted into
 * `falImageKind.ts`, just checked against the opposite `imageKind`.
 */
import { z } from 'zod';
import { CutPlanSchema, type CutPlan } from 'shared';
import { downloadBinary } from '../lib/http.js';
import type { NodeDefinition } from '../engine/types.js';
import { findImageKind, suggestT2IModels } from './falImageKind.js';
import { runFalQueue } from './providers/fal.js';

const ParamsSchema = z.object({
  model: z.string().default('fal-ai/flux/schnell'),
  imageSize: z.string().default('portrait_16_9'),
  skipEmptyPrompt: z.boolean().default(true),
});
type Params = z.infer<typeof ParamsSchema>;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function guessImageExt(url: string, contentType: string | undefined): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  if (type && EXT_BY_MIME[type]) return EXT_BY_MIME[type];
  try {
    const match = /\.([a-zA-Z0-9]+)$/.exec(new URL(url).pathname);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // ignore invalid URL — fall through to default
  }
  return 'png';
}

function parsePlan(raw: unknown): CutPlan {
  const result = CutPlanSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `broll.generate: input "plan" không hợp lệ theo CutPlan — nối output của flow.approveGate/llm.selectMoments vào node này. Lỗi: ${result.error.message}`,
    );
  }
  return result.data;
}

export const brollGenerateNode: NodeDefinition<Params> = {
  type: 'broll.generate',
  category: 'image',
  title: 'B-roll: Sinh ảnh minh hoạ',
  description:
    'Sinh ảnh cutaway minh hoạ (b-roll) cho từng khoảnh khắc của CutPlan qua fal.ai text-to-image, gán vào moment.brollImage.',
  inputs: {
    plan: { type: 'json', required: true },
  },
  outputs: { plan: { type: 'json' } },
  paramsSchema: ParamsSchema,
  cacheable: true,
  execute: async ({ inputs, params, ctx }) => {
    // Guard BEFORE any fal.ai call (opposite direction from fal.image.ts's
    // guard — see module doc comment above): broll.generate never has a
    // source image to feed an i2i model, so an i2i modelId can only fail
    // once it actually calls fal — catch it here, before spending credit.
    const imageKind = findImageKind(params.model);
    if (imageKind === 'i2i') {
      const suggestions = suggestT2IModels();
      throw new Error(
        `Model "${params.model}" là image-to-image nên cần ảnh nguồn mà broll.generate không có. Chọn model text-to-image` +
          (suggestions.length > 0 ? ` (vd ${suggestions.join(', ')})` : '') +
          `.`,
      );
    }

    const plan = parsePlan(inputs.plan);
    const total = plan.moments.length;

    // `skipEmptyPrompt: false` used to be a no-op (fell through to the same
    // bare `continue` as the `true` branch) — a misleading knob. Make it
    // meaningful: fail fast, BEFORE spending any fal.ai credit, telling the
    // user exactly how many moments are missing a brollPrompt so they know
    // their plan is incomplete, instead of silently skipping them.
    if (!params.skipEmptyPrompt) {
      const missing = plan.moments.filter((m) => !m.brollPrompt?.trim());
      if (missing.length > 0) {
        throw new Error(
          `broll.generate: ${missing.length}/${total} khoảnh khắc thiếu "brollPrompt" (${missing
            .map((m) => `"${m.title}"`)
            .join(', ')}) — skipEmptyPrompt đang tắt nên không tự bỏ qua. Bổ sung brollPrompt hoặc bật skipEmptyPrompt.`,
        );
      }
    }

    for (let i = 0; i < total; i += 1) {
      if (ctx.signal.aborted) {
        throw new Error('broll.generate: đã bị hủy (abort).');
      }

      const moment = plan.moments[i]!;
      const prompt = moment.brollPrompt?.trim();
      if (!prompt) {
        // Only reachable when skipEmptyPrompt is true (the false-path threw
        // above already if any moment lacked a prompt).
        ctx.log(`[broll.generate] ${i + 1}/${total}: bỏ qua (không có brollPrompt).`);
        continue;
      }

      ctx.log(`[broll.generate] ${i + 1}/${total}: sinh ảnh cho "${moment.title}".`);

      const json = await runFalQueue({
        modelId: params.model,
        input: { prompt, image_size: params.imageSize },
        ctx,
      });

      const url: string | undefined = json?.images?.[0]?.url ?? json?.image?.url;
      if (!url) {
        throw new Error(
          `broll.generate: model "${params.model}" không trả về ảnh (thiếu images[0].url/image.url) cho khoảnh khắc "${moment.title}".`,
        );
      }

      const { data, contentType } = await downloadBinary(url, { signal: ctx.signal });
      const ext = guessImageExt(url, contentType);
      const savedPath = await ctx.saveArtifact(data, ext);

      moment.brollImage = { path: savedPath, mime: contentType ?? MIME_BY_EXT[ext] };
    }

    const validated = CutPlanSchema.parse(plan);
    ctx.log(`[broll.generate] hoàn tất — ${validated.moments.filter((m) => m.brollImage).length}/${total} khoảnh khắc có b-roll.`);
    return { plan: validated };
  },
};
