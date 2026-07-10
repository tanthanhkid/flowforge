/**
 * `input.file` (SPEC-step2.md §7): references an existing file already on
 * disk (absolute path, or relative to `data/artifacts`) and exposes it as a
 * MediaValue. Not cacheable — the file on disk can change between runs
 * without any param/input of this node changing.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { NodeDefinition, MediaValue } from '../engine/types.js';

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
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

const KIND_BY_EXT: Record<string, MediaValue['kind']> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
};

export const inputFileNode: NodeDefinition<Params> = {
  type: 'input.file',
  category: 'utility',
  title: 'File có sẵn',
  description: 'Tham chiếu tới một file đã có trên đĩa (ảnh/video/audio).',
  inputs: {},
  outputs: { file: { type: 'any' } },
  paramsSchema: ParamsSchema,
  cacheable: false,
  execute: async ({ params, ctx }) => {
    const resolvedPath = path.isAbsolute(params.path) ? params.path : path.join(ctx.artifactsDir, params.path);
    if (!existsSync(resolvedPath)) {
      throw new Error(
        `input.file: không tìm thấy file "${params.path}" (đã thử "${resolvedPath}") — kiểm tra lại đường dẫn (tuyệt đối hoặc tương đối với data/artifacts).`,
      );
    }

    const ext = path.extname(params.path).replace(/^\./, '').toLowerCase();
    const kind = KIND_BY_EXT[ext];
    if (!kind) {
      throw new Error(
        `input.file: định dạng ".${ext || '(không có)'}" không được hỗ trợ — hỗ trợ: ${Object.keys(KIND_BY_EXT).join(', ')}.`,
      );
    }

    const media: MediaValue = {
      kind,
      path: params.path,
      mime: MIME_BY_EXT[ext],
    };
    return { file: media };
  },
};
