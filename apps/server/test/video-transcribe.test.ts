/**
 * SPEC-step33.md §33a — video-transcribe.test.ts. Real `ffmpeg`/`ffprobe`
 * binary for the audio-extraction half (spawn, no npm dep, tiny
 * `lavfi`-generated fixture — same style as `video-compose.test.ts`), with
 * `providers/fal.js`'s `runFalQueue`/`uploadToFal` mocked so the fal.ai part
 * never hits the network. Skips the whole file if ffmpeg isn't on PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/engine/context.js';
import type { MediaValue } from '../src/engine/types.js';

const runFalQueueMock = vi.fn();
const uploadToFalMock = vi.fn();

vi.mock('../src/nodes/providers/fal.js', () => ({
  runFalQueue: runFalQueueMock,
  uploadToFal: uploadToFalMock,
}));

// Imported AFTER the mock above so `video.transcribe.ts`'s own import of
// `./providers/fal.js` resolves to the mocked module.
const { videoTranscribeNode } = await import('../src/nodes/video.transcribe.js');

function hasFfmpeg(): boolean {
  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  return ffmpeg.status === 0;
}

const FFMPEG_AVAILABLE = hasFfmpeg();

function media(kind: 'video', filePath: string): MediaValue {
  return { kind, path: filePath };
}

describe.skipIf(!FFMPEG_AVAILABLE)('video.transcribe (real ffmpeg extract + mocked fal)', () => {
  let workDir: string;
  let artifactsDir: string;
  let videoPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'ff-transcribe-test-'));
    artifactsDir = path.join(workDir, 'artifacts');
    videoPath = path.join(workDir, 'clip.mp4');

    // 1s video + a sine-wave audio track, tiny and fast.
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x120:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      videoPath,
    ]);
  }, 30_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    runFalQueueMock.mockReset();
    uploadToFalMock.mockReset();
  });

  function makeCtx() {
    const controller = new AbortController();
    return createContext({ runId: 'run-1', nodeId: 'transcribe-1', artifactsDir, signal: controller.signal });
  }

  it('extracts audio, uploads it, calls fal wizper, and maps chunks -> segments', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({
      text: 'hello world',
      chunks: [
        { timestamp: [0, 0.5], text: 'hello' },
        { timestamp: [0.5, 1.0], text: 'world' },
      ],
    });

    const out = await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });

    expect(out.text).toBe('hello world');
    expect(out.segments).toEqual([
      { start: 0, end: 0.5, text: 'hello' },
      { start: 0.5, end: 1.0, text: 'world' },
    ]);

    // uploadToFal got real extracted-audio bytes (mp3, non-empty), and
    // runFalQueue got audio_url pointing at the uploaded file + task.
    expect(uploadToFalMock).toHaveBeenCalledTimes(1);
    const [uploadedBuffer, uploadedFilename, uploadedContentType] = uploadToFalMock.mock.calls[0]!;
    expect(Buffer.isBuffer(uploadedBuffer)).toBe(true);
    expect((uploadedBuffer as Buffer).length).toBeGreaterThan(0);
    expect(uploadedFilename).toBe('audio.mp3');
    expect(uploadedContentType).toBe('audio/mpeg');

    expect(runFalQueueMock).toHaveBeenCalledTimes(1);
    const call = runFalQueueMock.mock.calls[0]![0];
    expect(call.modelId).toBe('fal-ai/wizper');
    expect(call.input).toEqual({ audio_url: 'https://cdn.fal.ai/files/uploaded.mp3', task: 'transcribe' });
  }, 30_000);

  it('language: "auto" (default) omits the language field from the fal input', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({ text: '', chunks: [] });

    await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({ language: 'auto' }),
      ctx: makeCtx(),
    });

    const call = runFalQueueMock.mock.calls[0]![0];
    expect(call.input).not.toHaveProperty('language');
  }, 30_000);

  it('a non-"auto" language is passed through to the fal input', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({ text: '', chunks: [] });

    await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({ language: 'vi' }),
      ctx: makeCtx(),
    });

    const call = runFalQueueMock.mock.calls[0]![0];
    expect(call.input.language).toBe('vi');
  }, 30_000);

  it('chunks with a missing/invalid timestamp are skipped when mapping to segments', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({
      text: 'a b',
      chunks: [{ text: 'a' }, { timestamp: [1, 2], text: 'b' }],
    });

    const out = await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });

    expect(out.segments).toEqual([{ start: 1, end: 2, text: 'b' }]);
  }, 30_000);

  it('keeps a trailing chunk with a null end timestamp (wizper/whisper convention) — clamped to its own start, not dropped', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({
      text: 'foo bar',
      chunks: [
        { timestamp: [0, 1], text: 'foo' },
        { timestamp: [1, null], text: 'bar' },
      ],
    });

    const out = await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });

    expect(out.segments).toEqual([
      { start: 0, end: 1, text: 'foo' },
      { start: 1, end: 1, text: 'bar' },
    ]);
  }, 30_000);

  it('clamps a non-trailing chunk with a null end to the NEXT chunk\'s start', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({
      text: 'foo bar baz',
      chunks: [
        { timestamp: [0, null], text: 'foo' },
        { timestamp: [2, 3], text: 'bar' },
        { timestamp: [3, 4], text: 'baz' },
      ],
    });

    const out = await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });

    expect(out.segments).toEqual([
      { start: 0, end: 2, text: 'foo' },
      { start: 2, end: 3, text: 'bar' },
      { start: 3, end: 4, text: 'baz' },
    ]);
  }, 30_000);

  it('falls back to joining segment text when the fal result has no top-level text', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockResolvedValue({
      chunks: [
        { timestamp: [0, 1], text: 'foo' },
        { timestamp: [1, 2], text: 'bar' },
      ],
    });

    const out = await videoTranscribeNode.execute({
      inputs: { video: media('video', videoPath) },
      params: videoTranscribeNode.paramsSchema.parse({}),
      ctx: makeCtx(),
    });

    expect(out.text).toBe('foo bar');
  }, 30_000);

  it('a fal.ai error surfaces a clear message (propagated as-is)', async () => {
    uploadToFalMock.mockResolvedValue('https://cdn.fal.ai/files/uploaded.mp3');
    runFalQueueMock.mockRejectedValue(new Error('fal.ai (model "fal-ai/wizper") failed: HTTP 500 — server error'));

    await expect(
      videoTranscribeNode.execute({
        inputs: { video: media('video', videoPath) },
        params: videoTranscribeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/fal\.ai/);
  }, 30_000);

  it('throws a clear error when the video file is missing', async () => {
    await expect(
      videoTranscribeNode.execute({
        inputs: { video: { kind: 'video', path: path.join(workDir, 'nope.mp4') } },
        params: videoTranscribeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/không tìm thấy/);
    expect(uploadToFalMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when the video MediaValue only has a url (no local file)', async () => {
    await expect(
      videoTranscribeNode.execute({
        inputs: { video: { kind: 'video', url: 'https://example.com/x.mp4' } },
        params: videoTranscribeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/url/);
    expect(uploadToFalMock).not.toHaveBeenCalled();
  });

  it('an already-aborted ctx.signal rejects before ever spawning ffmpeg or calling fal', async () => {
    const controller = new AbortController();
    const ctx = createContext({ runId: 'run-1', nodeId: 'transcribe-abort', artifactsDir, signal: controller.signal });
    controller.abort();

    await expect(
      videoTranscribeNode.execute({
        inputs: { video: media('video', videoPath) },
        params: videoTranscribeNode.paramsSchema.parse({}),
        ctx,
      }),
    ).rejects.toThrow(/hủy|abort/i);
    expect(uploadToFalMock).not.toHaveBeenCalled();
    expect(runFalQueueMock).not.toHaveBeenCalled();
  }, 30_000);

  it('cleans up its temp dir even on failure (no leftover ff-video-transcribe- dirs)', async () => {
    uploadToFalMock.mockRejectedValue(new Error('boom'));

    const { readdirSync } = await import('node:fs');
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('ff-video-transcribe-'));

    await expect(
      videoTranscribeNode.execute({
        inputs: { video: media('video', videoPath) },
        params: videoTranscribeNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/boom/);

    const after = readdirSync(os.tmpdir()).filter((n) => n.startsWith('ff-video-transcribe-'));
    expect(after.length).toBe(before.length);
  }, 30_000);
});
