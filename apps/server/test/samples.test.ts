/**
 * samples.test.ts (SPEC-step8.md §1/§5): every `samples/*.json` file at the
 * repo root must parse as valid JSON and pass `validateWorkflow()` against
 * `createDefaultRegistry()` — proving the 5 sample workflows are runnable
 * against the real node registry, not just well-formed JSON.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/config.js';
import { validateWorkflow } from '../src/engine/schema.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const samplesDir = path.join(repoRoot, 'samples');

const files = readdirSync(samplesDir).filter((f) => f.endsWith('.json')).sort();

describe('samples/*.json', () => {
  it('finds all 5 expected sample files', () => {
    expect(files).toEqual([
      'sample-image-to-video.json',
      'sample-product-post.json',
      'sample-quote-card.json',
      'sample-reels-voiceover.json',
      'sample-tips-listicle.json',
    ]);
  });

  for (const file of files) {
    it(`${file} passes WorkflowSchema + validateWorkflow against the real registry`, () => {
      const raw = JSON.parse(readFileSync(path.join(samplesDir, file), 'utf8'));
      const registry = createDefaultRegistry();
      const result = validateWorkflow(raw, registry);

      if (!result.ok) {
        throw new Error(
          `${file} invalid:\n` + result.issues.map((i) => `  [${i.code}] ${i.message}`).join('\n'),
        );
      }

      expect(result.ok).toBe(true);
      // id must match the filename (minus extension) per the spec's naming rule.
      expect(result.workflow.id).toBe(file.replace(/\.json$/, ''));
      // every node must have a name and every node must have a position.
      for (const node of result.workflow.nodes) {
        expect(node.position).toBeDefined();
      }
      // every workflow must end in an output.collect node collecting something.
      const collectNodes = result.workflow.nodes.filter((n) => n.type === 'output.collect');
      expect(collectNodes.length).toBeGreaterThan(0);
    });
  }
});
