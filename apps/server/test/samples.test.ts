/**
 * samples.test.ts (SPEC-step8.md §1/§5, extended by SPEC-step11.md §4):
 * every `samples/*.json` file at the repo root must parse as valid JSON and
 * pass `validateWorkflow()` against `createDefaultRegistry()` — proving the
 * 9 sample workflows are runnable against the real node registry, not just
 * well-formed JSON. Also covers the bundled `samples/assets/*` files used by
 * the 4 new input.image/input.pdf/input.markdown samples added in step 11.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocumentProxy, extractText } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/config.js';
import { validateWorkflow } from '../src/engine/schema.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const samplesDir = path.join(repoRoot, 'samples');
const assetsDir = path.join(samplesDir, 'assets');

const files = readdirSync(samplesDir).filter((f) => f.endsWith('.json')).sort();

// node type -> expected input.* node type for samples that must demonstrate
// the new input.image/input.pdf/input.markdown nodes (SPEC-step11.md §4).
const EXPECTED_INPUT_NODE_TYPE: Record<string, string> = {
  'sample-stock-restyle.json': 'input.image',
  'sample-stock-motion.json': 'input.image',
  'sample-pdf-to-post.json': 'input.pdf',
  'sample-md-to-voiceover.json': 'input.markdown',
};

describe('samples/*.json', () => {
  it('finds all 9 expected sample files', () => {
    expect(files).toEqual([
      'sample-image-to-video.json',
      'sample-md-to-voiceover.json',
      'sample-pdf-to-post.json',
      'sample-product-post.json',
      'sample-quote-card.json',
      'sample-reels-voiceover.json',
      'sample-stock-motion.json',
      'sample-stock-restyle.json',
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

      const expectedInputType = EXPECTED_INPUT_NODE_TYPE[file];
      if (expectedInputType) {
        const inputNodes = result.workflow.nodes.filter((n) => n.type === expectedInputType);
        expect(inputNodes.length).toBeGreaterThan(0);
      }

      // sample-reels-voiceover (SPEC-step12.md §2): must ghép video+voiceover
      // locally via video.compose rather than leaving them as separate outputs.
      if (file === 'sample-reels-voiceover.json') {
        const composeNodes = result.workflow.nodes.filter((n) => n.type === 'video.compose');
        expect(composeNodes.length).toBe(1);
      }
    });
  }
});

describe('samples/assets/*', () => {
  it('contains the 4 bundled stock assets (SPEC-step11.md §1)', () => {
    const assetFiles = readdirSync(assetsDir).sort();
    expect(assetFiles).toEqual([
      'brief-content.md',
      'brief-flowforge.pdf',
      'stock-coffee.jpg',
      'stock-landscape.jpg',
    ]);
  });

  it('brief-flowforge.pdf has a real text layer readable via unpdf (>= 50 chars)', async () => {
    const buffer = readFileSync(path.join(assetsDir, 'brief-flowforge.pdf'));
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text.length).toBeGreaterThanOrEqual(50);
  });

  it('brief-content.md has readable markdown content (>= 100 chars)', () => {
    const content = readFileSync(path.join(assetsDir, 'brief-content.md'), 'utf8');
    expect(content.length).toBeGreaterThanOrEqual(100);
  });
});
