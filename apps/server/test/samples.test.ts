/**
 * samples.test.ts (SPEC-step8.md §1/§5, extended by SPEC-step11.md §4):
 * every `samples/*.json` file at the repo root must parse as valid JSON and
 * pass `validateWorkflow()` against `createDefaultRegistry()` — proving the
 * 11 sample workflows are runnable against the real node registry, not just
 * well-formed JSON. Also covers the bundled `samples/assets/*` files used by
 * the 4 new input.image/input.pdf/input.markdown samples added in step 11.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocumentProxy, extractText } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
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
  it('finds all 12 expected sample files', () => {
    expect(files).toEqual([
      'sample-image-to-video.json',
      'sample-md-to-voiceover.json',
      'sample-pdf-to-post.json',
      'sample-premium-video.json',
      'sample-product-post.json',
      'sample-quote-card.json',
      'sample-reels-voiceover.json',
      'sample-stock-motion.json',
      'sample-stock-restyle.json',
      'sample-tips-listicle.json',
      'sample-value-video.json',
      'sample-video-to-short.json',
    ]);
  });

  // SPEC-step29.md §7 regression: the §3 fal.image guard (mirroring the
  // pre-existing fal.video t2v/i2v guard) throws at *run* time, not schema
  // validation time, when a node has an image wired into its `image` port
  // but uses a modelId statically known (FAL_IMAGE_MODELS/FAL_VIDEO_MODELS)
  // to be text-to-image/text-to-video. `sample-stock-restyle.json` hit
  // exactly this after `fal-ai/flux/dev` got annotated `imageKind: 't2i'` —
  // this check re-scans every sample so neither a future sample nor a
  // future preset re-annotation can silently reintroduce it. Pure static
  // lookup against the preset tables, no network/registry involved.
  it('no fal.image/fal.video node with an incoming "image" edge uses a static t2i/text-to-video preset', () => {
    const t2iPresetIds = new Set(
      FAL_IMAGE_MODELS.filter((m) => m.imageKind === 't2i').map((m) => m.id),
    );
    const t2vPresetIds = new Set(
      FAL_VIDEO_MODELS.filter((m) => m.kind === 'video-t2v').map((m) => m.id),
    );

    for (const file of files) {
      const raw = JSON.parse(readFileSync(path.join(samplesDir, file), 'utf8')) as {
        nodes: { id: string; type: string; params?: Record<string, unknown> }[];
        edges: { to: { node: string; port: string } }[];
      };
      const nodesById = new Map(raw.nodes.map((n) => [n.id, n]));

      for (const edge of raw.edges) {
        if (edge.to.port !== 'image') continue;
        const target = nodesById.get(edge.to.node);
        const modelId = target?.params?.modelId;
        if (typeof modelId !== 'string') continue;

        if (target?.type === 'fal.image' && t2iPresetIds.has(modelId)) {
          throw new Error(
            `${file}: node "${target.id}" (fal.image) has an image input wired into its "image" port but ` +
              `uses static text-to-image preset "${modelId}" — fal.image's guard throws at run time. ` +
              `Use an image-to-image model or disconnect the image input.`,
          );
        }
        if (target?.type === 'fal.video' && t2vPresetIds.has(modelId)) {
          throw new Error(
            `${file}: node "${target.id}" (fal.video) has an image input wired into its "image" port but ` +
              `uses static text-to-video preset "${modelId}" — fal.video's guard throws at run time. ` +
              `Use an image-to-video model or disconnect the image input.`,
          );
        }
      }
    }
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
      // sample-premium-video (SPEC-step15.md §4) follows the same pattern.
      if (
        file === 'sample-reels-voiceover.json' ||
        file === 'sample-premium-video.json' ||
        file === 'sample-value-video.json'
      ) {
        const composeNodes = result.workflow.nodes.filter((n) => n.type === 'video.compose');
        expect(composeNodes.length).toBe(1);
      }

      // sample-value-video (scope addition, SPEC-step15.md §4): must use the
      // Kling 2.5 Turbo Pro model — the whole point of this "best value"
      // sample is a near-flagship-quality video model at ~1/9 Veo3's price.
      if (file === 'sample-value-video.json') {
        const videoNode = result.workflow.nodes.find((n) => n.type === 'fal.video');
        expect(videoNode?.params.modelId).toBe('fal-ai/kling-video/v2.5-turbo/pro/text-to-video');
      }
    });
  }
});

describe('samples/assets/*', () => {
  it('contains the 5 bundled stock assets (SPEC-step11.md §1, +talk.mp4 SPEC-step33.md §33e-2)', () => {
    const assetFiles = readdirSync(assetsDir).sort();
    expect(assetFiles).toEqual([
      'brief-content.md',
      'brief-flowforge.pdf',
      'stock-coffee.jpg',
      'stock-landscape.jpg',
      'talk.mp4',
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
