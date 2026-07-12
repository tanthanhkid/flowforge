/**
 * `fal.video` (SPEC-step2.md §7): text/(optional image)-to-video via fal.ai's
 * queue API. `modelId` is required (no default) — video models vary widely
 * in required params, so the workflow author must pick one explicitly.
 */
import { z } from 'zod';
import { downloadBinary } from '../lib/http.js';
import { FAL_VIDEO_MODELS } from '../catalog/falModels.js';
import type { CatalogFalEntry } from '../catalog/live/types.js';
import type { MediaValue, NodeDefinition } from '../engine/types.js';
import { mediaToImageUrl, runFalQueue } from './providers/fal.js';

/**
 * Pushed by `routes/modelCatalog.ts` after every `getCatalog()`/
 * `refreshCatalog()` call (SPEC-step19.md §1.6) so the t2v/i2v guard below
 * also recognizes fal.ai video models outside the static preset list (e.g.
 * a brand-new t2v model fal.ai ships that isn't hand-curated into
 * `catalog/falModels.ts` yet). `undefined` (the default, and what every test
 * that never calls this keeps getting) -> the guard falls back to exactly
 * the SPEC-step17.md static-preset-only behavior.
 */
let liveVideoCatalog: CatalogFalEntry[] | undefined;

export function setFalVideoLiveCatalog(entries: CatalogFalEntry[] | undefined): void {
  liveVideoCatalog = entries;
}

/** Static preset first, then the live-merged catalog snapshot (if pushed) — undefined means truly unknown to both (SPEC-step17.md "custom model ids not in the catalog are left alone"). */
function findKind(modelId: string): 'video-t2v' | 'video-i2v' | undefined {
  const preset = FAL_VIDEO_MODELS.find((m) => m.id === modelId);
  if (preset && preset.kind !== 'image') return preset.kind;
  const live = liveVideoCatalog?.find((m) => m.id === modelId);
  return live && live.kind !== 'image' ? live.kind : undefined;
}

/**
 * Best-effort "same family" image-to-video suggestion for a text-to-video
 * model id (SPEC-step17.md guard) — catalog t2v/i2v pairs share every path
 * segment except the last (e.g. `.../pro/text-to-video` <->
 * `.../pro/image-to-video`), so match on that shared prefix. Returns
 * undefined when there's no such sibling in the catalog (nothing to
 * suggest).
 */
function findI2VSibling(modelId: string): string | undefined {
  const prefix = modelId.split('/').slice(0, -1).join('/');
  const staticSibling = FAL_VIDEO_MODELS.find(
    (m) => m.kind === 'video-i2v' && m.id.split('/').slice(0, -1).join('/') === prefix,
  )?.id;
  if (staticSibling) return staticSibling;
  return liveVideoCatalog?.find((m) => m.kind === 'video-i2v' && m.id.split('/').slice(0, -1).join('/') === prefix)?.id;
}

const ParamsSchema = z.object({
  modelId: z.string().min(1),
  duration: z.union([z.string(), z.number()]).optional(),
  aspectRatio: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
type Params = z.infer<typeof ParamsSchema>;

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

function guessVideoExt(url: string, contentType: string | undefined): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  if (type && EXT_BY_MIME[type]) return EXT_BY_MIME[type];
  try {
    const match = /\.([a-zA-Z0-9]+)$/.exec(new URL(url).pathname);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // ignore invalid URL — fall through to default
  }
  return 'mp4';
}

export const falVideoNode: NodeDefinition<Params> = {
  type: 'fal.video',
  category: 'video',
  title: 'fal.ai: Sinh video',
  description: 'Sinh video từ prompt (và ảnh tham chiếu tuỳ chọn) qua fal.ai queue API.',
  inputs: {
    prompt: { type: 'text', required: true },
    image: { type: 'image', required: false },
  },
  outputs: { video: { type: 'video' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params, ctx }) => {
    const prompt = String(inputs.prompt ?? '');

    let imageUrl: string | undefined;
    if (inputs.image) {
      // Guard BEFORE spending any fal.ai credit (SPEC-step17.md): a curated
      // text-to-video model silently ignores image_url — catch it here, not
      // after billing. Custom model ids not in the catalog are left alone
      // (we genuinely can't know their kind).
      const kind = findKind(params.modelId);
      if (kind === 'video-t2v') {
        const sibling = findI2VSibling(params.modelId);
        throw new Error(
          `Model "${params.modelId}" là text-to-video nên sẽ bỏ qua ảnh đầu vào. Chọn bản image-to-video` +
            (sibling ? ` (vd ${sibling})` : '') +
            ` hoặc ngắt kết nối ảnh.`,
        );
      }
      imageUrl = await mediaToImageUrl(inputs.image as MediaValue, ctx.artifactsDir);
    }

    const input: Record<string, unknown> = {
      prompt,
      ...(params.duration !== undefined ? { duration: params.duration } : {}),
      ...(params.aspectRatio !== undefined ? { aspect_ratio: params.aspectRatio } : {}),
      ...(imageUrl !== undefined ? { image_url: imageUrl } : {}),
      ...(params.extra ?? {}),
    };

    const json = await runFalQueue({ modelId: params.modelId, input, ctx, pollTimeoutMs: 900_000 });

    const url: string | undefined = json?.video?.url ?? json?.videos?.[0]?.url;
    if (!url) {
      throw new Error(
        `fal.video: model "${params.modelId}" không trả về video (thiếu video.url/videos[0].url) — kiểm tra lại modelId hoặc tham số đầu vào.`,
      );
    }

    const { data, contentType } = await downloadBinary(url, { signal: ctx.signal });
    const ext = guessVideoExt(url, contentType);
    const savedPath = await ctx.saveArtifact(data, ext);

    const media: MediaValue = {
      kind: 'video',
      path: savedPath,
      mime: contentType ?? MIME_BY_EXT[ext],
      meta: { modelId: params.modelId, sourceUrl: url },
    };
    return { video: media };
  },
};
