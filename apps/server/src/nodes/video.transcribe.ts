/**
 * `video.transcribe` (SPEC-step33.md §33a): extracts the audio track from a
 * local video file via `ffmpeg` (spawn, same pattern as `video.compose.ts`),
 * uploads it to fal.ai storage (`uploadToFal`), then transcribes it via
 * fal.ai's queue API (default model `fal-ai/wizper`). Output: full text +
 * timestamped segments (`packages/shared`'s `TranscriptSchema` shape) — feeds
 * `llm.selectMoments` (SPEC-step33.md §33b, not part of this sub-step).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { TranscriptSegment } from 'shared';
import type { ExecutionContext, MediaValue, NodeDefinition } from '../engine/types.js';
import { runFalQueue, uploadToFal } from './providers/fal.js';

const ParamsSchema = z.object({
  model: z.string().default('fal-ai/wizper'),
  language: z.string().default('auto'),
  task: z.enum(['transcribe', 'translate']).default('transcribe'),
});
type Params = z.infer<typeof ParamsSchema>;

const FFMPEG_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LEN = 300;

/** Resolves a MediaValue to an existing local file path, or throws a clear
 * Vietnamese error — same rationale as `video.compose.ts`'s
 * `resolveMediaPath`: ffmpeg needs a real file on disk, a bare `url` isn't
 * enough. */
function resolveMediaPath(media: MediaValue, artifactsDir: string, label: string): string {
  if (media.path) {
    const resolved = path.isAbsolute(media.path) ? media.path : path.join(artifactsDir, media.path);
    if (!existsSync(resolved)) {
      throw new Error(`video.transcribe: không tìm thấy file cho input "${label}" tại "${resolved}".`);
    }
    return resolved;
  }
  if (media.url) {
    throw new Error(
      `video.transcribe: input "${label}" chỉ có url (${media.url}), chưa có file local — ffmpeg cần file trên đĩa. ` +
        `Hãy dùng output đã lưu file (fal.video/input.file/...) làm nguồn cho node này.`,
    );
  }
  throw new Error(`video.transcribe: input "${label}" thiếu cả path và url.`);
}

/** Rút gọn các path tuyệt đối dài trong câu lệnh khi log, chỉ giữ basename
 * (giống `video.compose.ts`'s `formatCommandForLog`). */
function formatCommandForLog(cmd: string, args: string[]): string {
  const shortened = args.map((arg) => {
    if (arg.length > 30 && (arg.includes('/') || arg.includes('\\'))) return path.basename(arg);
    return arg;
  });
  return `${cmd} ${shortened.join(' ')}`;
}

function runFfmpeg(args: string[], ctx: ExecutionContext): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.log(`[video.transcribe] ${formatCommandForLog('ffmpeg', args)}`);

    // Checked BEFORE spawning: an AbortSignal that was already aborted
    // by the time we get here would never fire its 'abort' event again
    // (events don't replay for late listeners), so the `signal.addEventListener`
    // below alone wouldn't catch a pre-existing abort.
    if (ctx.signal.aborted) {
      reject(new Error('video.transcribe: đã bị hủy (abort).'));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error(`video.transcribe: ffmpeg chạy quá ${FFMPEG_TIMEOUT_MS / 1000}s (timeout) — đã hủy tiến trình.`));
      });
    }, FFMPEG_TIMEOUT_MS);

    const onAbort = () => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error('video.transcribe: đã bị hủy (abort).'));
      });
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') {
          reject(new Error('video.transcribe: không tìm thấy ffmpeg trong PATH — cần cài ffmpeg (brew install ffmpeg).'));
        } else {
          reject(new Error(`video.transcribe: lỗi khi chạy ffmpeg — ${err.message}`));
        }
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          const tail = stderr.slice(-STDERR_TAIL_LEN);
          reject(new Error(`video.transcribe: ffmpeg thoát với mã lỗi ${code} — ${tail}`));
        }
      });
    });
  });
}

interface WizperChunk {
  // `end` is frequently `null` on the LAST chunk (whisper/wizper leave the
  // trailing boundary open) — typed as `unknown` rather than `number` so
  // that null/missing cases fall through to the clamping logic below
  // instead of being silently coerced.
  timestamp?: [number, unknown];
  text?: string;
}

interface WizperResult {
  text?: string;
  chunks?: WizperChunk[];
}

/** Maps a raw fal wizper result (`text` + `chunks:[{timestamp:[start,end],
 * text}]`) onto `TranscriptSegment[]`.
 *
 * Whisper/wizper routinely emit the LAST chunk with an open-ended
 * `timestamp: [start, null]` (no reliable "end of speech" boundary). Only a
 * missing/non-number `start` disqualifies a chunk (nothing to place it at);
 * a missing/non-number `end` is clamped instead of dropped — to the next
 * chunk's `start` when there is one, or to `start` itself for the very last
 * chunk (kept as a zero-length segment rather than losing it outright, since
 * 33b's `llm.selectMoments` consumes every segment in `segments`). */
function chunksToSegments(chunks: WizperChunk[] | undefined): TranscriptSegment[] {
  if (!chunks) return [];
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const [start, rawEnd] = chunk.timestamp ?? [];
    if (typeof start !== 'number') continue;

    let end: number;
    if (typeof rawEnd === 'number') {
      end = rawEnd;
    } else {
      const nextStart = chunks[i + 1]?.timestamp?.[0];
      end = typeof nextStart === 'number' ? nextStart : start;
    }

    segments.push({ start, end, text: chunk.text ?? '' });
  }
  return segments;
}

export const videoTranscribeNode: NodeDefinition<Params> = {
  type: 'video.transcribe',
  category: 'audio',
  title: 'Video: Chép lời (transcribe)',
  description: 'Tách audio khỏi video (ffmpeg cục bộ) rồi chép lời qua fal.ai (mặc định wizper), kèm timestamp từng đoạn.',
  inputs: {
    video: { type: 'video', required: true },
  },
  outputs: {
    text: { type: 'text' },
    segments: { type: 'json' },
  },
  paramsSchema: ParamsSchema,
  cacheable: true,
  execute: async ({ inputs, params, ctx }) => {
    const videoPath = resolveMediaPath(inputs.video as MediaValue, ctx.artifactsDir, 'video');

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ff-video-transcribe-'));
    try {
      const audioPath = path.join(tmpDir, 'audio.mp3');
      await runFfmpeg(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', audioPath], ctx);

      const audioData = await readFile(audioPath);
      const audioUrl = await uploadToFal(audioData, 'audio.mp3', 'audio/mpeg', ctx);

      const input: Record<string, unknown> = {
        audio_url: audioUrl,
        task: params.task,
        ...(params.language !== 'auto' ? { language: params.language } : {}),
      };

      const json = (await runFalQueue({ modelId: params.model, input, ctx })) as WizperResult;
      const segments = chunksToSegments(json.chunks);
      const text = json.text ?? segments.map((s) => s.text).join(' ');

      ctx.log(`[video.transcribe] ${segments.length} segment(s).`);

      return { text, segments };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
};
