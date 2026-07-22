/**
 * Mock fal.ai HTTP server (SPEC-step33.md §33e-2) — a tiny `node:http`
 * server (no new dependency, mirrors `e2e/mock-openrouter.ts`) that stands in
 * for `https://queue.fal.run` + `https://rest.fal.ai` during the FREE-tier
 * e2e run (`e2e/playwright.config.ts` points the running server's
 * `FAL_QUEUE_BASE_URL`/`FAL_REST_BASE_URL` at this instead — see
 * `apps/server/src/config.ts`'s additive overrides + `nodes/providers/fal.ts`),
 * so `e2e/tests/video-short.spec.ts` can drive the real
 * `video.transcribe`/`broll.generate` nodes (`runFalQueue`/`uploadToFal`) at
 * zero cost and fully deterministically.
 *
 * Endpoints (matched by pathname only — `runFalQueue`'s status URL carries a
 * `?logs=0` query string, and the storage-initiate URL carries
 * `?storage_type=fal-cdn-v3`):
 * - `POST /storage/upload/initiate` (`uploadToFal`'s initiate call) ->
 *   `{ file_url, upload_url }`, both pointing back at this same server.
 * - `PUT /upload/<anything>` (the actual byte upload `uploadToFal` PUTs to
 *   `upload_url`) -> 200, body ignored.
 * - `GET /file/audio` (the audio `file_url` `uploadToFal` returns — never
 *   actually fetched by our nodes, `runFalQueue`'s `audio_url` input is only
 *   ever read by the *real* fal.ai worker) -> 200.
 * - `GET /file/broll.png` (the b-roll image URL the mocked image-model
 *   response below points at, which `broll.generate`'s `downloadBinary` DOES
 *   fetch for real) -> a tiny valid 1x1 PNG.
 * - `POST /<modelId>` (`runFalQueue`'s submit) — distinguishes the model by
 *   substring in the path:
 *   - contains "wizper"/"whisper" (video.transcribe's default model) ->
 *     queue-submit response; its `response_url` returns a fixed wizper-shape
 *     transcript (`{text, chunks:[...]}` — 2 chunks spanning 0-5s, matching
 *     `video-short.spec.ts`'s ≥5s sample asset) once polled.
 *   - contains "flux"/"schnell"/"image" (broll.generate's default model,
 *     `fal-ai/flux/schnell`) -> queue-submit response; its `response_url`
 *     returns `{images:[{url: ".../file/broll.png"}]}`.
 * - `GET /<modelId>/requests/<id>/status` -> `{status:"COMPLETED"}` always
 *   (synchronous/first-poll — no need to simulate IN_QUEUE/IN_PROGRESS for
 *   this deterministic e2e fixture).
 * - `GET /<modelId>/requests/<id>` -> the fixed result for whichever kind
 *   (wizper/image) `request_id` was submitted for (kept in an in-memory map).
 *
 * Runs standalone via `tsx e2e/mock-fal.ts` (see playwright.config.ts's
 * webServer entry) — port from `process.env.PORT`, default 3980.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3980;
const HOST = '127.0.0.1';

/** A minimal valid 1x1 transparent PNG (same fixture bytes `app.spec.ts` uses elsewhere in this repo). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type RequestKind = 'wizper' | 'image';

/** request_id -> which fixed result to serve on `GET .../requests/<id>`. */
const pendingRequests = new Map<string, RequestKind>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendBinary(res: ServerResponse, status: number, data: Buffer, contentType: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': data.length });
  res.end(data);
}

function baseUrl(): string {
  return `http://${HOST}:${PORT}`;
}

/** Fixed wizper-shape transcript — 2 chunks spanning 0-5s (video-short.spec.ts's
 * sample asset is ~6s of audio, and `llm.selectMoments` needs segments to pick from). */
function wizperResult() {
  return {
    text: 'đoạn một đoạn hai',
    chunks: [
      { timestamp: [0, 2], text: 'đoạn một' },
      { timestamp: [3, 5], text: 'đoạn hai' },
    ],
  };
}

function imageResult() {
  return { images: [{ url: `${baseUrl()}/file/broll.png` }] };
}

function requestKindForModelId(modelId: string): RequestKind {
  const lower = modelId.toLowerCase();
  if (lower.includes('wizper') || lower.includes('whisper')) return 'wizper';
  return 'image';
}

/** `POST /<modelId>` — the queue-submit call `runFalQueue` makes. `modelId` is
 * everything in the path (fal model ids themselves contain slashes, e.g.
 * `fal-ai/flux/schnell`), so this only needs to exclude the fixed
 * storage/upload/file routes handled separately below. */
function handleSubmit(req: IncomingMessage, res: ServerResponse, modelId: string): void {
  void (async () => {
    try {
      await readBody(req); // drain the body (submit input) — content unused by this fixture
    } catch {
      sendJson(res, 400, { error: 'failed to read request body' });
      return;
    }

    const kind = requestKindForModelId(modelId);
    const requestId = randomUUID();
    pendingRequests.set(requestId, kind);

    sendJson(res, 200, {
      request_id: requestId,
      status_url: `${baseUrl()}/${modelId}/requests/${requestId}/status`,
      response_url: `${baseUrl()}/${modelId}/requests/${requestId}`,
    });
  })();
}

function handleStatus(res: ServerResponse): void {
  // Always COMPLETED on first poll — deterministic, synchronous fixture.
  sendJson(res, 200, { status: 'COMPLETED' });
}

function handleResponse(res: ServerResponse, requestId: string): void {
  const kind = pendingRequests.get(requestId);
  if (!kind) {
    sendJson(res, 404, { error: `mock-fal: unknown request_id "${requestId}"` });
    return;
  }
  sendJson(res, 200, kind === 'wizper' ? wizperResult() : imageResult());
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', baseUrl());
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'POST' && pathname === '/storage/upload/initiate') {
    sendJson(res, 200, {
      file_url: `${baseUrl()}/file/audio`,
      upload_url: `${baseUrl()}/upload/audio`,
    });
    return;
  }

  if (method === 'PUT' && pathname.startsWith('/upload/')) {
    void readBody(req).finally(() => sendJson(res, 200, { ok: true }));
    return;
  }

  if (method === 'GET' && pathname === '/file/audio') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/file/broll.png') {
    sendBinary(res, 200, TINY_PNG, 'image/png');
    return;
  }

  const statusMatch = /^\/(.+)\/requests\/([^/]+)\/status$/.exec(pathname);
  if (method === 'GET' && statusMatch) {
    handleStatus(res);
    return;
  }

  const responseMatch = /^\/(.+)\/requests\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && responseMatch) {
    handleResponse(res, responseMatch[2]!);
    return;
  }

  if (method === 'POST' && pathname.length > 1) {
    // Everything else POSTed is a queue-submit for `modelId` = pathname
    // stripped of its leading slash (fal model ids are themselves
    // slash-separated, e.g. `fal-ai/flux/schnell`).
    handleSubmit(req, res, pathname.slice(1));
    return;
  }

  sendJson(res, 404, { error: `mock-fal: no route for ${method} ${pathname}` });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-fal] listening on http://${HOST}:${PORT}`);
});
