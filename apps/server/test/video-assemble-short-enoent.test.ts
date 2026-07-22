/**
 * SPEC-step33.md §33d — video-assemble-short-enoent.test.ts. Isolated from
 * `video-assemble-short.test.ts` (which uses the REAL ffmpeg binary) because
 * this file mocks `node:child_process`'s `spawn` globally to simulate
 * ffmpeg missing from PATH (ENOENT) — mixing that with real-ffmpeg spawns in
 * the same file/process would be fragile.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CutPlanSchema, type CutPlan } from 'shared';
import type { ExecutionContext, MediaValue } from '../src/engine/types.js';

const spawnMock = vi.fn();

// `hasAudioStream` (added by the Opus-review "no-audio source" fix) calls
// `execFileSync('ffprobe', ...)` up front, BEFORE any `spawn('ffmpeg', ...)`
// — ffprobe ships alongside ffmpeg, so "ffmpeg missing from PATH" realistically
// means ffprobe is missing too. Mock it to the same ENOENT so this test still
// exercises (and asserts) the intended "cài ffmpeg" message, just surfaced
// from `hasAudioStream` instead of `runFfmpeg` now.
const execFileSyncMock = vi.fn(() => {
  throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

const { videoAssembleShortNode } = await import('../src/nodes/video.assembleShort.js');

afterEach(() => {
  spawnMock.mockReset();
});

function makeEnoentChild(): EventEmitter & { kill: () => void; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { kill: () => void; stderr: EventEmitter };
  child.kill = () => {};
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
  });
  return child;
}

function makeCtx(): ExecutionContext {
  const controller = new AbortController();
  return {
    runId: 'run-1',
    nodeId: 'assemble-enoent',
    signal: controller.signal,
    artifactsDir: '/tmp/does-not-matter',
    log: () => {},
    saveArtifact: async () => 'fake.mp4',
    poll: async (check) => {
      const r = await check();
      return r.value as never;
    },
  };
}

function media(kind: 'video', filePath: string): MediaValue {
  return { kind, path: filePath };
}

describe('video.assembleShort — ffmpeg not on PATH (ENOENT)', () => {
  it('surfaces a clear "cài ffmpeg" error instead of a raw ENOENT', async () => {
    spawnMock.mockImplementation(() => makeEnoentChild());

    const plan: CutPlan = CutPlanSchema.parse({ moments: [{ id: 'm1', start: 0, end: 1, title: 'x' }] });

    await expect(
      videoAssembleShortNode.execute({
        inputs: { video: media('video', '/tmp/fake-src.mp4'), plan },
        params: videoAssembleShortNode.paramsSchema.parse({}),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/cài ffmpeg/);
  });
});
