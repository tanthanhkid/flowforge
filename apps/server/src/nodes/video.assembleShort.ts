/**
 * `video.assembleShort` (SPEC-step33.md §33d): cuts each `CutPlan` moment's
 * talking segment out of the source video, inserts a fullscreen b-roll
 * cutaway still (when `moment.brollImage` was filled in by
 * `broll.generate`) right after it, and concatenates the whole sequence
 * into one finished 9:16 short — fully local via `ffmpeg` (spawn), reusing
 * `video.compose.ts`'s spawn/temp-dir/abort/timeout/ENOENT patterns.
 *
 * Per-moment clip sequence: [talking segment][b-roll still] (SPEC-step33.md
 * §33d — "cutaway toàn màn hình xen giữa các đoạn nói"). Every clip
 * (talk-segment or still) is normalized to the exact same
 * WxH/fps/codec/pixel-format/audio-sample-rate/channels BEFORE concatenation
 * so a plain concat-demuxer stream copy (`-c copy`) can stitch them without
 * a second re-encode pass — the same "normalize each input first" idea as
 * `video.compose.ts`'s `buildNormalizeConcatFilter`, just applied per-clip
 * instead of via one `filter_complex`, because here every clip's audio
 * source differs (real speech vs. silent `anullsrc`).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { CutPlanSchema, type CutPlan } from 'shared';
import type { ExecutionContext, MediaValue, NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fit: z.enum(['cover', 'contain']).default('cover'),
  fps: z.number().int().positive().default(30),
  brollDurationSec: z.number().positive().default(2.5),
  defaultBrollDurationSec: z.number().positive().default(2.5),
});
type Params = z.infer<typeof ParamsSchema>;

const FFMPEG_TIMEOUT_MS = 180_000;
const STDERR_TAIL_LEN = 300;
const AUDIO_SAMPLE_RATE = 44100;

/** Resolves a MediaValue to an existing local file path, or throws a clear
 * Vietnamese error — same rationale as `video.compose.ts`'s
 * `resolveMediaPath`: ffmpeg needs a real file on disk, a bare `url` isn't
 * enough. */
function resolveMediaPath(media: MediaValue, artifactsDir: string, label: string): string {
  if (media.path) {
    const resolved = path.isAbsolute(media.path) ? media.path : path.join(artifactsDir, media.path);
    if (!existsSync(resolved)) {
      throw new Error(`video.assembleShort: không tìm thấy file cho input "${label}" tại "${resolved}".`);
    }
    return resolved;
  }
  if (media.url) {
    throw new Error(
      `video.assembleShort: input "${label}" chỉ có url (${media.url}), chưa có file local — ffmpeg cần file trên đĩa. ` +
        `Hãy dùng output đã lưu file (fal.video/input.file/...) làm nguồn cho node này.`,
    );
  }
  throw new Error(`video.assembleShort: input "${label}" thiếu cả path và url.`);
}

/** Probes (once, up front) whether the source video has an audio stream at
 * all — a silent source (no audio track) would otherwise make talk clips
 * come out video-only while b-roll stills carry silent audio, a mismatched
 * stream layout the concat-demuxer `-c copy` step can't stitch cleanly.
 * `ffprobe` missing is surfaced as the same "cài ffmpeg" error as every
 * other ffmpeg/ffprobe call in this node (ffprobe ships alongside ffmpeg). */
function hasAudioStream(filePath: string): boolean {
  let out: string;
  try {
    out = execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      filePath,
    ])
      .toString()
      .trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('video.assembleShort: không tìm thấy ffprobe trong PATH — cần cài ffmpeg (brew install ffmpeg), ffprobe đi kèm.');
    }
    throw new Error(`video.assembleShort: lỗi khi kiểm tra audio stream của nguồn qua ffprobe — ${(err as Error).message}`);
  }
  return out.length > 0;
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
    ctx.log(`[video.assembleShort] ${formatCommandForLog('ffmpeg', args)}`);

    // Checked BEFORE spawning (same fix as video.transcribe.ts): an
    // AbortSignal that was already aborted by the time we get here would
    // never fire its 'abort' event again for a late listener.
    if (ctx.signal.aborted) {
      reject(new Error('video.assembleShort: đã bị hủy (abort).'));
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
        reject(new Error(`video.assembleShort: ffmpeg chạy quá ${FFMPEG_TIMEOUT_MS / 1000}s (timeout) — đã hủy tiến trình.`));
      });
    }, FFMPEG_TIMEOUT_MS);

    const onAbort = () => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error('video.assembleShort: đã bị hủy (abort).'));
      });
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') {
          reject(new Error('video.assembleShort: không tìm thấy ffmpeg trong PATH — cần cài ffmpeg (brew install ffmpeg).'));
        } else {
          reject(new Error(`video.assembleShort: lỗi khi chạy ffmpeg — ${err.message}`));
        }
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          const tail = stderr.slice(-STDERR_TAIL_LEN);
          reject(new Error(`video.assembleShort: ffmpeg thoát với mã lỗi ${code} — ${tail}`));
        }
      });
    });
  });
}

/** Filter chain scale/crop (cover) hoặc scale/pad (contain) tới đúng WxH —
 * identical rationale to `video.compose.ts`'s `buildScaleFilter`. */
function buildScaleFilter(params: Params): string {
  const { width, height, fit } = params;
  return fit === 'cover'
    ? `scale=w=${width}:h=${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

const VIDEO_ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
const AUDIO_ENCODE_ARGS = ['-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2', '-b:a', '192k'];

/** Cuts+normalizes 1 moment's talking segment to the target WxH/fps/codec.
 *
 * `sourceHasAudio` (probed ONCE up front from the source video, see
 * `hasAudioStream`) decides how the audio track is produced: when the
 * source has one, its real audio is cut+encoded as before. When it
 * DOESN'T, every talk clip must still carry a silent `anullsrc` audio
 * track (same sample rate/channels as the b-roll stills' — see
 * `buildBrollClip`) — otherwise talk clips would come out video-only while
 * b-roll stills carry audio, a mismatched stream layout that makes the
 * concat-demuxer `-c copy` step fail/produce a broken output. */
async function buildTalkClip(
  srcPath: string,
  start: number,
  end: number,
  outputPath: string,
  params: Params,
  ctx: ExecutionContext,
  sourceHasAudio: boolean,
): Promise<void> {
  const vf = `${buildScaleFilter(params)},fps=${params.fps},setsar=1`;
  const durationSec = end - start;
  const args = sourceHasAudio
    ? [
        '-y',
        '-ss',
        start.toFixed(3),
        '-to',
        end.toFixed(3),
        '-i',
        srcPath,
        '-vf',
        vf,
        ...VIDEO_ENCODE_ARGS,
        '-r',
        String(params.fps),
        ...AUDIO_ENCODE_ARGS,
        outputPath,
      ]
    : [
        '-y',
        '-ss',
        start.toFixed(3),
        '-to',
        end.toFixed(3),
        '-i',
        srcPath,
        '-f',
        'lavfi',
        '-i',
        `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
        '-vf',
        vf,
        '-map',
        '0:v',
        '-map',
        '1:a',
        ...VIDEO_ENCODE_ARGS,
        '-r',
        String(params.fps),
        ...AUDIO_ENCODE_ARGS,
        '-t',
        durationSec.toFixed(3),
        outputPath,
      ];
  await runFfmpeg(args, ctx);
}

/** Builds a fullscreen b-roll cutaway still clip from an image, `durationSec`
 * long, with a silent `anullsrc` audio track (same sample rate/channels as
 * the talk clips) so the concat-demuxer stream layout stays consistent. */
async function buildBrollClip(
  imgPath: string,
  durationSec: number,
  outputPath: string,
  params: Params,
  ctx: ExecutionContext,
): Promise<void> {
  const vf = `${buildScaleFilter(params)},fps=${params.fps},setsar=1`;
  const args = [
    '-y',
    '-loop',
    '1',
    '-t',
    durationSec.toFixed(3),
    '-i',
    imgPath,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
    '-vf',
    vf,
    '-map',
    '0:v',
    '-map',
    '1:a',
    ...VIDEO_ENCODE_ARGS,
    '-r',
    String(params.fps),
    ...AUDIO_ENCODE_ARGS,
    '-t',
    durationSec.toFixed(3),
    outputPath,
  ];
  await runFfmpeg(args, ctx);
}

/** Concat-demuxer stream copy of pre-normalized clips (all sharing the same
 * codec/format/WxH/fps/audio params — see the module doc comment) into 1
 * mp4. Paths are escaped per ffmpeg's concat-file quoting rules (single
 * quotes around each path, internal `'`/`\` escaped). */
async function concatClips(clipPaths: string[], listPath: string, outputPath: string, ctx: ExecutionContext): Promise<void> {
  const listContent = clipPaths
    .map((p) => `file '${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
    .join('\n');
  await writeFile(listPath, listContent, 'utf8');
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath], ctx);
}

function parsePlan(raw: unknown): CutPlan {
  const result = CutPlanSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `video.assembleShort: input "plan" không hợp lệ theo CutPlan — nối output của broll.generate/flow.approveGate vào node này. Lỗi: ${result.error.message}`,
    );
  }
  return result.data;
}

export const videoAssembleShortNode: NodeDefinition<Params> = {
  type: 'video.assembleShort',
  category: 'video',
  title: 'Video: Dựng short',
  description:
    'Cắt các khoảnh khắc theo CutPlan từ video nguồn, chèn b-roll cutaway toàn màn hình sau mỗi đoạn nói, ghép thành 1 short 9:16 bằng ffmpeg cục bộ.',
  inputs: {
    video: { type: 'video', required: true },
    plan: { type: 'json', required: true },
  },
  outputs: { video: { type: 'video' } },
  paramsSchema: ParamsSchema,
  cacheable: true,
  execute: async ({ inputs, params, ctx }) => {
    const srcPath = resolveMediaPath(inputs.video as MediaValue, ctx.artifactsDir, 'video');
    const plan = parsePlan(inputs.plan);

    if (plan.moments.length === 0) {
      throw new Error('video.assembleShort: CutPlan không có khoảnh khắc nào (moments rỗng) — không có gì để dựng.');
    }

    const moments = [...plan.moments].sort((a, b) => a.start - b.start);
    const sourceHasAudio = hasAudioStream(srcPath);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ff-assemble-short-'));
    try {
      const clipPaths: string[] = [];

      for (let i = 0; i < moments.length; i += 1) {
        if (ctx.signal.aborted) {
          throw new Error('video.assembleShort: đã bị hủy (abort).');
        }
        const moment = moments[i]!;

        ctx.log(`[video.assembleShort] ${i + 1}/${moments.length}: cắt đoạn nói "${moment.title}" (${moment.start}s-${moment.end}s).`);
        const talkClipPath = path.join(tmpDir, `talk-${i}.mp4`);
        await buildTalkClip(srcPath, moment.start, moment.end, talkClipPath, params, ctx, sourceHasAudio);
        clipPaths.push(talkClipPath);

        if (moment.brollImage?.path) {
          const imgPath = resolveMediaPath({ kind: 'image', path: moment.brollImage.path }, ctx.artifactsDir, `brollImage[${i}]`);
          const durationSec = moment.brollDurationSec ?? params.brollDurationSec ?? params.defaultBrollDurationSec;
          ctx.log(`[video.assembleShort] ${i + 1}/${moments.length}: chèn b-roll ${durationSec}s.`);
          const brollClipPath = path.join(tmpDir, `broll-${i}.mp4`);
          await buildBrollClip(imgPath, durationSec, brollClipPath, params, ctx);
          clipPaths.push(brollClipPath);
        }
      }

      const listPath = path.join(tmpDir, 'concat.txt');
      const finalPath = path.join(tmpDir, 'final.mp4');
      await concatClips(clipPaths, listPath, finalPath, ctx);

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
          fps: params.fps,
          momentCount: moments.length,
          clipCount: clipPaths.length,
        },
      };
      return { video: media };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
};
