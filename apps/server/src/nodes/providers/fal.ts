/**
 * fal.ai queue API client (SPEC-step2.md §5): submit → poll status → fetch
 * result. Model id is a free-form string (no SDK, no hardcoded model list —
 * trending fal.ai models change too often for a dropdown).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '../../config.js';
import { HttpError, requestJson } from '../../lib/http.js';
import type { ExecutionContext, MediaValue } from '../../engine/types.js';

export interface RunFalQueueArgs {
  modelId: string;
  input: Record<string, unknown>;
  ctx: ExecutionContext;
  pollTimeoutMs?: number;
}

interface FalSubmitResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface FalStatusResponse {
  status?: string;
}

// SPEC-step33.md §33e-2 — resolved via getEnv() (not a module-level const)
// so a test that mutates process.env before calling into this module still
// sees the override; both default to the real hosts (config.ts's DEFAULTS),
// so prod/dev/real-tier e2e stay byte-identical.
function falQueueBaseUrl(): string {
  return getEnv('FAL_QUEUE_BASE_URL');
}

function falRestBaseUrl(): string {
  return getEnv('FAL_REST_BASE_URL');
}

function buildStatusUrl(modelId: string, requestId: string): string {
  return `${falQueueBaseUrl()}/${modelId}/requests/${requestId}/status`;
}

function buildResponseUrl(modelId: string, requestId: string): string {
  return `${falQueueBaseUrl()}/${modelId}/requests/${requestId}`;
}

function appendQuery(url: string, key: string, value: string): string {
  return url.includes('?') ? `${url}&${key}=${value}` : `${url}?${key}=${value}`;
}

function wrapFalError(err: unknown, modelId: string): Error {
  if (err instanceof HttpError) {
    return new Error(`fal.ai (model "${modelId}") failed: HTTP ${err.status ?? '?'} — ${err.bodySnippet ?? ''}`);
  }
  return err instanceof Error ? new Error(`fal.ai (model "${modelId}"): ${err.message}`) : new Error(String(err));
}

/** Submits `input` to fal.ai's queue API for `modelId`, polls until COMPLETED, and returns the raw result JSON. */
export async function runFalQueue(args: RunFalQueueArgs): Promise<any> {
  const { modelId, input, ctx } = args;
  const apiKey = getEnv('FAL_KEY');
  const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };

  let submitJson: FalSubmitResponse;
  try {
    const { json } = await requestJson<FalSubmitResponse>({
      url: `${falQueueBaseUrl()}/${modelId}`,
      method: 'POST',
      headers,
      body: input,
      timeoutMs: 60_000,
      retries: 2,
      signal: ctx.signal,
      // The submit is NOT idempotent — it enqueues (and bills) a job. Retry
      // on a definite server-side rejection (429/5xx/408), but not on a
      // timeout/network error, where the job may already have been enqueued
      // and a retry would create (and bill) a duplicate — especially costly
      // for fal.video.
      retryOnNetworkError: false,
    });
    submitJson = json;
  } catch (err) {
    throw wrapFalError(err, modelId);
  }

  const requestId = submitJson.request_id;
  if (!requestId) {
    throw new Error(`fal.ai (model "${modelId}"): phản hồi submit thiếu request_id.`);
  }

  // Prefer the URLs the server handed back (they may include a model
  // subpath), only falling back to a manually-built URL if absent.
  const statusUrl = appendQuery(submitJson.status_url ?? buildStatusUrl(modelId, requestId), 'logs', '0');
  const responseUrl = submitJson.response_url ?? buildResponseUrl(modelId, requestId);

  await ctx.poll<void>(
    async () => {
      let statusJson: FalStatusResponse;
      try {
        const { json } = await requestJson<FalStatusResponse>({
          url: statusUrl,
          method: 'GET',
          headers,
          timeoutMs: 30_000,
          retries: 1,
          signal: ctx.signal,
        });
        statusJson = json;
      } catch (err) {
        throw wrapFalError(err, modelId);
      }

      if (statusJson.status === 'COMPLETED') return { done: true };
      if (statusJson.status === 'IN_QUEUE' || statusJson.status === 'IN_PROGRESS') return { done: false };
      throw new Error(`fal.ai (model "${modelId}"): trạng thái không xác định "${statusJson.status ?? 'unknown'}".`);
    },
    { initialDelayMs: 1500, factor: 1.4, maxDelayMs: 8000, timeoutMs: args.pollTimeoutMs ?? 600_000 },
  );

  try {
    const { json } = await requestJson<any>({
      url: responseUrl,
      method: 'GET',
      headers,
      timeoutMs: 60_000,
      retries: 2,
      signal: ctx.signal,
    });
    return json;
  } catch (err) {
    throw wrapFalError(err, modelId);
  }
}

interface FalStorageInitiateResponse {
  file_url?: string;
  upload_url?: string;
}

/** Same shape as `wrapFalError` but for storage-upload calls, which aren't
 * tied to a `modelId` — avoids the misleading `(model "...")` wording. */
function wrapFalStorageError(err: unknown, step: string): Error {
  if (err instanceof HttpError) {
    return new Error(`fal.ai (storage upload — ${step}) failed: HTTP ${err.status ?? '?'} — ${err.bodySnippet ?? ''}`);
  }
  return err instanceof Error ? new Error(`fal.ai (storage upload — ${step}): ${err.message}`) : new Error(String(err));
}

const PUT_TIMEOUT_FLOOR_MS = 5 * 60_000;
const PUT_TIMEOUT_CAP_MS = 15 * 60_000;
// Conservative assumed upload throughput floor (bytes/sec) used to scale the
// PUT timeout below — deliberately pessimistic (real-world observed: a
// 76-minute video's ~13MB extracted audio upload took long enough from a
// slow-uplink location that the old fixed 120_000ms timeout aborted it
// mid-transfer).
const PUT_TIMEOUT_BYTES_PER_SEC = 15_000;

/**
 * Size-scaled PUT timeout (ms) for `uploadToFal`'s storage upload: a fixed
 * timeout (previously 120_000ms) is fine for a small image but aborts a
 * legitimate multi-MB `video.transcribe` audio upload over a slow uplink
 * before it finishes. Scales with `byteLength` assuming a conservative
 * ~15KB/s floor, clamped to [5min, 15min] so a tiny payload still gets a
 * generous minimum guard and a huge one doesn't wait unboundedly.
 */
export function putTimeoutMsForSize(byteLength: number): number {
  // byteLength / PUT_TIMEOUT_BYTES_PER_SEC = seconds at the conservative
  // floor rate; * 1000 to get ms (NOT `byteLength / 15_000` directly — that
  // would silently be a bytes/ms rate, i.e. 15MB/s, nowhere near
  // "conservative").
  const scaled = Math.ceil((byteLength / PUT_TIMEOUT_BYTES_PER_SEC) * 1000);
  return Math.min(PUT_TIMEOUT_CAP_MS, Math.max(PUT_TIMEOUT_FLOOR_MS, scaled));
}

/**
 * Uploads `data` to fal.ai's storage so a large binary (e.g. the audio
 * extracted for `video.transcribe`, SPEC-step33.md §33a) can be passed to a
 * queue model as a `*_url` field instead of a giant base64 data URI (which
 * `mediaToImageUrl` uses for small images but is unreliable/too large for
 * multi-MB audio/video).
 *
 * Endpoint sourced from fal's storage REST API (the `fal-ai` skill installed
 * in this session only covers the CLI/image/video flows and embeds local
 * files as base64 data URIs — it does not document a raw HTTP upload
 * endpoint — so this follows the canonical `@fal-ai/client` SDK source
 * (`libs/client/src/storage.ts`): `getRestApiUrl()` resolves to
 * `https://rest.fal.ai`, and the initiate call always appends
 * `?storage_type=fal-cdn-v3` (the SDK's own comment: "We want to test V3
 * without making it the default at the API level" — i.e. omitting the
 * query param opts into a legacy/deprecated default whose `file_url` may
 * not be fetchable by fal's queue workers). `POST
 * /storage/upload/initiate?storage_type=fal-cdn-v3` returns `{ file_url,
 * upload_url }`; the caller then `PUT`s the raw bytes to `upload_url` with
 * `Content-Type` set to the real mime type, after which `file_url` is a
 * fetchable/public URL usable as e.g. `audio_url`. Auth via the same
 * `Authorization: Key <FAL_KEY>` header as `runFalQueue`.
 *
 * Single-`PUT` only (no multipart) — fine up to fal's ~90MB single-part
 * ceiling (the SDK itself switches to multipart above that); good enough
 * for MVP audio/video sizes, revisit if that ceiling is ever hit.
 */
export async function uploadToFal(
  data: Buffer,
  filename: string,
  contentType: string,
  ctx: ExecutionContext,
): Promise<string> {
  const apiKey = getEnv('FAL_KEY');
  const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };

  let initiateJson: FalStorageInitiateResponse;
  try {
    const { json } = await requestJson<FalStorageInitiateResponse>({
      url: `${falRestBaseUrl()}/storage/upload/initiate?storage_type=fal-cdn-v3`,
      method: 'POST',
      headers,
      body: { content_type: contentType, file_name: filename },
      timeoutMs: 60_000,
      retries: 2,
      signal: ctx.signal,
    });
    initiateJson = json;
  } catch (err) {
    throw wrapFalStorageError(err, 'initiate');
  }

  const { file_url: fileUrl, upload_url: uploadUrl } = initiateJson;
  if (!fileUrl || !uploadUrl) {
    throw new Error('fal.ai (storage upload): phản hồi initiate thiếu file_url/upload_url.');
  }

  try {
    // AbortSignal.timeout(...) guards against a stalled PUT connection
    // hanging forever — requestJson()'s fetchWithTimeout gives every other
    // call in this file that same guarantee, but this raw `fetch` (the PUT
    // response usually isn't JSON, so requestJson doesn't fit) needs its
    // own. A FIXED timeout here is wrong: `video.transcribe`'s extracted
    // audio for a long source video can be tens of MB, and a real
    // full-pipeline smoke (76-minute video, ~13MB audio) hit exactly this —
    // the upload legitimately took longer than a flat 120s from a
    // slow-uplink location. `putTimeoutMsForSize` scales the budget with
    // payload size instead (floor/cap still guard a truly stalled
    // connection either way).
    const putTimeoutMs = putTimeoutMsForSize(data.length);
    ctx.log(`[fal.upload] PUT ${(data.length / (1024 * 1024)).toFixed(1)}MB (timeout ${Math.round(putTimeoutMs / 1000)}s)`);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: data,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(putTimeoutMs)]),
    });
    if (!res.ok) {
      const bodySnippet = (await res.text().catch(() => '')).slice(0, 300);
      throw new HttpError(`PUT ${uploadUrl} failed: HTTP ${res.status} — ${bodySnippet}`, {
        status: res.status,
        url: uploadUrl,
        bodySnippet,
      });
    }
  } catch (err) {
    throw wrapFalStorageError(err, 'PUT');
  }

  return fileUrl;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Resolves a MediaValue to a URL fal.ai can consume: an existing `url` is
 * used as-is; a local `path` is read from `artifactsDir` and turned into a
 * base64 data URI (mime guessed from the file extension, or `media.mime`).
 */
export async function mediaToImageUrl(media: MediaValue, artifactsDir: string): Promise<string> {
  if (media.url) return media.url;
  if (media.path) {
    const filePath = path.isAbsolute(media.path) ? media.path : path.join(artifactsDir, media.path);
    const data = await readFile(filePath);
    const ext = path.extname(media.path).replace(/^\./, '').toLowerCase();
    const mime = media.mime ?? MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return `data:${mime};base64,${data.toString('base64')}`;
  }
  throw new Error('mediaToImageUrl: MediaValue thiếu cả url và path.');
}
