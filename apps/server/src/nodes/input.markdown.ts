/**
 * `input.markdown` (SPEC-step10.md §1.2): raw markdown text, either typed
 * directly (`params.content`) or read from a `.md`/`.markdown`/`.txt` file
 * already on disk (`params.path`, absolute or relative to `data/artifacts`).
 * Exactly one of the two must be set. `cacheable: false` for both modes —
 * a single node definition can't flip `cacheable` per-instance, and the
 * `path` mode needs it false (file on disk can change independently of
 * params), so `content` mode is kept consistent with it rather than special-
 * cased.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NodeDefinition } from '../engine/types.js';

const ALLOWED_EXTENSIONS = ['md', 'markdown', 'txt'];

const ParamsSchema = z
  .object({
    path: z.string().min(1).optional().describe('Đường dẫn file .md/.markdown/.txt — chỉ dùng 1 trong "path" hoặc "content".'),
    content: z.string().min(1).optional().describe('Nội dung markdown nhập trực tiếp — chỉ dùng 1 trong "path" hoặc "content".'),
  })
  .refine((v) => Boolean(v.path) !== Boolean(v.content), {
    message: 'input.markdown: cần đúng 1 trong "path" hoặc "content" (không được cả hai, không được để trống cả hai).',
  });
type Params = z.infer<typeof ParamsSchema>;

export const inputMarkdownNode: NodeDefinition<Params> = {
  type: 'input.markdown',
  category: 'utility',
  title: 'Markdown có sẵn',
  description: 'Nội dung markdown — nhập trực tiếp hoặc đọc từ file .md/.markdown/.txt đã có trên đĩa.',
  inputs: {},
  outputs: { text: { type: 'text' } },
  paramsSchema: ParamsSchema,
  cacheable: false,
  execute: async ({ params, ctx }) => {
    if (params.content !== undefined) {
      return { text: params.content };
    }

    const filePath = params.path as string;
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.artifactsDir, filePath);
    if (!existsSync(resolvedPath)) {
      throw new Error(
        `input.markdown: không tìm thấy file "${filePath}" (đã thử "${resolvedPath}") — kiểm tra lại đường dẫn (tuyệt đối hoặc tương đối với data/artifacts).`,
      );
    }

    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `input.markdown: định dạng ".${ext || '(không có)'}" không được hỗ trợ — chỉ nhận: ${ALLOWED_EXTENSIONS.join(', ')}.`,
      );
    }

    const content = await readFile(resolvedPath, 'utf-8');
    return { text: content };
  },
};
