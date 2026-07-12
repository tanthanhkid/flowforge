/**
 * `estimateWorkflowCost` (SPEC-step15.md §1-2): a rough, best-effort USD cost
 * estimate for running a workflow once, computed purely from catalog data
 * plus a small static table for nodes outside those catalogs — never calls
 * any real API, so this is safe to run on every keystroke.
 *
 * SPEC-step19.md §1.6 ("lookup estUsd live-merge trước, preset tĩnh sau"):
 * `setLiveCatalogForCostEstimate()` lets `routes/modelCatalog.ts` push in the
 * unified live+static catalog (`catalog/live/index.ts`'s `getCatalog()`)
 * every time it's fetched. When a snapshot has been pushed, a node's
 * `modelId`/`model` is looked up there FIRST (its `falImage`/`falVideo`/
 * `openrouter` lists are already a superset of the static presets — every
 * preset id keeps its hand-verified `estUsd`, see `catalog/live/merge.ts` —
 * plus whatever extra live-only ids fal.ai/OpenRouter list). Only when no
 * snapshot has been pushed yet (server just started, nobody has hit
 * `/api/model-catalog` yet) does this fall back to the exact
 * `catalog/falModels.ts` / `catalog/openrouterModels.ts` static-only lookup
 * this module always used before step 19 — so every pre-step-19 caller of
 * `estimateWorkflowCost(wf)` (no 2nd arg) keeps its exact prior behavior.
 *
 * Lookup key per node type:
 *   - `fal.image` / `fal.video`: `params.modelId` against the fal catalogs.
 *     `fal.video` additionally scales `estUsd` linearly by
 *     `duration / 5` when `params.duration` parses to a positive number
 *     (fal.video's `duration` param is a free-form string|number — Kling's
 *     "5"/"10" string durations must parse too).
 *   - `llm.generate` / `llm.transform`: `params.model`, empty/falsy ->
 *     `OPENROUTER_DEFAULT_MODEL` (same default the nodes themselves resolve
 *     to — see llm.generate.ts's z.preprocess comment).
 *   - anything else: `NODE_BASE_COST[type]` if present, else 0 (utility
 *     nodes / video.compose run entirely locally, no API cost).
 *
 * A `modelId`/`model` that isn't found in the relevant catalog (a free-form
 * id the user typed by hand, per this project's "no hardcoded dropdown"
 * rule), or that IS found but has no parseable price (SPEC-step19.md §1.2
 * rule 5, `estUsd: null`), can't be estimated -> `usd: null`, counted in
 * `unknownCount`, and excluded from `totalUsd`.
 */
import { getEnv } from '../config.js';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS, type FalModelPreset } from '../catalog/falModels.js';
import type { CatalogFalEntry, CatalogLlmEntry, UnifiedCatalog } from '../catalog/live/types.js';
import { OPENROUTER_LLM_MODELS, type OpenRouterModelPreset } from '../catalog/openrouterModels.js';
import type { Workflow } from './schema.js';

let liveCatalog: UnifiedCatalog | undefined;

/**
 * Pushed by `routes/modelCatalog.ts` after every `getCatalog()`/
 * `refreshCatalog()` call (SPEC-step19.md §1.6) — never called directly by
 * this module. Pass `undefined` to go back to the static-only lookup (also
 * the default before the first push, and what every existing test that
 * never calls this keeps getting).
 */
export function setLiveCatalogForCostEstimate(catalog: UnifiedCatalog | undefined): void {
  liveCatalog = catalog;
}

export interface NodeCostEstimate {
  nodeId: string;
  type: string;
  /** null = không ước tính được (model id ngoài catalog). */
  usd: number | null;
  basis: string;
  note?: string;
}

export interface CostEstimate {
  totalUsd: number;
  unknownCount: number;
  nodes: NodeCostEstimate[];
  disclaimer: string;
}

export const DISCLAIMER = 'Ước tính tham khảo theo catalog, chưa tính cache hit/retry.';

/** SPEC-step15.md §1: nodes not covered by the fal/openrouter catalogs. */
const NODE_BASE_COST: Record<string, { usd: number; basis: string }> = {
  'vbee.tts': { usd: 0.02, basis: 'per ~500 ký tự, ước lượng' },
};

/** Node types that never cost anything — run entirely locally. */
const ZERO_COST_TYPES = new Set([
  'input.text',
  'input.file',
  'input.image',
  'input.pdf',
  'input.markdown',
  'text.template',
  'output.collect',
  'video.compose',
]);

interface ResolvedModelCost {
  estUsd: number | null;
  estBasis: string;
}

function fromFalPreset(preset: FalModelPreset | undefined): ResolvedModelCost | undefined {
  return preset ? { estUsd: preset.estUsd, estBasis: preset.estBasis } : undefined;
}

function fromLlmPreset(preset: OpenRouterModelPreset | undefined): ResolvedModelCost | undefined {
  return preset ? { estUsd: preset.estUsd, estBasis: preset.estBasis } : undefined;
}

function fromCatalogFalEntry(entry: CatalogFalEntry | undefined): ResolvedModelCost | undefined {
  return entry ? { estUsd: entry.estUsd, estBasis: entry.estBasis } : undefined;
}

function fromCatalogLlmEntry(entry: CatalogLlmEntry | undefined): ResolvedModelCost | undefined {
  return entry ? { estUsd: entry.estUsd, estBasis: entry.estBasis } : undefined;
}

/**
 * `liveCatalog` first (already a superset of the static presets for any id
 * it covers — SPEC-step19.md §1.5), the static preset second, `undefined`
 * (unknown id) otherwise. No `liveCatalog` pushed yet -> identical to the
 * pre-step-19 static-only lookup.
 */
function resolveFalCost(kind: 'image' | 'video', modelId: unknown): ResolvedModelCost | undefined {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined;
  const staticList = kind === 'image' ? FAL_IMAGE_MODELS : FAL_VIDEO_MODELS;
  if (liveCatalog) {
    const liveList = kind === 'image' ? liveCatalog.falImage : liveCatalog.falVideo;
    const hit = fromCatalogFalEntry(liveList.find((m) => m.id === modelId));
    if (hit) return hit;
  }
  return fromFalPreset(staticList.find((m) => m.id === modelId));
}

function resolveLlmCost(modelId: unknown): ResolvedModelCost | undefined {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined;
  if (liveCatalog) {
    const hit = fromCatalogLlmEntry(liveCatalog.openrouter.find((m) => m.id === modelId));
    if (hit) return hit;
  }
  return fromLlmPreset(OPENROUTER_LLM_MODELS.find((m) => m.id === modelId));
}

/** Parses fal.video's free-form `duration` param (string|number|undefined) to seconds, or undefined if unparseable. */
function parseDurationSeconds(duration: unknown): number | undefined {
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) return duration;
  if (typeof duration === 'string') {
    const parsed = Number.parseFloat(duration);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function estimateNode(node: Workflow['nodes'][number]): NodeCostEstimate {
  const { id: nodeId, type, params } = node;

  if (type === 'fal.image') {
    const resolved = resolveFalCost('image', params.modelId);
    if (!resolved) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model ngoài catalog' };
    }
    if (resolved.estUsd === null) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model có trong catalog nhưng chưa rõ giá' };
    }
    return { nodeId, type, usd: resolved.estUsd, basis: resolved.estBasis };
  }

  if (type === 'fal.video') {
    const resolved = resolveFalCost('video', params.modelId);
    if (!resolved) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model ngoài catalog' };
    }
    if (resolved.estUsd === null) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model có trong catalog nhưng chưa rõ giá' };
    }
    const durationSec = parseDurationSeconds(params.duration);
    if (durationSec === undefined) {
      return { nodeId, type, usd: resolved.estUsd, basis: resolved.estBasis };
    }
    const scale = durationSec / 5;
    return {
      nodeId,
      type,
      usd: resolved.estUsd * scale,
      basis: `${resolved.estBasis} (x${scale.toFixed(2)} cho ${durationSec}s)`,
    };
  }

  if (type === 'llm.generate' || type === 'llm.transform') {
    const rawModel = typeof params.model === 'string' && params.model.length > 0 ? params.model : getEnv('OPENROUTER_DEFAULT_MODEL');
    const resolved = resolveLlmCost(rawModel);
    if (!resolved) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model ngoài catalog' };
    }
    if (resolved.estUsd === null) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model có trong catalog nhưng chưa rõ giá' };
    }
    return { nodeId, type, usd: resolved.estUsd, basis: resolved.estBasis };
  }

  if (ZERO_COST_TYPES.has(type)) {
    return { nodeId, type, usd: 0, basis: 'chạy cục bộ, không tốn API' };
  }

  const base = NODE_BASE_COST[type];
  if (base) {
    return { nodeId, type, usd: base.usd, basis: base.basis };
  }

  // Unknown node type (e.g. registered by a future step) — treat as free
  // rather than unknown-cost, since we have no cost signal at all for it.
  return { nodeId, type, usd: 0, basis: 'không có dữ liệu giá, mặc định $0' };
}

export function estimateWorkflowCost(wf: Workflow): CostEstimate {
  const nodes = wf.nodes.map(estimateNode);
  const totalUsd = nodes.reduce((sum, n) => sum + (n.usd ?? 0), 0);
  const unknownCount = nodes.filter((n) => n.usd === null).length;
  return { totalUsd, unknownCount, nodes, disclaimer: DISCLAIMER };
}
