/**
 * SPEC-step33.md §33d — video-assemble-short.test.ts. Exercises the real
 * `ffmpeg`/`ffprobe` binary (spawn, no npm dep) end-to-end against tiny
 * `lavfi`-generated fixtures — free, local, no network calls. Same style as
 * `video-compose.test.ts`/`video-transcribe.test.ts`. Skips the whole file
 * if `ffmpeg`/`ffprobe` aren't on PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CutPlanSchema, type CutPlan } from 'shared';
import { createContext } from '../src/engine/context.js';
import type { MediaValue } from '../src/engine/types.js';
import { videoAssembleShortNode } from '../src/nodes/video.assembleShort.js';

function hasFfmpeg(): boolean {
  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  const ffprobe = spawnSync('ffprobe', ['-version']);
  return ffmpeg.status === 0 && ffprobe.status === 0;
}

const FFMPEG_AVAILABLE = hasFfmpeg();

function probeDurationSec(filePath: string): number {
  const out = execFileSync('ffprobe', [
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
  return Number(out);
}

function probeStreams(filePath: string): { videoStreams: number; audioStreams: number } {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'json',
    filePath,
  ]).toString();
  const json = JSON.parse(out) as { streams?: Array<{ codec_type: string }> };
  const streams = json.streams ?? [];
  return {
    videoStreams: streams.filter((s) => s.codec_type === 'video').length,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
  };
}

/** Samples the dominant color of a single downscaled-to-1x1 frame at time
 * `t` seconds into `filePath`, returned as `[r, g, b]`. Used to verify the
 * output clip ORDER (talk-segment footage vs. b-roll still) without any
 * image library — just raw RGB bytes off ffmpeg's own decoder. */
function samplePixelColor(filePath: string, t: number): [number, number, number] {
  const out = execFileSync('ffmpeg', [
    '-y',
    '-ss',
    String(t),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    'scale=1:1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  return [out[0]!, out[1]!, out[2]!];
}

function media(kind: 'video', filePath: string): MediaValue {
  return { kind, path: filePath };
}

describe.skipIf(!FFMPEG_AVAILABLE)('video.assembleShort (real ffmpeg)', () => {
  let workDir: string;
  let artifactsDir: string;
  let srcPath: string;
  let silentSrcPath: string;
  let brollPngPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'ff-assemble-test-'));
    artifactsDir = path.join(workDir, 'artifacts');

    // 4s BLUE video + a sine-wave audio track.
    srcPath = path.join(workDir, 'src.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      srcPath,
    ]);

    // GREEN still image used as the b-roll cutaway.
    brollPngPath = path.join(workDir, 'broll.png');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64', '-frames:v', '1', brollPngPath]);

    // 2s RED video with NO audio stream at all — regression fixture for the
    // Opus-review "no-audio source" fix: talk clips cut from this source
    // must still get a silent audio track so the concat step's stream
    // layout stays consistent with the b-roll stills.
    silentSrcPath = path.join(workDir, 'silent-src.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x64:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      silentSrcPath,
    ]);
  }, 30_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeCtx() {
    const controller = new AbortController();
    return createContext({ runId: 'run-1', nodeId: 'assemble-1', artifactsDir, signal: controller.signal });
  }

  function plan(moments: CutPlan['moments']): CutPlan {
    return CutPlanSchema.parse({ moments });
  }

  it(
    'inserts [talk][broll] in order: talk1(1s) + broll(2s) + talk2(1s) = ~4s, correct pixel colors at each window',
    async () => {
      const cutPlan = plan([
        { id: 'm1', start: 0, end: 1, title: 'talk1', brollImage: { path: brollPngPath, mime: 'image/png' } },
        { id: 'm2', start: 2, end: 3, title: 'talk2' },
      ]);

      const out = await videoAssembleShortNode.execute({
        inputs: { video: media('video', srcPath), plan: cutPlan },
        params: videoAssembleShortNode.paramsSchema.parse({ width: 64, height: 64, fps: 10, brollDurationSec: 2 }),
        ctx: makeCtx(),
      });

      const result = out.video as MediaValue;
      expect(result.path).toBeTruthy();
      const outPath = path.join(artifactsDir, result.path!);

      const durationSec = probeDurationSec(outPath);
      expect(durationSec).toBeGreaterThanOrEqual(3.5);
      expect(durationSec).toBeLessThanOrEqual(4.7);

      const streams = probeStreams(outPath);
      expect(streams.videoStreams).toBe(1);
      expect(streams.audioStreams).toBe(1);

      // Order check: [talk1 0-1s BLUE][broll 1-3s GREEN][talk2 3-4s BLUE].
      const talk1Color = samplePixelColor(outPath, 0.4);
      expect(talk1Color[2]).toBeGreaterThan(talk1Color[0]);
      expect(talk1Color[2]).toBeGreaterThan(talk1Color[1]);

      const brollColor = samplePixelColor(outPath, 1.8);
      expect(brollColor[1]).toBeGreaterThan(brollColor[0]);
      expect(brollColor[1]).toBeGreaterThan(brollColor[2]);

      const talk2Color = samplePixelColor(outPath, 3.4);
      expect(talk2Color[2]).toBeGreaterThan(talk2Color[0]);
      expect(talk2Color[2]).toBeGreaterThan(talk2Color[1]);

      expect(result.meta?.momentCount).toBe(2);
      expect(result.meta?.clipCount).toBe(3); // talk1 + broll1 + talk2 (no broll for m2)
    },
    60_000,
  );

  it('a source video with NO audio stream still assembles cleanly — talk clips get a silent audio track (1 video + 1 audio stream out)', async () => {
    const cutPlan = plan([
      { id: 'm1', start: 0, end: 1, title: 'talk1', brollImage: { path: brollPngPath, mime: 'image/png' } },
      { id: 'm2', start: 1, end: 2, title: 'talk2' },
    ]);

    const out = await videoAssembleShortNode.execute({
      inputs: { video: media('video', silentSrcPath), plan: cutPlan },
      params: videoAssembleShortNode.paramsSchema.parse({ width: 64, height: 64, fps: 10, brollDurationSec: 1 }),
      ctx: makeCtx(),
    });

    const result = out.video as MediaValue;
    const outPath = path.join(artifactsDir, result.path!);

    const streams = probeStreams(outPath);
    expect(streams.videoStreams).toBe(1);
    expect(streams.audioStreams).toBe(1);

    const durationSec = probeDurationSec(outPath);
    // talk1(1s) + broll(1s) + talk2(1s) = ~3s.
    expect(durationSec).toBeGreaterThanOrEqual(2.5);
    expect(durationSec).toBeLessThanOrEqual(3.7);
    expect(result.meta?.clipCount).toBe(3);
  }, 60_000);

  it('a moment with no brollImage contributes no extra cutaway clip', async () => {
    const cutPlan = plan([{ id: 'm1', start: 0, end: 1, title: 'talk-only' }]);

    const out = await videoAssembleShortNode.execute({
      inputs: { video: media('video', srcPath), plan: cutPlan },
      params: videoAssembleShortNode.paramsSchema.parse({ width: 64, height: 64, fps: 10 }),
      ctx: makeCtx(),
    });

    const result = out.video as MediaValue;
    expect(result.meta?.clipCount).toBe(1);
    const durationSec = probeDurationSec(path.join(artifactsDir, result.path!));
    expect(durationSec).toBeGreaterThanOrEqual(0.5);
    expect(durationSec).toBeLessThanOrEqual(1.7);
  }, 30_000);

  it('throws a clear error when the CutPlan has no moments', async () => {
    await expect(
      videoAssembleShortNode.execute({
        inputs: { video: media('video', srcPath), plan: plan([]) },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/không có khoảnh khắc/);
  });

  it('throws a clear error when the source video file is missing', async () => {
    await expect(
      videoAssembleShortNode.execute({
        inputs: {
          video: { kind: 'video', path: path.join(workDir, 'nope.mp4') },
          plan: plan([{ id: 'm1', start: 0, end: 1, title: 'x' }]),
        },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/không tìm thấy/);
  });

  it('throws a clear error when the video MediaValue only has a url (no local file)', async () => {
    await expect(
      videoAssembleShortNode.execute({
        inputs: {
          video: { kind: 'video', url: 'https://example.com/x.mp4' },
          plan: plan([{ id: 'm1', start: 0, end: 1, title: 'x' }]),
        },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/url/);
  });

  it('throws a clear error when "plan" does not match CutPlanSchema', async () => {
    await expect(
      videoAssembleShortNode.execute({
        inputs: { video: media('video', srcPath), plan: { moments: 'nope' } },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/CutPlan/);
  });

  it('throws a clear error when a moment.brollImage.path points to a missing file', async () => {
    await expect(
      videoAssembleShortNode.execute({
        inputs: {
          video: media('video', srcPath),
          plan: plan([{ id: 'm1', start: 0, end: 1, title: 'x', brollImage: { path: path.join(workDir, 'missing.png') } }]),
        },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/không tìm thấy/);
  });

  it('an already-aborted ctx.signal rejects before ever spawning ffmpeg', async () => {
    const controller = new AbortController();
    const ctx = createContext({ runId: 'run-1', nodeId: 'assemble-abort', artifactsDir, signal: controller.signal });
    controller.abort();

    await expect(
      videoAssembleShortNode.execute({
        inputs: { video: media('video', srcPath), plan: plan([{ id: 'm1', start: 0, end: 1, title: 'x' }]) },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx,
      }),
    ).rejects.toThrow(/hủy|abort/i);
  });

  it('cleans up its temp dir even on failure (no leftover ff-assemble-short- dirs)', async () => {
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('ff-assemble-short-'));

    await expect(
      videoAssembleShortNode.execute({
        inputs: {
          video: media('video', srcPath),
          plan: plan([{ id: 'm1', start: 0, end: 1, title: 'x', brollImage: { path: path.join(workDir, 'missing.png') } }]),
        },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow();

    const after = readdirSync(os.tmpdir()).filter((n) => n.startsWith('ff-assemble-short-'));
    expect(after.length).toBe(before.length);
  }, 30_000);
});
