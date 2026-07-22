/**
 * `fal.image` (SPEC-step2.md §7): text/(optional image)-to-image via fal.ai's
 * queue API. `modelId` is a free-form string on purpose — trending fal.ai
 * image models change too often for a hardcoded dropdown.
 */
import { z } from 'zod';
import { downloadBinary } from '../lib/http.js';
import type { MediaValue, NodeDefinition } from '../engine/types.js';
import { findImageKind, setLiveImageCatalog, suggestI2IModels } from './falImageKind.js';
import { mediaToImageUrl, runFalQueue } from './providers/fal.js';

// `findImageKind`/`suggestI2IModels`/`setLiveImageCatalog` moved to
// `falImageKind.ts` (SPEC-step33.md §33d "Guard extraction") so
// `broll.generate` can reuse them for its own (opposite-direction) guard.
// Re-exported here so existing callers/tests (`import { setLiveImageCatalog }
// from './fal.image.js'`) keep working unchanged.
export { setLiveImageCatalog };

const ParamsSchema = z.object({
  modelId: z.string().default('fal-ai/flux/dev'),
  imageSize: z.string().optional(),
  seed: z.number().int().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
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

export const falImageNode: NodeDefinition<Params> = {
  type: 'fal.image',
  category: 'image',
  title: 'fal.ai: Sinh ảnh',
  description: 'Sinh ảnh từ prompt (và ảnh tham chiếu tuỳ chọn) qua fal.ai queue API.',
  inputs: {
    prompt: { type: 'text', required: true },
    image: { type: 'image', required: false },
  },
  outputs: { image: { type: 'image' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params, ctx }) => {
    const prompt = String(inputs.prompt ?? '');

    let imageUrl: string | undefined;
    if (inputs.image) {
      // Guard BEFORE spending any fal.ai credit (SPEC-step29.md §3): a
      // curated text-to-image model silently ignores image_url — catch it
      // here, not after billing. Custom/unknown model ids are left alone (we
      // genuinely can't know their kind).
      const imageKind = findImageKind(params.modelId);
      if (imageKind === 't2i') {
        const suggestions = suggestI2IModels();
        throw new Error(
          `Model "${params.modelId}" là text-to-image nên sẽ bỏ qua ảnh đầu vào. Chọn model image-to-image` +
            (suggestions.length > 0 ? ` (vd ${suggestions.join(', ')})` : '') +
            ` hoặc ngắt kết nối ảnh.`,
        );
      }
      imageUrl = await mediaToImageUrl(inputs.image as MediaValue, ctx.artifactsDir);
    }

    const input: Record<string, unknown> = {
      prompt,
      ...(params.imageSize !== undefined ? { image_size: params.imageSize } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(imageUrl !== undefined ? { image_url: imageUrl } : {}),
      ...(params.extra ?? {}),
    };

    const json = await runFalQueue({ modelId: params.modelId, input, ctx });

    const url: string | undefined = json?.images?.[0]?.url ?? json?.image?.url;
    if (!url) {
      throw new Error(
        `fal.image: model "${params.modelId}" không trả về ảnh (thiếu images[0].url/image.url) — kiểm tra lại modelId hoặc tham số đầu vào.`,
      );
    }

    const { data, contentType } = await downloadBinary(url, { signal: ctx.signal });
    const ext = guessImageExt(url, contentType);
    const savedPath = await ctx.saveArtifact(data, ext);

    const media: MediaValue = {
      kind: 'image',
      path: savedPath,
      mime: contentType ?? MIME_BY_EXT[ext],
      meta: { modelId: params.modelId, seed: json?.seed, sourceUrl: url },
    };
    return { image: media };
  },
};
