/**
 * `estimateWorkflowCost` (SPEC-step15.md §1-2): a rough, best-effort USD cost
 * estimate for running a workflow once, computed purely from the static
 * catalogs (`catalog/falModels.ts` / `catalog/openrouterModels.ts`) plus a
 * small static table for nodes outside those catalogs — never calls any
 * real API, so this is safe to run on every keystroke.
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
 * rule) can't be estimated -> `usd: null`, counted in `unknownCount`, and
 * excluded from `totalUsd`.
 */
import { getEnv } from '../config.js';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS, type FalModelPreset } from '../catalog/falModels.js';
import { OPENROUTER_LLM_MODELS, type OpenRouterModelPreset } from '../catalog/openrouterModels.js';
import type { Workflow } from './schema.js';

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

function findFalPreset(list: FalModelPreset[], modelId: unknown): FalModelPreset | undefined {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined;
  return list.find((m) => m.id === modelId);
}

function findLlmPreset(modelId: unknown): OpenRouterModelPreset | undefined {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined;
  return OPENROUTER_LLM_MODELS.find((m) => m.id === modelId);
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
    const preset = findFalPreset(FAL_IMAGE_MODELS, params.modelId);
    if (!preset) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model ngoài catalog' };
    }
    return { nodeId, type, usd: preset.estUsd, basis: preset.estBasis };
  }

  if (type === 'fal.video') {
    const preset = findFalPreset(FAL_VIDEO_MODELS, params.modelId);
    if (!preset) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model ngoài catalog' };
    }
    const durationSec = parseDurationSeconds(params.duration);
    if (durationSec === undefined) {
      return { nodeId, type, usd: preset.estUsd, basis: preset.estBasis };
    }
    const scale = durationSec / 5;
    return {
      nodeId,
      type,
      usd: preset.estUsd * scale,
      basis: `${preset.estBasis} (x${scale.toFixed(2)} cho ${durationSec}s)`,
    };
  }

  if (type === 'llm.generate' || type === 'llm.transform') {
    const rawModel = typeof params.model === 'string' && params.model.length > 0 ? params.model : getEnv('OPENROUTER_DEFAULT_MODEL');
    const preset = findLlmPreset(rawModel);
    if (!preset) {
      return { nodeId, type, usd: null, basis: 'không rõ', note: 'model ngoài catalog' };
    }
    return { nodeId, type, usd: preset.estUsd, basis: preset.estBasis };
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
