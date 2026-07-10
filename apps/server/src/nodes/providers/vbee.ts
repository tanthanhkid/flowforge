/**
 * Vbee AIVoice TTS client (SPEC-step2.md §6), async mode: submit → poll →
 * download. Endpoint/body shape verified against the `vbee-tts` skill.
 */
import { getEnv } from '../../config.js';
import { downloadBinary, HttpError, requestJson } from '../../lib/http.js';
import type { ExecutionContext } from '../../engine/types.js';

export interface TtsAsyncArgs {
  text: string;
  voiceCode: string;
  speed: number;
  format: 'mp3' | 'wav';
  bitrate: number;
  ctx: ExecutionContext;
}

interface VbeeSubmitResponse {
  requestId?: string;
}

interface VbeeStatusResponse {
  status?: string;
  audioLink?: string;
}

const VBEE_SUBMIT_URL = 'https://api.vbee.vn/v1/tts';
// Placeholder — required by the API but unused: we poll for the result instead.
const VBEE_WEBHOOK_PLACEHOLDER = 'https://example.com/vbee-callback';
const DONE_STATUSES = new Set(['COMPLETED', 'SUCCESS']);
const FAILED_STATUSES = new Set(['FAILED', 'ERROR']);

function wrapVbeeError(err: unknown): Error {
  if (err instanceof HttpError) {
    return new Error(`Vbee TTS failed: HTTP ${err.status ?? '?'} — ${err.bodySnippet ?? ''}`);
  }
  return err instanceof Error ? new Error(`Vbee TTS: ${err.message}`) : new Error(String(err));
}

export async function ttsAsync(args: TtsAsyncArgs): Promise<{ data: Buffer; contentType?: string }> {
  const token = getEnv('VBEE_TOKEN');
  const appId = getEnv('VBEE_APP_ID');
  const headers = {
    Authorization: `Bearer ${token}`,
    'App-Id': appId,
    'Content-Type': 'application/json',
  };

  let submitJson: VbeeSubmitResponse;
  try {
    const { json } = await requestJson<VbeeSubmitResponse>({
      url: VBEE_SUBMIT_URL,
      method: 'POST',
      headers,
      body: {
        text: args.text,
        voiceCode: args.voiceCode,
        mode: 'async',
        webhookUrl: VBEE_WEBHOOK_PLACEHOLDER,
        outputFormat: args.format,
        bitrate: args.bitrate,
        speed: args.speed,
      },
      timeoutMs: 60_000,
      retries: 2,
      signal: args.ctx.signal,
      // Not idempotent — a lost response after the server enqueued the TTS
      // job would otherwise cause a retry to submit (and bill) a duplicate
      // request. Retry only on a definite server-side rejection
      // (429/5xx/408), not on a timeout/network error.
      retryOnNetworkError: false,
    });
    submitJson = json;
  } catch (err) {
    throw wrapVbeeError(err);
  }

  const requestId = submitJson.requestId;
  if (!requestId) {
    throw new Error('Vbee TTS: phản hồi submit thiếu requestId — kiểm tra lại App-Id/Token.');
  }

  const statusUrl = `https://api.vbee.vn/v1/tts/requests/${requestId}`;

  const audioLink = await args.ctx.poll<string>(
    async () => {
      let statusJson: VbeeStatusResponse;
      try {
        const { json } = await requestJson<VbeeStatusResponse>({
          url: statusUrl,
          method: 'GET',
          headers,
          timeoutMs: 30_000,
          retries: 1,
          signal: args.ctx.signal,
        });
        statusJson = json;
      } catch (err) {
        throw wrapVbeeError(err);
      }

      const status = statusJson.status ?? '';
      if (FAILED_STATUSES.has(status)) {
        throw new Error(`Vbee TTS: yêu cầu thất bại (status "${status}").`);
      }
      if (DONE_STATUSES.has(status) && statusJson.audioLink) {
        return { done: true, value: statusJson.audioLink };
      }
      return { done: false };
    },
    { initialDelayMs: 2000, factor: 1.25, maxDelayMs: 8000, timeoutMs: 600_000 },
  );

  // audioLink is only valid for ~3 minutes — download immediately.
  return downloadBinary(audioLink, { signal: args.ctx.signal });
}
