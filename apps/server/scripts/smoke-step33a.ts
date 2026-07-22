#!/usr/bin/env tsx
/**
 * Manual smoke for SPEC-step33a: runs the real `video.transcribe` node
 * (ffmpeg audio-extract → fal storage upload → wizper) against a short clip.
 * Spends a tiny amount of real fal credit. Run by hand:
 *   pnpm --filter server exec tsx scripts/smoke-step33a.ts <path-to-video>
 * Never prints API key values.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../src/engine/context.js';
import { videoTranscribeNode } from '../src/nodes/video.transcribe.js';
import { findRepoRoot } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const artifactsDir = path.join(repoRoot, 'data', 'artifacts');

const clip = process.argv[2];
if (!clip) {
  console.error('Usage: tsx scripts/smoke-step33a.ts <path-to-video>');
  process.exit(1);
}

const controller = new AbortController();
const ctx = createContext({
  runId: 'smoke-33a',
  nodeId: 'transcribe',
  artifactsDir,
  signal: controller.signal,
  onLog: (m) => console.log('  [log]', m),
});

const params = videoTranscribeNode.paramsSchema.parse({});
console.log('Params:', JSON.stringify(params));
console.log('Transcribing:', clip);

const t0 = Date.now();
const out = await videoTranscribeNode.execute({
  inputs: { video: { kind: 'video', path: path.resolve(clip) } },
  params,
  ctx,
});
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('\n=== text ===\n' + String((out as { text: string }).text));
console.log('\n=== segments ===');
for (const s of (out as { segments: Array<{ start: number; end: number; text: string }> }).segments) {
  console.log(`  [${s.start.toFixed(2)}–${s.end.toFixed(2)}] ${s.text}`);
}
