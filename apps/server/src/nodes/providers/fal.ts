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

function buildStatusUrl(modelId: string, requestId: string): string {
  return `https://queue.fal.run/${modelId}/requests/${requestId}/status`;
}

function buildResponseUrl(modelId: string, requestId: string): string {
  return `https://queue.fal.run/${modelId}/requests/${requestId}`;
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
      url: `https://queue.fal.run/${modelId}`,
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
