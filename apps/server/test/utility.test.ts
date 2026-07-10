/**
 * SPEC-step2.md §9 — utility.test.ts. Pure node.execute() calls, no network.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { poll } from '../src/engine/context.js';
import type { ExecutionContext } from '../src/engine/types.js';
import { inputFileNode } from '../src/nodes/input.file.js';
import { inputTextNode } from '../src/nodes/input.text.js';
import { outputCollectNode } from '../src/nodes/output.collect.js';
import { textTemplateNode } from '../src/nodes/text.template.js';

function makeCtx(artifactsDir: string): ExecutionContext {
  const controller = new AbortController();
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    signal: controller.signal,
    artifactsDir,
    log: () => {},
    saveArtifact: async () => 'unused.bin',
    poll: (check, opts) => poll(check, controller.signal, opts),
  };
}

describe('input.text', () => {
  it('emits the fixed params.value', async () => {
    const out = await inputTextNode.execute({ inputs: {}, params: { value: 'hello world' }, ctx: makeCtx('/tmp') });
    expect(out.text).toBe('hello world');
  });

  it('defaults to an empty string via the params schema', async () => {
    const parsed = inputTextNode.paramsSchema.parse({});
    expect(parsed.value).toBe('');
  });
});

describe('text.template', () => {
  it('fills present slots, tolerates whitespace inside braces, empties missing slots, and leaves unknown slots untouched', async () => {
    const out = await textTemplateNode.execute({
      inputs: { a: 'Alice', c: undefined },
      params: { template: 'Hi {{a}}, bye {{ b }}! Keep {{zzz}} as-is.' },
      ctx: makeCtx('/tmp'),
    });
    expect(out.text).toBe('Hi Alice, bye ! Keep {{zzz}} as-is.');
  });

  it('handles all 4 slots a/b/c/d together', async () => {
    const out = await textTemplateNode.execute({
      inputs: { a: '1', b: '2', c: '3', d: '4' },
      params: { template: '{{a}}-{{b}}-{{c}}-{{d}}' },
      ctx: makeCtx('/tmp'),
    });
    expect(out.text).toBe('1-2-3-4');
  });
});

describe('input.file', () => {
  it('resolves a relative path against artifactsDir and infers kind/mime from the extension', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputfile-'));
    try {
      writeFileSync(path.join(tmp, 'photo.jpg'), Buffer.from([1, 2, 3]));
      const out = await inputFileNode.execute({
        inputs: {},
        params: { path: 'photo.jpg' },
        ctx: makeCtx(tmp),
      });
      expect(out.file).toEqual({ kind: 'image', path: 'photo.jpg', mime: 'image/jpeg' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('classifies audio/video extensions correctly', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputfile-kinds-'));
    try {
      writeFileSync(path.join(tmp, 'clip.mp4'), Buffer.from([1]));
      writeFileSync(path.join(tmp, 'track.mp3'), Buffer.from([1]));

      const video = await inputFileNode.execute({ inputs: {}, params: { path: 'clip.mp4' }, ctx: makeCtx(tmp) });
      expect((video.file as { kind: string }).kind).toBe('video');

      const audio = await inputFileNode.execute({ inputs: {}, params: { path: 'track.mp3' }, ctx: makeCtx(tmp) });
      expect((audio.file as { kind: string }).kind).toBe('audio');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the file does not exist', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputfile-missing-'));
    try {
      await expect(
        inputFileNode.execute({ inputs: {}, params: { path: 'nope.png' }, ctx: makeCtx(tmp) }),
      ).rejects.toThrow(/nope\.png/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws a clear error listing supported extensions for an unsupported extension', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputfile-badext-'));
    try {
      writeFileSync(path.join(tmp, 'doc.xyz'), Buffer.from([1]));
      await expect(
        inputFileNode.execute({ inputs: {}, params: { path: 'doc.xyz' }, ctx: makeCtx(tmp) }),
      ).rejects.toThrow(/xyz/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('output.collect', () => {
  it('gathers connected inputs (in1..in4) into a single results object', async () => {
    const out = await outputCollectNode.execute({
      inputs: { in1: 'text value', in2: { kind: 'image', path: 'x.png' }, in3: undefined, in4: 42 },
      params: {},
      ctx: makeCtx('/tmp'),
    });
    expect(out.results).toEqual({ in1: 'text value', in2: { kind: 'image', path: 'x.png' }, in4: 42 });
  });

  it('returns an empty object when nothing is connected', async () => {
    const out = await outputCollectNode.execute({ inputs: {}, params: {}, ctx: makeCtx('/tmp') });
    expect(out.results).toEqual({});
  });
});
