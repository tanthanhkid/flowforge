/**
 * SPEC-step12.md §3 — video-compose.test.ts. Exercises the real `ffmpeg`
 * binary (spawn, no npm dep) end-to-end against tiny `lavfi`-generated
 * fixtures — free, local, no network calls. Skips the whole file if
 * `ffmpeg`/`ffprobe` aren't on PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/engine/context.js';
import type { MediaValue } from '../src/engine/types.js';
import { videoComposeNode } from '../src/nodes/video.compose.js';

function hasFfmpeg(): boolean {
  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  const ffprobe = spawnSync('ffprobe', ['-version']);
  return ffmpeg.status === 0 && ffprobe.status === 0;
}

const FFMPEG_AVAILABLE = hasFfmpeg();

interface ProbeInfo {
  durationSec: number;
  width?: number;
  height?: number;
  videoStreams: number;
  audioStreams: number;
}

function probe(filePath: string): ProbeInfo {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=width,height,codec_type',
    '-of',
    'json',
    filePath,
  ]).toString();
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type: string; width?: number; height?: number }>;
  };
  const streams = json.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(json.format?.duration ?? 0),
    width: videoStream?.width,
    height: videoStream?.height,
    videoStreams: streams.filter((s) => s.codec_type === 'video').length,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
  };
}

function media(kind: 'video' | 'audio', filePath: string): MediaValue {
  return { kind, path: filePath };
}

describe.skipIf(!FFMPEG_AVAILABLE)('video.compose (real ffmpeg)', () => {
  let workDir: string;
  let artifactsDir: string;
  let redPath: string;
  let greenPath: string;
  let audioPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'ff-compose-test-'));
    artifactsDir = path.join(workDir, 'artifacts');

    redPath = path.join(workDir, 'red.mp4');
    greenPath = path.join(workDir, 'green.mp4');
    audioPath = path.join(workDir, 'audio.mp3');

    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      redPath,
    ]);
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=320x240:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      greenPath,
    ]);
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libmp3lame', audioPath]);
  }, 30_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeCtx() {
    const controller = new AbortController();
    return createContext({ runId: 'run-1', nodeId: 'video-compose-1', artifactsDir, signal: controller.signal });
  }

  it('loops video to match a longer audio (loopVideo=true) — duration ≈ audio length, has video+audio streams', async () => {
    const out = await videoComposeNode.execute({
      inputs: { video: media('video', redPath), audio: media('audio', audioPath) },
      params: videoComposeNode.paramsSchema.parse({ width: 320, height: 568, loopVideo: true }),
      ctx: makeCtx(),
    });
    const result = out.video as MediaValue;
    expect(result.path).toBeTruthy();
    const info = probe(path.join(artifactsDir, result.path!));
    expect(info.durationSec).toBeGreaterThanOrEqual(4.5);
    expect(info.durationSec).toBeLessThanOrEqual(5.5);
    expect(info.width).toBe(320);
    expect(info.height).toBe(568);
    expect(info.videoStreams).toBe(1);
    expect(info.audioStreams).toBe(1);
  }, 30_000);

  it('keeps original video length when loopVideo=false — audio cut to video duration (≈2s)', async () => {
    const out = await videoComposeNode.execute({
      inputs: { video: media('video', redPath), audio: media('audio', audioPath) },
      params: videoComposeNode.paramsSchema.parse({ width: 320, height: 568, loopVideo: false }),
      ctx: makeCtx(),
    });
    const result = out.video as MediaValue;
    const info = probe(path.join(artifactsDir, result.path!));
    expect(info.durationSec).toBeGreaterThanOrEqual(1.5);
    expect(info.durationSec).toBeLessThanOrEqual(2.5);
    expect(info.videoStreams).toBe(1);
    expect(info.audioStreams).toBe(1);
  }, 30_000);

  it('concatenates 2 videos (2s + 1s, no audio) — duration ≈ 3s, only a video stream', async () => {
    const out = await videoComposeNode.execute({
      inputs: { video: media('video', redPath), video2: media('video', greenPath) },
      params: videoComposeNode.paramsSchema.parse({ width: 320, height: 568 }),
      ctx: makeCtx(),
    });
    const result = out.video as MediaValue;
    const info = probe(path.join(artifactsDir, result.path!));
    expect(info.durationSec).toBeGreaterThanOrEqual(2.5);
    expect(info.durationSec).toBeLessThanOrEqual(3.5);
    expect(info.videoStreams).toBe(1);
    expect(info.audioStreams).toBe(0);
  }, 30_000);

  it('fit=cover and fit=contain both produce the exact target width/height', async () => {
    const cover = await videoComposeNode.execute({
      inputs: { video: media('video', redPath) },
      params: videoComposeNode.paramsSchema.parse({ width: 200, height: 356, fit: 'cover' }),
      ctx: makeCtx(),
    });
    const coverInfo = probe(path.join(artifactsDir, (cover.video as MediaValue).path!));
    expect(coverInfo.width).toBe(200);
    expect(coverInfo.height).toBe(356);

    const contain = await videoComposeNode.execute({
      inputs: { video: media('video', redPath) },
      params: videoComposeNode.paramsSchema.parse({ width: 200, height: 356, fit: 'contain' }),
      ctx: makeCtx(),
    });
    const containInfo = probe(path.join(artifactsDir, (contain.video as MediaValue).path!));
    expect(containInfo.width).toBe(200);
    expect(containInfo.height).toBe(356);
  }, 30_000);

  it('throws a clear error when the video file is missing', async () => {
    await expect(
      videoComposeNode.execute({
        inputs: { video: { kind: 'video', path: path.join(workDir, 'nope.mp4') } },
        params: videoComposeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/không tìm thấy/);
  });

  it('throws a clear error when a MediaValue only has a url (no local file)', async () => {
    await expect(
      videoComposeNode.execute({
        inputs: { video: { kind: 'video', url: 'https://example.com/x.mp4' } },
        params: videoComposeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/url/);
  });

  it('throws a clear error when no video input is given at all', async () => {
    await expect(
      videoComposeNode.execute({
        inputs: {},
        params: videoComposeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/video/);
  });
});
