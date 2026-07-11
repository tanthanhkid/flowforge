/**
 * `POST /api/upload` (SPEC-step10.md §1.1): multipart file upload (field
 * `file`) used by the browser's "📤 Chọn file..." button. Saves the file to
 * `<artifactsDir>/uploads/<uuid>.<ext>` and returns a path the ParamsPanel
 * can drop straight into a node's `path` param, plus enough metadata
 * (filename/mime/size/kind) for the UI to show a thumbnail or file name.
 *
 * `@fastify/multipart`'s `RequestFileTooLargeError` (thrown by
 * `data.toBuffer()` once the registered `fileSize` limit is exceeded) is
 * mapped to 413; a missing/absent file part -> 400. Anything else propagates
 * to buildServer's generic error handler.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg']);
const MARKDOWN_EXT = new Set(['md', 'markdown', 'txt']);

type UploadKind = 'image' | 'pdf' | 'markdown' | 'video' | 'audio' | 'other';

function kindFromExt(ext: string): UploadKind {
  if (ext === 'pdf') return 'pdf';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

/** Only `[a-z0-9]{1,8}` survives; anything else (missing, too long, unsafe chars) falls back to `bin`. */
function sanitizeExt(filename: string | undefined): string {
  const raw = path.extname(filename ?? '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(raw) ? raw : 'bin';
}

export function registerUploadRoutes(app: FastifyInstance, artifactsDir: string): void {
  app.post('/api/upload', async (request, reply) => {
    let filePart: MultipartFile | undefined;
    try {
      filePart = await request.file();
    } catch {
      reply.code(400).send({ error: 'Thiếu file — gửi multipart/form-data với field "file".' });
      return;
    }

    if (!filePart) {
      reply.code(400).send({ error: 'Thiếu file — gửi multipart/form-data với field "file".' });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await filePart.toBuffer();
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.code(413).send({ error: `File vượt quá giới hạn ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` });
        return;
      }
      throw err;
    }

    const ext = sanitizeExt(filePart.filename);
    const kind = kindFromExt(ext);
    const uploadsDir = path.join(artifactsDir, 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const savedFilename = `${randomUUID()}.${ext}`;
    await writeFile(path.join(uploadsDir, savedFilename), buffer);

    reply.code(201).send({
      path: `uploads/${savedFilename}`,
      filename: filePart.filename ?? savedFilename,
      mime: filePart.mimetype,
      size: buffer.length,
      kind,
    });
  });
}
