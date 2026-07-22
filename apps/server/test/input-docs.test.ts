/**
 * SPEC-step10.md §1.3 — input-docs.test.ts. Pure node.execute() calls
 * (input.image / input.pdf / input.markdown), no network, plus a registry
 * count check (12 = 9 MVP + the 3 new nodes from this step).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { poll } from '../src/engine/context.js';
import type { ExecutionContext } from '../src/engine/types.js';
import { inputImageNode } from '../src/nodes/input.image.js';
import { inputMarkdownNode } from '../src/nodes/input.markdown.js';
import { inputPdfNode } from '../src/nodes/input.pdf.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

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

describe('input.image', () => {
  it('resolves a relative path against artifactsDir and infers mime from the extension', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputimage-'));
    try {
      writeFileSync(path.join(tmp, 'photo.jpg'), Buffer.from([1, 2, 3]));
      const out = await inputImageNode.execute({ inputs: {}, params: { path: 'photo.jpg' }, ctx: makeCtx(tmp) });
      expect(out.image).toEqual({ kind: 'image', path: 'photo.jpg', mime: 'image/jpeg' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws a clear Vietnamese error when the file is missing', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputimage-missing-'));
    try {
      await expect(
        inputImageNode.execute({ inputs: {}, params: { path: 'nope.png' }, ctx: makeCtx(tmp) }),
      ).rejects.toThrow(/không tìm thấy/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws a clear error for an unsupported extension (e.g. a video file)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputimage-badext-'));
    try {
      writeFileSync(path.join(tmp, 'clip.mp4'), Buffer.from([1]));
      await expect(
        inputImageNode.execute({ inputs: {}, params: { path: 'clip.mp4' }, ctx: makeCtx(tmp) }),
      ).rejects.toThrow(/mp4/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('input.pdf', () => {
  it('extracts text from a small fixture PDF', async () => {
    const out = await inputPdfNode.execute({
      inputs: {},
      params: { path: path.join(fixturesDir, 'tiny.pdf') },
      ctx: makeCtx('/tmp'),
    });
    expect(out.text).toBe('Hello unpdf test');
    expect(out.info).toEqual({ pages: 1, truncated: false });
  });

  it('respects maxPages and reports info.truncated', async () => {
    const out = await inputPdfNode.execute({
      inputs: {},
      params: { path: path.join(fixturesDir, 'multi.pdf'), maxPages: 2 },
      ctx: makeCtx('/tmp'),
    });
    expect(out.text).toBe('Trang mot\n\nTrang hai');
    expect(out.info).toEqual({ pages: 3, truncated: true });
  });

  it('info.truncated is false when maxPages >= total pages', async () => {
    const out = await inputPdfNode.execute({
      inputs: {},
      params: { path: path.join(fixturesDir, 'multi.pdf'), maxPages: 10 },
      ctx: makeCtx('/tmp'),
    });
    expect(out.info).toEqual({ pages: 3, truncated: false });
  });

  it('throws a Vietnamese "chưa OCR" hint for a PDF with no text layer', async () => {
    await expect(
      inputPdfNode.execute({ inputs: {}, params: { path: path.join(fixturesDir, 'scanned.pdf') }, ctx: makeCtx('/tmp') }),
    ).rejects.toThrow(/OCR/);
  });

  it('throws a clear error when the file does not exist', async () => {
    await expect(
      inputPdfNode.execute({ inputs: {}, params: { path: 'nope.pdf' }, ctx: makeCtx('/tmp') }),
    ).rejects.toThrow(/không tìm thấy/);
  });

  it('rejects a relative path resolved against artifactsDir', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputpdf-relative-'));
    try {
      writeFileSync(path.join(tmp, 'doc.pdf'), Buffer.alloc(0));
      // Not a valid PDF -> unpdf throws -> wrapped as a clear error, not a crash.
      await expect(
        inputPdfNode.execute({ inputs: {}, params: { path: 'doc.pdf' }, ctx: makeCtx(tmp) }),
      ).rejects.toThrow(/doc\.pdf/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('input.markdown', () => {
  it('returns params.content directly when given', async () => {
    const out = await inputMarkdownNode.execute({
      inputs: {},
      params: { content: '# Hello\n\nWorld' },
      ctx: makeCtx('/tmp'),
    });
    expect(out.text).toBe('# Hello\n\nWorld');
  });

  it('reads a .md file from a relative path', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputmd-'));
    try {
      writeFileSync(path.join(tmp, 'note.md'), '# Ghi chú\n\nNội dung tiếng Việt.', 'utf-8');
      const out = await inputMarkdownNode.execute({
        inputs: {},
        params: { path: 'note.md' },
        ctx: makeCtx(tmp),
      });
      expect(out.text).toBe('# Ghi chú\n\nNội dung tiếng Việt.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts .markdown and .txt extensions too', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputmd-ext-'));
    try {
      writeFileSync(path.join(tmp, 'a.markdown'), 'A', 'utf-8');
      writeFileSync(path.join(tmp, 'b.txt'), 'B', 'utf-8');
      const a = await inputMarkdownNode.execute({ inputs: {}, params: { path: 'a.markdown' }, ctx: makeCtx(tmp) });
      const b = await inputMarkdownNode.execute({ inputs: {}, params: { path: 'b.txt' }, ctx: makeCtx(tmp) });
      expect(a.text).toBe('A');
      expect(b.text).toBe('B');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported extension', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-inputmd-badext-'));
    try {
      writeFileSync(path.join(tmp, 'c.docx'), 'x', 'utf-8');
      await expect(
        inputMarkdownNode.execute({ inputs: {}, params: { path: 'c.docx' }, ctx: makeCtx(tmp) }),
      ).rejects.toThrow(/docx/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects when neither path nor content is given', () => {
    expect(() => inputMarkdownNode.paramsSchema.parse({})).toThrow();
  });

  it('rejects when both path and content are given', () => {
    expect(() => inputMarkdownNode.paramsSchema.parse({ path: 'a.md', content: 'x' })).toThrow();
  });
});

describe('createDefaultRegistry (step10)', () => {
  it('registers all node types including input.image/input.pdf/input.markdown', () => {
    const registry = createDefaultRegistry();
    const types = registry.list().map((def) => def.type).sort();
    expect(types).toHaveLength(14);
    expect(types).toContain('input.image');
    expect(types).toContain('input.pdf');
    expect(types).toContain('input.markdown');
  });

  it('describeForAgent() exposes the 3 new node types with their paramsJsonSchema (agent ✨ sees them for free)', () => {
    const registry = createDefaultRegistry();
    const described = registry.describeForAgent();
    expect(described).toHaveLength(14);
    for (const type of ['input.image', 'input.pdf', 'input.markdown']) {
      const entry = described.find((d) => d.type === type);
      expect(entry).toBeDefined();
      expect(entry?.paramsJsonSchema).toBeDefined();
    }
  });
});
