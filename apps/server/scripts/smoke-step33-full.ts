#!/usr/bin/env tsx
/**
 * Manual FULL-pipeline smoke for SPEC-step33: runs the real video→short chain
 * end to end on a real video — transcribe (fal wizper) → selectMoments
 * (OpenRouter) → [auto-approve gate] → broll.generate (fal image ×N) →
 * video.assembleShort (ffmpeg). Spends real fal + OpenRouter credit.
 *   pnpm --filter server exec tsx scripts/smoke-step33-full.ts <video> [maxMoments]
 * Never prints API keys.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../src/engine/context.js';
import { findRepoRoot } from '../src/config.js';
import { videoTranscribeNode } from '../src/nodes/video.transcribe.js';
import { llmSelectMomentsNode } from '../src/nodes/llm.selectMoments.js';
import { brollGenerateNode } from '../src/nodes/broll.generate.js';
import { videoAssembleShortNode } from '../src/nodes/video.assembleShort.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const artifactsDir = path.join(repoRoot, 'data', 'artifacts');

const clip = process.argv[2];
const maxMoments = Number(process.argv[3] ?? 5);
if (!clip) {
  console.error('Usage: tsx scripts/smoke-step33-full.ts <video> [maxMoments]');
  process.exit(1);
}
const videoPath = path.resolve(clip);
const controller = new AbortController();
const mkCtx = (nodeId: string) =>
  createContext({ runId: 'smoke-33-full', nodeId, artifactsDir, signal: controller.signal, onLog: (m) => console.log('   ', m) });

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

console.log(`[1/4] Transcribe (fal wizper) — ${videoPath}`);
const tr = (await videoTranscribeNode.execute({
  inputs: { video: { kind: 'video', path: videoPath } },
  params: videoTranscribeNode.paramsSchema.parse({}),
  ctx: mkCtx('transcribe'),
})) as { text: string; segments: Array<{ start: number; end: number; text: string }> };
console.log(`  → ${tr.segments.length} segment(s), ${tr.text.length} ký tự [${el()}]`);
console.log(`  transcript đầu: ${tr.text.slice(0, 200)}...`);

console.log(`\n[2/4] Select moments (OpenRouter, maxMoments=${maxMoments})`);
const sm = (await llmSelectMomentsNode.execute({
  inputs: { segments: tr.segments },
  params: llmSelectMomentsNode.paramsSchema.parse({ maxMoments }),
  ctx: mkCtx('moments'),
})) as { plan: { moments: Array<{ id: string; start: number; end: number; title: string; brollPrompt?: string }> } };
console.log(`  → ${sm.plan.moments.length} khoảnh khắc [${el()}]:`);
for (const m of sm.plan.moments) {
  console.log(`    • [${m.start.toFixed(1)}–${m.end.toFixed(1)}] ${m.title}`);
  console.log(`      b-roll: ${m.brollPrompt ?? '(none)'}`);
}

console.log(`\n[gate] auto-approve (không sửa)`);

console.log(`\n[3/4] Gen b-roll (fal image)`);
const br = (await brollGenerateNode.execute({
  inputs: { plan: sm.plan },
  params: brollGenerateNode.paramsSchema.parse({}),
  ctx: mkCtx('broll'),
})) as { plan: { moments: Array<{ id: string; brollImage?: { path: string } }> } };
const withImg = br.plan.moments.filter((m) => m.brollImage?.path).length;
console.log(`  → ${withImg}/${br.plan.moments.length} moment có ảnh b-roll [${el()}]`);

console.log(`\n[4/4] Assemble short (ffmpeg 9:16)`);
const as = (await videoAssembleShortNode.execute({
  inputs: { video: { kind: 'video', path: videoPath }, plan: br.plan },
  params: videoAssembleShortNode.paramsSchema.parse({}),
  ctx: mkCtx('assemble'),
})) as { video: { path: string } };
console.log(`\n✅ SHORT: ${path.join(artifactsDir, as.video.path)} [${el()}]`);
