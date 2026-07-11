/**
 * GET /artifacts/:filename (SPEC-step3.md §4), plus `?download=1`
 * (SPEC-step9.md §3): adds `Content-Disposition: attachment` so a browser
 * download (the ResultsPanel's ⬇ Tải về link) saves the file under its own
 * name instead of navigating to it inline — default (no query) stays inline,
 * unchanged from step 3, so existing <img>/<video>/<audio> previews keep
 * rendering in place.
 *
 * Serves files straight out of artifactsDir with a hand-rolled handler
 * (deliberately not @fastify/static, per spec, so path-traversal handling is
 * explicit and easy to audit). Registered on a wildcard route (`/artifacts/*`)
 * rather than a single `:filename` param so that any attempted traversal —
 * whether extra `/`-separated segments or a %2F-encoded slash that
 * find-my-way decodes into one — reaches this handler's guard instead of
 * silently 404ing at the router level.
 *
 * SPEC-step10.md §1.1 nudges this open exactly one level: a path of the form
 * `uploads/<file>` (files saved by `POST /api/upload`) is allowed through
 * with `<file>` itself still fully guarded (no further `/`, `\`, or `..`) —
 * every other shape (no `uploads/` prefix, or more than one extra segment)
 * still hits the original all-or-nothing guard below.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

const UPLOADS_PREFIX = 'uploads/';

export function registerArtifactsRoutes(app: FastifyInstance, artifactsDir: string): void {
  app.get('/artifacts/*', async (request, reply) => {
    const rest = (request.params as { '*': string })['*'] ?? '';

    // `uploads/<file>`: only the segment after the prefix is checked below,
    // so a traversal attempt smuggled in as e.g. `uploads/../secret` (target
    // becomes `../secret`, which contains `..`) is still rejected.
    const isUpload = rest.startsWith(UPLOADS_PREFIX);
    const target = isUpload ? rest.slice(UPLOADS_PREFIX.length) : rest;

    if (!target || target.includes('/') || target.includes('\\') || target.includes('..')) {
      reply.code(400).send({ error: 'Invalid artifact filename' });
      return;
    }

    const filePath = isUpload ? path.join(artifactsDir, 'uploads', target) : path.join(artifactsDir, target);

    let data: Buffer;
    try {
      data = await readFile(filePath);
    } catch {
      reply.code(404).send({ error: 'Artifact not found' });
      return;
    }

    const ext = path.extname(target).slice(1).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    reply.header('Content-Type', contentType);

    const query = request.query as { download?: string };
    if (query.download === '1') {
      reply.header('Content-Disposition', `attachment; filename="${target}"`);
    }

    reply.send(data);
  });
}
