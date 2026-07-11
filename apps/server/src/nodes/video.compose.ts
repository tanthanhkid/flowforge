/**
 * `video.compose` (SPEC-step12.md §1): ghép 1-3 video (đã có file local, ví
 * dụ output của fal.video) cộng 1 audio tuỳ chọn (ví dụ output của vbee.tts)
 * thành 1 file mp4 h264+aac hoàn chỉnh, chạy hoàn toàn local qua `ffmpeg`
 * (spawn qua `node:child_process`, KHÔNG thêm npm dep). Không gọi API nào —
 * an toàn để test thật.
 *
 * Chạy 2 giai đoạn ffmpeg riêng để logic dễ suy luận/test:
 *   1. normalize từng video (scale theo `fit` cover/contain + fps cố định)
 *      rồi `concat` (filter, re-encode — an toàn khi input khác codec/size).
 *   2. nếu có `audio`: mux audio vào video vừa nối — `loopVideo=true` thì
 *      `-stream_loop -1` video rồi `-shortest` theo audio (loop cho tới hết
 *      audio); `loopVideo=false` thì giữ độ dài video gốc, `-shortest` cắt
 *      audio theo video.
 * Không có audio → output chính là kết quả bước 1 (video câm).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ExecutionContext, MediaValue, NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fit: z.enum(['cover', 'contain']).default('cover'),
  loopVideo: z.boolean().default(true),
  fps: z.number().int().positive().default(30),
});
type Params = z.infer<typeof ParamsSchema>;

const FFMPEG_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LEN = 300;

/** Resolves a MediaValue to an existing local file path, or throws a clear Vietnamese error. */
function resolveMediaPath(media: MediaValue, artifactsDir: string, label: string): string {
  if (media.path) {
    const resolved = path.isAbsolute(media.path) ? media.path : path.join(artifactsDir, media.path);
    if (!existsSync(resolved)) {
      throw new Error(`video.compose: không tìm thấy file cho input "${label}" tại "${resolved}".`);
    }
    return resolved;
  }
  if (media.url) {
    throw new Error(
      `video.compose: input "${label}" chỉ có url (${media.url}), chưa có file local — ffmpeg cần file trên đĩa. ` +
        `Hãy dùng output đã lưu file (fal.video/vbee.tts/input.file/...) làm nguồn cho node này.`,
    );
  }
  throw new Error(`video.compose: input "${label}" thiếu cả path và url.`);
}

/**
 * Đọc thời lượng (giây) của 1 file media qua `ffprobe`. Dùng để tính chính
 * xác điểm cắt (`-t`) khi mux audio — `-shortest` một mình không đủ chính
 * xác khi video đầu vào là `-stream_loop -1` (vô hạn) re-encode, có thể lố
 * thêm cả giây do làm tròn theo GOP/keyframe.
 */
function ffprobeDurationSeconds(filePath: string): number {
  let out: string;
  try {
    out = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ])
      .toString()
      .trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('video.compose: không tìm thấy ffprobe trong PATH — cần cài ffmpeg (brew install ffmpeg), ffprobe đi kèm.');
    }
    throw new Error(`video.compose: lỗi khi đọc thời lượng "${path.basename(filePath)}" qua ffprobe — ${(err as Error).message}`);
  }
  const seconds = Number(out);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`video.compose: ffprobe không đọc được thời lượng hợp lệ cho "${path.basename(filePath)}".`);
  }
  return seconds;
}

/** Rút gọn các path tuyệt đối dài trong câu lệnh khi log, chỉ giữ basename. */
function formatCommandForLog(cmd: string, args: string[]): string {
  const shortened = args.map((arg) => {
    if (arg.length > 30 && (arg.includes('/') || arg.includes('\\'))) return path.basename(arg);
    return arg;
  });
  return `${cmd} ${shortened.join(' ')}`;
}

function runFfmpeg(args: string[], ctx: ExecutionContext): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.log(`[video.compose] ${formatCommandForLog('ffmpeg', args)}`);

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
        reject(new Error(`video.compose: ffmpeg chạy quá ${FFMPEG_TIMEOUT_MS / 1000}s (timeout) — đã hủy tiến trình.`));
      });
    }, FFMPEG_TIMEOUT_MS);

    const onAbort = () => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error('video.compose: đã bị hủy (abort).'));
      });
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') {
          reject(new Error('video.compose: không tìm thấy ffmpeg trong PATH — cần cài ffmpeg (brew install ffmpeg).'));
        } else {
          reject(new Error(`video.compose: lỗi khi chạy ffmpeg — ${err.message}`));
        }
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          const tail = stderr.slice(-STDERR_TAIL_LEN);
          reject(new Error(`video.compose: ffmpeg thoát với mã lỗi ${code} — ${tail}`));
        }
      });
    });
  });
}

/** Filter chain scale/crop (cover) hoặc scale/pad (contain) tới đúng WxH, rồi fps cố định. */
function buildScaleFilter(params: Params): string {
  const { width, height, fit } = params;
  return fit === 'cover'
    ? `scale=w=${width}:h=${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/** Filter_complex: normalize từng input video rồi concat (nếu >1) thành [vout]. */
function buildNormalizeConcatFilter(params: Params, count: number): string {
  const scale = buildScaleFilter(params);
  const perInput: string[] = [];
  for (let i = 0; i < count; i += 1) {
    perInput.push(`[${i}:v]${scale},fps=${params.fps},setsar=1[v${i}]`);
  }
  if (count === 1) {
    return perInput[0]!.replace('[v0]', '[vout]');
  }
  const labels = Array.from({ length: count }, (_, i) => `[v${i}]`).join('');
  return `${perInput.join(';')};${labels}concat=n=${count}:v=1:a=0[vout]`;
}

async function runNormalizeConcat(
  videoPaths: string[],
  outputPath: string,
  params: Params,
  ctx: ExecutionContext,
): Promise<void> {
  const inputArgs = videoPaths.flatMap((p) => ['-i', p]);
  const filter = buildNormalizeConcatFilter(params, videoPaths.length);
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[vout]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ];
  await runFfmpeg(args, ctx);
}

async function runAudioMux(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  targetDurationSec: number,
  params: Params,
  ctx: ExecutionContext,
): Promise<void> {
  const videoInputArgs = params.loopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];
  const args = [
    '-y',
    ...videoInputArgs,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    // `-shortest` alone isn't precise enough when the video input is an
    // infinite `-stream_loop -1` re-encode (can overshoot by up to a GOP) —
    // `-t` pins the exact cut point computed via ffprobe up front.
    '-shortest',
    '-t',
    targetDurationSec.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(params.fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outputPath,
  ];
  await runFfmpeg(args, ctx);
}

export const videoComposeNode: NodeDefinition<Params> = {
  type: 'video.compose',
  category: 'video',
  title: 'Ghép video + voiceover (ffmpeg)',
  description:
    'Ghép 1-3 video (nối tiếp) và audio tuỳ chọn thành 1 video mp4 hoàn chỉnh bằng ffmpeg cục bộ, không tốn API.',
  inputs: {
    video: { type: 'video', required: true },
    video2: { type: 'video', required: false },
    video3: { type: 'video', required: false },
    audio: { type: 'audio', required: false },
  },
  outputs: { video: { type: 'video' } },
  paramsSchema: ParamsSchema,
  cacheable: true,
  execute: async ({ inputs, params, ctx }) => {
    const rawVideos: Array<{ value: unknown; label: string }> = [
      { value: inputs.video, label: 'video' },
      { value: inputs.video2, label: 'video2' },
      { value: inputs.video3, label: 'video3' },
    ];
    const videos = rawVideos.filter((v) => v.value !== undefined);
    if (videos.length === 0) {
      throw new Error('video.compose: cần ít nhất 1 video ở input "video".');
    }

    const videoPaths = videos.map(({ value, label }) => resolveMediaPath(value as MediaValue, ctx.artifactsDir, label));

    const audioMedia = inputs.audio as MediaValue | undefined;
    const audioPath = audioMedia ? resolveMediaPath(audioMedia, ctx.artifactsDir, 'audio') : undefined;

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ff-video-compose-'));
    try {
      const concatPath = path.join(tmpDir, 'concat.mp4');
      await runNormalizeConcat(videoPaths, concatPath, params, ctx);

      let finalPath = concatPath;
      if (audioPath) {
        finalPath = path.join(tmpDir, 'final.mp4');
        const audioDurationSec = ffprobeDurationSeconds(audioPath);
        const targetDurationSec = params.loopVideo
          ? audioDurationSec
          : Math.min(audioDurationSec, ffprobeDurationSeconds(concatPath));
        await runAudioMux(concatPath, audioPath, finalPath, targetDurationSec, params, ctx);
      }

      const data = await readFile(finalPath);
      const savedPath = await ctx.saveArtifact(data, 'mp4');

      const media: MediaValue = {
        kind: 'video',
        path: savedPath,
        mime: 'video/mp4',
        meta: {
          width: params.width,
          height: params.height,
          fit: params.fit,
          loopVideo: params.loopVideo,
          fps: params.fps,
          videoCount: videoPaths.length,
          hasAudio: Boolean(audioPath),
        },
      };
      return { video: media };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
};
