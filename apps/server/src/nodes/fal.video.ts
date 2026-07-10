/**
 * `fal.video` (SPEC-step2.md §7): text/(optional image)-to-video via fal.ai's
 * queue API. `modelId` is required (no default) — video models vary widely
 * in required params, so the workflow author must pick one explicitly.
 */
import { z } from 'zod';
import { downloadBinary } from '../lib/http.js';
import type { MediaValue, NodeDefinition } from '../engine/types.js';
import { mediaToImageUrl, runFalQueue } from './providers/fal.js';

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
