/**
 * `input.image` (SPEC-step10.md §1.2): references an image file already on
 * disk (absolute path, or relative to `data/artifacts` — typically one just
 * saved by `POST /api/upload` under `uploads/<uuid>.<ext>`) and exposes it as
 * an `image` MediaValue. Not cacheable — the file on disk can change between
 * runs without any param/input of this node changing (same rationale as
 * `input.file`).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MediaValue, NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({
  path: z.string().min(1),
});
type Params = z.infer<typeof ParamsSchema>;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const inputImageNode: NodeDefinition<Params> = {
  type: 'input.image',
  category: 'utility',
  title: 'Ảnh có sẵn',
  description: 'Tham chiếu tới một file ảnh đã có trên đĩa (hoặc mới upload).',
  inputs: {},
  outputs: { image: { type: 'image' } },
  paramsSchema: ParamsSchema,
  cacheable: false,
  execute: async ({ params, ctx }) => {
    const resolvedPath = path.isAbsolute(params.path) ? params.path : path.join(ctx.artifactsDir, params.path);
    if (!existsSync(resolvedPath)) {
      throw new Error(
        `input.image: không tìm thấy file "${params.path}" (đã thử "${resolvedPath}") — kiểm tra lại đường dẫn (tuyệt đối hoặc tương đối với data/artifacts).`,
      );
    }

    const ext = path.extname(params.path).replace(/^\./, '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new Error(
        `input.image: định dạng ".${ext || '(không có)'}" không được hỗ trợ — chỉ nhận: ${Object.keys(MIME_BY_EXT).join(', ')}.`,
      );
    }

    const media: MediaValue = {
      kind: 'image',
      path: params.path,
      mime,
    };
    return { image: media };
  },
};
