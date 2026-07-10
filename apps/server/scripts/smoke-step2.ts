#!/usr/bin/env tsx
/**
 * Manual smoke test for the real provider integrations (SPEC-step2.md §8):
 * runs 3 small, cheap workflows against OpenRouter, Vbee, and fal.ai using
 * real keys from `.env.local`. NOT a vitest test — spends real API credits,
 * run by hand only:
 *
 *   pnpm --filter server smoke
 *
 * Never prints API key values — only node states and artifact paths.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine, type RunResult } from '../src/engine/executor.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import type { MediaValue } from '../src/engine/types.js';
import { findRepoRoot } from '../src/config.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const artifactsDir = path.join(repoRoot, 'data', 'artifacts');

const workflows: Workflow[] = [
  {
    version: 1,
    id: 'smoke-llm-generate',
    name: 'Smoke: llm.generate',
    nodes: [
      { id: 'in', type: 'input.text', params: { value: 'Trả lời đúng 1 từ: OK' } },
      { id: 'llm', type: 'llm.generate', params: {} },
    ],
    edges: [{ id: 'e1', from: { node: 'in', port: 'text' }, to: { node: 'llm', port: 'prompt' } }],
  },
  {
    version: 1,
    id: 'smoke-vbee-tts',
    name: 'Smoke: vbee.tts',
    nodes: [
      { id: 'in', type: 'input.text', params: { value: 'Xin chào, đây là FlowForge.' } },
      { id: 'tts', type: 'vbee.tts', params: {} },
    ],
    edges: [{ id: 'e1', from: { node: 'in', port: 'text' }, to: { node: 'tts', port: 'text' } }],
  },
  {
    version: 1,
    id: 'smoke-fal-image',
    name: 'Smoke: fal.image',
    nodes: [
      { id: 'in', type: 'input.text', params: { value: 'a cute robot mascot, simple flat illustration' } },
      { id: 'img', type: 'fal.image', params: { modelId: 'fal-ai/flux/schnell' } },
    ],
    edges: [{ id: 'e1', from: { node: 'in', port: 'text' }, to: { node: 'img', port: 'prompt' } }],
  },
];

function summarizeOutputs(outputs: Record<string, unknown> | undefined): string {
  if (!outputs) return '(none)';
  const parts: string[] = [];
  for (const [port, value] of Object.entries(outputs)) {
    if (value && typeof value === 'object' && 'kind' in value && 'path' in value) {
      const media = value as MediaValue;
      const abs = media.path ? path.join(artifactsDir, media.path) : '(no path)';
      parts.push(`${port}=<${media.kind}> ${abs}`);
    } else if (typeof value === 'string') {
      const preview = value.length > 200 ? `${value.slice(0, 200)}…` : value;
      parts.push(`${port}="${preview}"`);
    } else {
      parts.push(`${port}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(', ');
}

function printResult(workflow: Workflow, result: RunResult): void {
  console.log(`\n=== ${workflow.name} (run ${result.runId}, status: ${result.status}) ===`);
  for (const node of workflow.nodes) {
    const nodeResult = result.nodes[node.id];
    if (!nodeResult) continue;
    const line = `  [${nodeResult.state}] ${node.id} (${node.type})`;
    if (nodeResult.state === 'error') {
      console.log(`${line} — ${nodeResult.error}`);
    } else if (nodeResult.state === 'success') {
      console.log(`${line} — ${summarizeOutputs(nodeResult.outputs)}`);
    } else {
      console.log(line);
    }
  }
}

async function main(): Promise<void> {
  const registry = createDefaultRegistry();
  const engine = new Engine(registry, { runs: new InMemoryRunStore(), cache: new InMemoryCacheStore() }, { artifactsDir });

  console.log(`Artifacts dir: ${artifactsDir}`);

  let hadError = false;
  for (const workflow of workflows) {
    try {
      const result = await engine.run(workflow);
      printResult(workflow, result);
      if (result.status === 'error') hadError = true;
    } catch (err) {
      hadError = true;
      console.log(`\n=== ${workflow.name} — THREW ===`);
      console.log(`  ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (hadError) {
    console.log('\nSmoke test finished with at least one error — see above.');
    process.exitCode = 1;
  } else {
    console.log('\nSmoke test finished — all workflows succeeded.');
  }
}

main().catch((err) => {
  console.error('Smoke script crashed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
