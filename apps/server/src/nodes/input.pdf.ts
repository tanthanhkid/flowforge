/**
 * `input.pdf` (SPEC-step10.md §1.2): extracts the text layer of a PDF file
 * already on disk (absolute path, or relative to `data/artifacts`) using
 * `unpdf` (pure-JS/WASM pdf.js build — no native dependency, unlike
 * pdf-parse/pdf-poppler). Not cacheable — same rationale as `input.file`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import type { NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({
  path: z.string().min(1),
  maxPages: z.number().int().positive().optional(),
});
type Params = z.infer<typeof ParamsSchema>;

export const inputPdfNode: NodeDefinition<Params> = {
  type: 'input.pdf',
  category: 'utility',
  title: 'PDF có sẵn',
  description: 'Trích text từ một file PDF đã có trên đĩa (hoặc mới upload).',
  inputs: {},
  outputs: {
    text: { type: 'text' },
    info: { type: 'json' },
  },
  paramsSchema: ParamsSchema,
  cacheable: false,
  execute: async ({ params, ctx }) => {
    const resolvedPath = path.isAbsolute(params.path) ? params.path : path.join(ctx.artifactsDir, params.path);
    if (!existsSync(resolvedPath)) {
      throw new Error(
        `input.pdf: không tìm thấy file "${params.path}" (đã thử "${resolvedPath}") — kiểm tra lại đường dẫn (tuyệt đối hoặc tương đối với data/artifacts).`,
      );
    }

    const ext = path.extname(params.path).replace(/^\./, '').toLowerCase();
    if (ext !== 'pdf') {
      throw new Error(`input.pdf: định dạng ".${ext || '(không có)'}" không được hỗ trợ — chỉ nhận: pdf.`);
    }

    const buffer = await readFile(resolvedPath);

    let totalPages: number;
    let pageTexts: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const extracted = await extractText(pdf, { mergePages: false });
      totalPages = extracted.totalPages;
      pageTexts = extracted.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`input.pdf: không đọc được file PDF "${params.path}" — file có thể hỏng hoặc không hợp lệ (${message}).`);
    }

    const truncated = params.maxPages !== undefined && params.maxPages < totalPages;
    const usedPages = truncated ? pageTexts.slice(0, params.maxPages) : pageTexts;
    const text = usedPages.join('\n\n').trim();

    if (!text) {
      throw new Error(
        `input.pdf: file "${params.path}" không có text layer (có thể là PDF scan chưa OCR) — không trích được nội dung.`,
      );
    }

    return {
      text,
      info: { pages: totalPages, truncated },
    };
  },
};
