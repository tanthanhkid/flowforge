/**
 * System-prompt builders for the AI agent layer (SPEC-step5.md §2).
 * Both prompts embed the node catalog generated live from the real
 * `NodeRegistry` (`registry.describeForAgent()`) — never a hardcoded node
 * list — so the prompt always matches whatever node types are actually
 * registered.
 */
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS, type FalModelPreset } from '../catalog/falModels.js';
import type { CatalogFalEntry, CatalogLlmEntry, CatalogTier, UnifiedCatalog } from '../catalog/live/types.js';
import { OPENROUTER_LLM_MODELS, type OpenRouterModelPreset } from '../catalog/openrouterModels.js';
import type { NodeRegistry } from '../engine/registry.js';
import type { Workflow } from '../engine/schema.js';

const TIER_LABEL: Record<FalModelPreset['tier'], string> = {
  xin: '💎 xịn',
  kha: '✅ khá',
  re: '💸 rẻ',
};

/** SPEC-step29.md §4 — `imageKind` only exists on `FalModelPreset` (and only for `kind: 'image'` entries), never on `OpenRouterModelPreset`; this type guard lets `formatModelLine` below tag it without breaking the shared union param. */
function hasImageKind(model: FalModelPreset | OpenRouterModelPreset): model is FalModelPreset & { imageKind: 't2i' | 'i2i' } {
  return 'imageKind' in model && model.imageKind !== undefined;
}

function formatModelLine(model: FalModelPreset | OpenRouterModelPreset): string {
  const note = model.note ? ` — ${model.note}` : '';
  const tag = hasImageKind(model) ? ` [${model.imageKind}]` : '';
  return `- [${TIER_LABEL[model.tier]}]${tag} ${model.id} (${model.label}), giá: ${model.cost}${note}`;
}

/**
 * Pushed by `routes/modelCatalog.ts` after every `getCatalog()`/
 * `refreshCatalog()` call (SPEC-step19.md §1.6), so the agent's model
 * catalog sections below can draw on live fal.ai/OpenRouter data instead of
 * only the hand-curated static presets. `undefined` (the default, and what
 * every pre-step-19 caller/test keeps getting since nothing here calls this
 * setter) -> `buildFalCatalogSection`/`buildOpenRouterCatalogSection` fall
 * back to the exact static-preset-only rendering this module always used.
 */
let liveCatalogSnapshot: UnifiedCatalog | undefined;

export function setPromptBuilderCatalog(catalog: UnifiedCatalog | undefined): void {
  liveCatalogSnapshot = catalog;
}

const CATALOG_TIER_LABEL: Record<CatalogTier, string> = {
  xin: '💎 xịn',
  kha: '✅ khá',
  re: '💸 rẻ',
  unknown: '❓ chưa rõ giá',
};

/**
 * SPEC-step19.md §1.6 — "KHÔNG nhét 1700 model vào prompt ... cap ~30 id".
 * Every hand-curated `featured` preset is always kept in full — that's the
 * pre-step19 behavior too (the static-only fallback below has never capped
 * them, and there are only ~48 of them total across all 3 catalog sections,
 * nowhere near "1700"). The ~30-id cap applies to the *live-only* long tail
 * layered on top of those presets, as ONE shared budget across all 3
 * sections combined (fal video + fal image + OpenRouter), not per section.
 *
 * Post-review fix: previously each of the 3 sections independently got its
 * own ~30-id non-featured budget (`capCatalogEntries` reset `remaining =
 * PROMPT_CATALOG_CAP` on every call), so a single prompt build could carry
 * up to ~90 non-featured ids total (~30 × 3 sections) — a 3x overshoot of
 * the spec's actual "~30 id" cap. `capLiveCatalogForPrompt` below now
 * computes all 3 sections' non-featured candidates together and drains a
 * single shared counter across them.
 */
const PROMPT_NON_FEATURED_TOTAL_CAP = 30;
const PROMPT_PER_TIER_PER_KIND_CAP = 8;

/** Per-section split of `featured` (always kept) vs. the `(kind, tier)`-bucketed non-featured candidates (top `PROMPT_PER_TIER_PER_KIND_CAP`, newest-first) — the pre-budget-allocation shape `capLiveCatalogForPrompt` shares one counter across. */
function splitFeaturedAndCandidates<T extends { featured: boolean; tier: CatalogTier }>(
  entries: T[],
  kindOf: (entry: T) => string,
): { featured: T[]; nonFeaturedCandidates: T[] } {
  const featured = entries.filter((e) => e.featured);
  const nonFeatured = entries.filter((e) => !e.featured);

  const buckets = new Map<string, T[]>();
  for (const entry of nonFeatured) {
    const key = `${kindOf(entry)}::${entry.tier}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  const nonFeaturedCandidates: T[] = [];
  for (const bucket of buckets.values()) {
    nonFeaturedCandidates.push(...bucket.slice(0, PROMPT_PER_TIER_PER_KIND_CAP));
  }
  return { featured, nonFeaturedCandidates };
}

interface CappedLiveCatalogForPrompt {
  video: CatalogFalEntry[];
  image: CatalogFalEntry[];
  llm: CatalogLlmEntry[];
}

/**
 * Computes the capped (featured + shared-budget non-featured) entries for
 * all 3 MODEL CATALOG sections together, so the ~30-id non-featured cap is
 * enforced across the whole prompt rather than reset per section. Order
 * (video, then image, then llm) is arbitrary but stable/deterministic.
 */
function capLiveCatalogForPrompt(catalog: UnifiedCatalog): CappedLiveCatalogForPrompt {
  const video = splitFeaturedAndCandidates(catalog.falVideo, (e) => e.kind);
  const image = splitFeaturedAndCandidates(catalog.falImage, (e) => e.kind);
  const llm = splitFeaturedAndCandidates(catalog.openrouter, () => 'llm');

  let remaining = PROMPT_NON_FEATURED_TOTAL_CAP;
  function take<T>(candidates: T[]): T[] {
    if (remaining <= 0) return [];
    const picked = candidates.slice(0, remaining);
    remaining -= picked.length;
    return picked;
  }

  return {
    video: [...video.featured, ...take(video.nonFeaturedCandidates)],
    image: [...image.featured, ...take(image.nonFeaturedCandidates)],
    llm: [...llm.featured, ...take(llm.nonFeaturedCandidates)],
  };
}

function formatCatalogPrice(estUsd: number | null, estBasis: string): string {
  return estUsd === null ? 'chưa rõ giá' : `~$${estUsd} (${estBasis})`;
}

function formatCatalogFalLine(model: CatalogFalEntry): string {
  const note = model.note ? ` — ${model.note}` : '';
  const badge = model.featured ? ' ⭐' : '';
  const tag = model.imageKind ? ` [${model.imageKind}]` : '';
  return `- [${CATALOG_TIER_LABEL[model.tier]}]${badge}${tag} ${model.id} (${model.label}), giá: ${formatCatalogPrice(model.estUsd, model.estBasis)}${note}`;
}

function formatCatalogLlmLine(model: CatalogLlmEntry): string {
  const note = model.note ? ` — ${model.note}` : '';
  const badge = model.featured ? ' ⭐' : '';
  return `- [${CATALOG_TIER_LABEL[model.tier]}]${badge} ${model.id} (${model.label}), giá: ${formatCatalogPrice(model.estUsd, model.estBasis)}${note}`;
}

/**
 * "MODEL CATALOG (fal)" section (SPEC-step13.md §2, live-aware since
 * SPEC-step19.md §1.6): once `setPromptBuilderCatalog()` has pushed a live
 * catalog snapshot, `capped` (from `capLiveCatalogForPrompt`, shared across
 * all 3 sections — see its own doc comment) renders instead of the raw
 * catalog — otherwise (nothing pushed yet, `capped` undefined) falls back to
 * the exact original static `falModels.ts`-only rendering. Either way,
 * `fal.image`/`fal.video`'s `modelId` param stays a free-form string (the
 * agent MAY still emit an id outside this list if the user names one).
 */
function buildFalCatalogSection(capped: CappedLiveCatalogForPrompt | undefined): string {
  if (!capped) {
    return [
      'MODEL CATALOG (fal) — dùng để chọn "modelId" cho node fal.image / fal.video:',
      '',
      'Video:',
      ...FAL_VIDEO_MODELS.map(formatModelLine),
      '',
      'Image:',
      ...FAL_IMAGE_MODELS.map(formatModelLine),
      '',
      'Luật chọn tier: mặc định chọn tier "kha" (✅ khá); nếu người dùng nói "đẹp"/"xịn"/"chất lượng cao" thì chọn tier "xin" (💎 xịn); nếu người dùng nói "rẻ"/"test"/"nháp" thì chọn tier "re" (💸 rẻ). Nếu node fal.video có input "image" được nối (image-to-video), ưu tiên chọn id có kind "video-i2v".',
    ].join('\n');
  }

  return [
    'MODEL CATALOG (fal) — dùng để chọn "modelId" cho node fal.image / fal.video. modelId LÀ CHUỖI TỰ DO: danh sách dưới đây chỉ là một phần rút gọn (ưu tiên các model ⭐ và mới nhất mỗi tier) của catalog thật, không đầy đủ — bạn có thể dùng một id fal.ai hợp lệ khác ngoài danh sách nếu người dùng nêu rõ:',
    '',
    'Video:',
    ...capped.video.map(formatCatalogFalLine),
    '',
    'Image:',
    ...capped.image.map(formatCatalogFalLine),
    '',
    'Luật chọn tier: mặc định chọn tier "kha" (✅ khá); nếu người dùng nói "đẹp"/"xịn"/"chất lượng cao" thì chọn tier "xin" (💎 xịn); nếu người dùng nói "rẻ"/"test"/"nháp" thì chọn tier "re" (💸 rẻ). Nếu node fal.video có input "image" được nối (image-to-video), ưu tiên chọn id có kind "video-i2v".',
  ].join('\n');
}

/**
 * "MODEL CATALOG (OpenRouter LLM)" section (SPEC-step14.md §2-3, live-aware
 * since SPEC-step19.md §1.6): same fallback rule as
 * `buildFalCatalogSection` — capped live snapshot when pushed, otherwise the
 * exact original static `openrouterModels.ts`-only rendering. Either way,
 * `llm.generate`/`llm.transform`'s `model` param stays a free-form string.
 */
function buildOpenRouterCatalogSection(capped: CappedLiveCatalogForPrompt | undefined): string {
  if (!capped) {
    return [
      'MODEL CATALOG (OpenRouter LLM) — dùng để chọn "model" cho node llm.generate / llm.transform:',
      '',
      ...OPENROUTER_LLM_MODELS.map(formatModelLine),
      '',
      'Luật chọn model: mặc định để params.model = "" (chuỗi rỗng — hệ thống sẽ tự dùng model mặc định OPENROUTER_DEFAULT_MODEL), TRỪ KHI người dùng yêu cầu một model cụ thể hoặc nói rõ về chi phí/chất lượng (vd "dùng Claude", "rẻ nhất có thể", "chất lượng cao nhất") — khi đó chọn id phù hợp từ catalog trên theo cùng luật tier ở trên (mặc định "kha", "đẹp/xịn" → "xin", "rẻ/test" → "re").',
    ].join('\n');
  }

  return [
    'MODEL CATALOG (OpenRouter LLM) — dùng để chọn "model" cho node llm.generate / llm.transform. model LÀ CHUỖI TỰ DO: danh sách dưới đây chỉ là một phần rút gọn (ưu tiên các model ⭐ và mới nhất mỗi tier) của catalog thật, không đầy đủ — bạn có thể dùng một id OpenRouter hợp lệ khác ngoài danh sách nếu người dùng nêu rõ:',
    '',
    ...capped.llm.map(formatCatalogLlmLine),
    '',
    'Luật chọn model: mặc định để params.model = "" (chuỗi rỗng — hệ thống sẽ tự dùng model mặc định OPENROUTER_DEFAULT_MODEL), TRỪ KHI người dùng yêu cầu một model cụ thể hoặc nói rõ về chi phí/chất lượng (vd "dùng Claude", "rẻ nhất có thể", "chất lượng cao nhất") — khi đó chọn id phù hợp từ catalog trên theo cùng luật tier ở trên (mặc định "kha", "đẹp/xịn" → "xin", "rẻ/test" → "re").',
  ].join('\n');
}

/**
 * SPEC-step21.md §5 — the "node catalog + MODEL CATALOG (fal) + MODEL
 * CATALOG (OpenRouter LLM)" block shared verbatim by `buildGenerateSystemPrompt`,
 * `buildEditSystemPrompt`, and the new `buildChatSystemPrompt`. Extracted
 * purely to avoid a 3rd copy-paste of this block — since string
 * concatenation with a separator is associative, joining these lines as one
 * nested string produces EXACTLY the same bytes as inlining them directly in
 * the two pre-existing builders' own `.join('\n')` call, so this refactor
 * does not change either builder's output by even one byte (verified by
 * `agent-prompt.test.ts`, which is not touched by this step).
 */
/**
 * SPEC-step29.md §4 — the bug this rule prevents: a real 2026-07-13 user
 * session where the agent picked `fal-ai/flux/dev` ([t2i]) for 4 `fal.image`
 * nodes that each had an image edge connected, silently discarding the input
 * image and burning credit on 4 pointless text-to-image runs.
 * `nodes/fal.image.ts`/`nodes/fal.video.ts` runtime-guard the same rule as a
 * last resort, but catching it here (before generation) avoids the wasted
 * run entirely.
 */
const INPUT_DATA_MODEL_SELECTION_RULE = `
QUY TẮC CHỌN MODEL THEO DỮ LIỆU VÀO (quan trọng — tránh chạy tốn phí vô ích):
- Nếu node "fal.image" có edge nối vào port "image" (có ảnh tham chiếu) → BẮT BUỘC chọn modelId đánh dấu [i2i] (image-to-image) trong catalog trên. Model đánh dấu [t2i] (text-to-image) sẽ ÂM THẦM BỎ QUA ảnh đầu vào — vẫn chạy và vẫn tốn phí, nhưng ảnh gốc bị vứt bỏ.
- Tương tự, nếu node "fal.video" có edge nối vào port "image" → chọn model kind "video-i2v" (image-to-video); model "video-t2v" cũng sẽ bỏ qua ảnh đầu vào.
- Nếu port "image" của node đó KHÔNG có edge nối vào, dùng model [t2i] / "video-t2v" như bình thường.
Ví dụ (sai → đúng): node "fal.image" có ảnh nối vào port "image" nhưng modelId = "fal-ai/flux/dev" ([t2i]) → SAI (âm thầm bỏ qua ảnh, tốn phí vô ích).
Phải đổi sang modelId đánh dấu [i2i] (vd model image-to-image trong catalog trên) → ĐÚNG.
`.trim();

function buildNodeCatalogSection(registry: NodeRegistry): string {
  const catalog = JSON.stringify(registry.describeForAgent(), null, 2);
  const capped = liveCatalogSnapshot ? capLiveCatalogForPrompt(liveCatalogSnapshot) : undefined;
  return [
    'Catalog các node type khả dụng (type, category, title, description, inputs/outputs kèm port type + required, paramsJsonSchema):',
    catalog,
    '',
    buildFalCatalogSection(capped),
    '',
    buildOpenRouterCatalogSection(capped),
    '',
    INPUT_DATA_MODEL_SELECTION_RULE,
  ].join('\n');
}

const WORKFLOW_SCHEMA_DESCRIPTION = `
Workflow JSON schema (version 1):
{
  "version": 1,
  "id": "string, duy nhất (có thể bỏ qua — hệ thống sẽ tự sinh nếu thiếu)",
  "name": "string, tên workflow (có thể bỏ qua — hệ thống sẽ tự đặt tên nếu thiếu)",
  "nodes": [
    {
      "id": "string, duy nhất trong workflow",
      "type": "string, một trong các node type liệt kê trong catalog bên dưới",
      "params": { "...": "object khớp đúng paramsJsonSchema của node type đó" },
      "position": { "x": 0, "y": 0 },
      "label": "string, tuỳ chọn"
    }
  ],
  "edges": [
    {
      "id": "string, duy nhất trong workflow",
      "from": { "node": "id của node nguồn", "port": "tên output port của node nguồn" },
      "to": { "node": "id của node đích", "port": "tên input port của node đích" }
    }
  ]
}
"position" là tuỳ chọn trên mỗi node — có thể bỏ qua hoàn toàn, hệ thống sẽ tự tính layout.
`.trim();

const GENERATE_RULES = `
Luật bắt buộc:
1. Mỗi "id" của node và của edge phải duy nhất trong toàn bộ workflow.
2. Mỗi edge chỉ được nối tới tên port thực sự tồn tại trên node (xem "inputs"/"outputs" của node type trong catalog).
3. Type của output port và input port ở hai đầu edge phải tương thích: bằng nhau hệt, hoặc một trong hai bên là "any".
4. Mỗi input port chỉ được nhận tối đa 1 edge nối vào.
5. Mọi input có "required": true phải được nối đúng 1 edge — không được bỏ trống.
6. Ưu tiên dùng node "input.text" làm (các) điểm bắt đầu của workflow, và node "output.collect" để gom các kết quả cuối cùng lại.
7. CHỈ TRẢ VỀ DUY NHẤT JSON của workflow theo đúng schema trên. Không thêm giải thích, không bọc trong markdown, không thêm bất kỳ văn bản nào khác ngoài JSON.
`.trim();

const EDIT_ROLE = `
Bạn là AI agent của FlowForge. Bạn nhận một workflow hiện có và một hướng dẫn (instruction) chỉnh sửa liên quan tới 1 node đích cụ thể — nhưng nếu cần, bạn có thể thêm/xoá node hoặc edge khác để hướng dẫn được thực hiện đúng (ví dụ: đổi loại node thì phải xoá node cũ, thêm node mới, và nối lại edge).
TRẢ VỀ DUY NHẤT JSON là một MẢNG (array) các patch op theo đúng danh sách op cho phép bên dưới. Không thêm giải thích, không bọc trong markdown, không thêm bất kỳ văn bản nào khác ngoài JSON array đó.
`.trim();

const PATCH_OPS_DESCRIPTION = `
Danh sách patch op cho phép (mỗi phần tử trong mảng JSON trả về phải là đúng 1 trong các dạng sau):

1. update-node — cập nhật params (merge từng key vào params hiện có của node, KHÔNG thay thế toàn bộ object params) và/hoặc label của 1 node có sẵn.
   Ví dụ: { "op": "update-node", "nodeId": "caption", "params": { "temperature": 0.9 } }

2. add-node — thêm 1 node mới vào workflow.
   Ví dụ: { "op": "add-node", "node": { "id": "voice2", "type": "vbee.tts", "params": { "voiceCode": "hn_female_ngochuyen_full_48k-fhg" } } }

3. remove-node — xoá 1 node có sẵn (mọi edge nối tới/từ node đó cũng bị xoá theo tự động).
   Ví dụ: { "op": "remove-node", "nodeId": "illustration" }

4. add-edge — thêm 1 edge nối 2 node đã tồn tại, đúng tên port có thật và đúng type tương thích.
   Ví dụ: { "op": "add-edge", "edge": { "id": "e5", "from": { "node": "caption", "port": "text" }, "to": { "node": "voice2", "port": "text" } } }

5. remove-edge — xoá 1 edge theo id.
   Ví dụ: { "op": "remove-edge", "edgeId": "e2" }

Trả về một MẢNG gồm 1 hoặc nhiều op ở trên, ví dụ:
[{ "op": "update-node", "nodeId": "caption", "params": { "temperature": 0.9 } }]
`.trim();

/**
 * Few-shot (a): "viết caption và tạo ảnh minh hoạ" — input.text -> llm.generate
 * -> fal.image -> output.collect. Deliberately valid against the *real*
 * registry (node/port names below match src/nodes/*.ts exactly) — the
 * accompanying test parses this back out and runs it through
 * `validateWorkflow()` against the real registry.
 */
export const GENERATE_FEWSHOT_CAPTION_IMAGE: Workflow = {
  version: 1,
  id: 'wf-example-caption-image',
  name: 'Viết caption và tạo ảnh minh hoạ',
  nodes: [
    {
      id: 'topic',
      type: 'input.text',
      params: { value: 'Một chú mèo phi hành gia bay trong vũ trụ' },
    },
    {
      id: 'caption',
      type: 'llm.generate',
      params: { system: 'Bạn là copywriter mạng xã hội, viết caption ngắn gọn.', temperature: 0.7 },
    },
    {
      id: 'illustration',
      type: 'fal.image',
      params: { modelId: 'fal-ai/flux/dev' },
    },
    {
      id: 'result',
      type: 'output.collect',
      params: {},
    },
  ],
  edges: [
    { id: 'e1', from: { node: 'topic', port: 'text' }, to: { node: 'caption', port: 'prompt' } },
    { id: 'e2', from: { node: 'caption', port: 'text' }, to: { node: 'illustration', port: 'prompt' } },
    { id: 'e3', from: { node: 'caption', port: 'text' }, to: { node: 'result', port: 'in1' } },
    { id: 'e4', from: { node: 'illustration', port: 'image' }, to: { node: 'result', port: 'in2' } },
  ],
};

/**
 * Few-shot (b): "viết script rồi đọc bằng giọng nữ Vbee" — input.text ->
 * llm.generate -> vbee.tts -> output.collect.
 */
export const GENERATE_FEWSHOT_SCRIPT_VBEE: Workflow = {
  version: 1,
  id: 'wf-example-script-vbee',
  name: 'Viết script rồi đọc bằng giọng nữ Vbee',
  nodes: [
    {
      id: 'topic',
      type: 'input.text',
      params: { value: 'Giới thiệu quán cà phê mới khai trương' },
    },
    {
      id: 'script',
      type: 'llm.generate',
      params: { system: 'Bạn là biên kịch quảng cáo ngắn gọn, súc tích.', temperature: 0.7 },
    },
    {
      id: 'voice',
      type: 'vbee.tts',
      params: { voiceCode: 'hn_female_ngochuyen_full_48k-fhg', speed: 1, format: 'mp3' },
    },
    {
      id: 'result',
      type: 'output.collect',
      params: {},
    },
  ],
  edges: [
    { id: 'e1', from: { node: 'topic', port: 'text' }, to: { node: 'script', port: 'prompt' } },
    { id: 'e2', from: { node: 'script', port: 'text' }, to: { node: 'voice', port: 'text' } },
    { id: 'e3', from: { node: 'voice', port: 'audio' }, to: { node: 'result', port: 'in1' } },
  ],
};

function fewshotBlock(title: string, userDescription: string, workflow: Workflow): string {
  return [
    `Ví dụ (${title}):`,
    `Mô tả người dùng: "${userDescription}"`,
    'Output mong đợi (CHỈ JSON, ví dụ này bọc trong ```json để dễ đọc):',
    '```json',
    JSON.stringify(workflow, null, 2),
    '```',
  ].join('\n');
}

/**
 * System prompt for `POST /api/agent/generate-workflow`: turns a free-form
 * VI/EN description into a full workflow JSON.
 */
export function buildGenerateSystemPrompt(registry: NodeRegistry): string {
  const nodeCatalogSection = buildNodeCatalogSection(registry);

  const fewshot1 = fewshotBlock(
    'viết caption và tạo ảnh minh hoạ',
    'Viết caption ngắn cho một chú mèo phi hành gia bay trong vũ trụ, rồi tạo ảnh minh hoạ tương ứng',
    GENERATE_FEWSHOT_CAPTION_IMAGE,
  );
  const fewshot2 = fewshotBlock(
    'viết script rồi đọc bằng giọng nữ Vbee',
    'Viết kịch bản quảng cáo ngắn cho quán cà phê mới khai trương rồi đọc bằng giọng nữ Vbee',
    GENERATE_FEWSHOT_SCRIPT_VBEE,
  );

  return [
    'Bạn là AI agent của FlowForge. Nhiệm vụ của bạn: chuyển mô tả của người dùng (tiếng Việt hoặc tiếng Anh) thành một workflow JSON hợp lệ theo schema FlowForge. TRẢ VỀ DUY NHẤT JSON — không thêm giải thích, không bọc trong markdown.',
    '',
    WORKFLOW_SCHEMA_DESCRIPTION,
    '',
    nodeCatalogSection,
    '',
    GENERATE_RULES,
    '',
    fewshot1,
    '',
    fewshot2,
  ].join('\n');
}

/**
 * System prompt for `POST /api/agent/edit-node`: given the current workflow
 * and a target node id, asks the LLM for a JSON array of patch ops
 * (see patch.ts) implementing the user's instruction.
 */
export function buildEditSystemPrompt(registry: NodeRegistry, workflow: Workflow, nodeId: string): string {
  const nodeCatalogSection = buildNodeCatalogSection(registry);
  const workflowJson = JSON.stringify(workflow, null, 2);

  return [
    EDIT_ROLE,
    '',
    nodeCatalogSection,
    '',
    'Workflow hiện tại:',
    workflowJson,
    '',
    `Node đích cần chỉnh sửa theo hướng dẫn của người dùng: "${nodeId}"`,
    '',
    PATCH_OPS_DESCRIPTION,
  ].join('\n');
}

const CHAT_ROLE = `
Bạn là AI agent của FlowForge — một copilot trò chuyện luôn hiển thị song song với canvas. Người dùng nhắn tin tự nhiên (tiếng Việt hoặc tiếng Anh) mô tả điều họ muốn; bạn có thể tạo mới, sửa, thêm hoặc xoá BẤT KỲ phần nào của workflow hiện tại bằng patch ops — không giới hạn ở 1 node đích cụ thể. Nếu workflow hiện tại chưa có node nào ("nodes" rỗng), hãy coi tin nhắn này là yêu cầu TẠO MỚI workflow từ đầu (toàn add-node/add-edge). Nếu yêu cầu của người dùng chưa đủ rõ để hành động, hoặc họ chỉ đang hỏi/trò chuyện, đừng đoán bừa — trả lời/hỏi lại và để "ops" là mảng rỗng.
`.trim();

/**
 * SPEC-step21.md §5 — same 5 structural ops as `PATCH_OPS_DESCRIPTION`
 * (editNode.ts's contract), phrased for the chat contract's "ops" array
 * field instead of a bare top-level JSON array, and explicitly silent on
 * `move-node` (node position is the user's/auto-layout's job, never the
 * AI's — SPEC-step21.md §2). A separate constant from `PATCH_OPS_DESCRIPTION`
 * rather than reusing it, precisely so `buildEditSystemPrompt`'s existing
 * output (which ends with its own "trả về một MẢNG..." instruction) stays
 * byte-for-byte unchanged.
 */
const CHAT_PATCH_OPS_DESCRIPTION = `
Danh sách patch op cho phép trong "ops" (mỗi phần tử phải là đúng 1 trong các dạng sau):

1. update-node — cập nhật params (merge từng key vào params hiện có của node, KHÔNG thay thế toàn bộ object params) và/hoặc label của 1 node có sẵn.
   Ví dụ: { "op": "update-node", "nodeId": "caption", "params": { "temperature": 0.9 } }

2. add-node — thêm 1 node mới vào workflow.
   Ví dụ: { "op": "add-node", "node": { "id": "voice2", "type": "vbee.tts", "params": { "voiceCode": "hn_female_ngochuyen_full_48k-fhg" } } }

3. remove-node — xoá 1 node có sẵn (mọi edge nối tới/từ node đó cũng bị xoá theo tự động).
   Ví dụ: { "op": "remove-node", "nodeId": "illustration" }

4. add-edge — thêm 1 edge nối 2 node đã tồn tại, đúng tên port có thật và đúng type tương thích.
   Ví dụ: { "op": "add-edge", "edge": { "id": "e5", "from": { "node": "caption", "port": "text" }, "to": { "node": "voice2", "port": "text" } } }

5. remove-edge — xoá 1 edge theo id.
   Ví dụ: { "op": "remove-edge", "edgeId": "e2" }
`.trim();

const CHAT_OUTPUT_CONTRACT = `
TRẢ VỀ DUY NHẤT 1 JSON OBJECT theo đúng dạng sau — không thêm giải thích, không bọc trong markdown, không thêm bất kỳ văn bản nào khác ngoài JSON object đó:
{ "reply": "câu trả lời ngắn gọn bằng tiếng Việt, nói bạn vừa làm gì hoặc hỏi lại nếu thiếu thông tin", "ops": [ ... 0 hoặc nhiều patch op ... ] }
"ops" là mảng RỖNG khi bạn chỉ trả lời/hỏi lại, không cần sửa workflow. Mỗi "id" của node/edge MỚI phải là chuỗi duy nhất, không được trùng với bất kỳ id nào đã có trong workflow hiện tại.
`.trim();

const CHAT_FEWSHOT = `
Ví dụ:
Người dùng: "Đổi nhiệt độ của node viết caption lên 0.9 và thêm 1 node tạo ảnh minh hoạ nối vào sau"
Output mong đợi (CHỈ JSON object):
{"reply":"Mình đã tăng temperature của node viết caption lên 0.9 và thêm node fal.image nối vào sau để tạo ảnh minh hoạ.","ops":[{"op":"update-node","nodeId":"caption","params":{"temperature":0.9}},{"op":"add-node","node":{"id":"illustration2","type":"fal.image","params":{"modelId":"fal-ai/flux/dev"}}},{"op":"add-edge","edge":{"id":"e10","from":{"node":"caption","port":"text"},"to":{"node":"illustration2","port":"prompt"}}}]}
`.trim();

/**
 * SPEC-step32.md B4 — appended (via `buildChatSystemPrompt`'s new optional
 * `titleHint` 5th param) right after the digest/run-summary blocks, only
 * while `conversations.title_source !== 'user'`: tells the LLM it may name
 * (or rename) the conversation itself. `titleHint` absent/false keeps the
 * prompt byte-identical to before this step — same "additive" pattern as
 * `runSummary` (SPEC-step30.md §3).
 */
const TITLE_HINT_BLOCK = `
## Đặt tên workflow
Conversation này chưa có tên do người dùng tự đặt (tên hiện tại là do hệ thống tự đặt từ tin nhắn đầu, hoặc do chính bạn đặt ở lượt trước). Nếu bạn tạo mới hoặc chỉnh sửa workflow theo cách làm rõ hơn mục tiêu của nó, hãy kèm thêm field "title" trong JSON trả về: một tên ngắn gọn (tối đa 8 từ, bằng tiếng Việt) mô tả đúng mục tiêu của workflow. Nếu bạn đã đặt tên phù hợp ở lượt trước và bản chất workflow chưa thay đổi, có thể bỏ field "title" ở lượt này.
`.trim();

/** Same role as `CHAT_OUTPUT_CONTRACT` above but documents the optional
 * `title` field — swapped in by `buildChatSystemPrompt` only when
 * `titleHint` is truthy, so the base `CHAT_OUTPUT_CONTRACT` (used otherwise)
 * never changes. */
const CHAT_OUTPUT_CONTRACT_TITLE = `
TRẢ VỀ DUY NHẤT 1 JSON OBJECT theo đúng dạng sau — không thêm giải thích, không bọc trong markdown, không thêm bất kỳ văn bản nào khác ngoài JSON object đó:
{ "reply": "câu trả lời ngắn gọn bằng tiếng Việt, nói bạn vừa làm gì hoặc hỏi lại nếu thiếu thông tin", "ops": [ ... 0 hoặc nhiều patch op ... ], "title": "tuỳ chọn — tên ngắn gọn (tối đa 8 từ, tiếng Việt) đặt/đổi tên workflow, chỉ kèm khi cần (xem khối \"Đặt tên workflow\" phía trên)" }
"ops" là mảng RỖNG khi bạn chỉ trả lời/hỏi lại, không cần sửa workflow. Mỗi "id" của node/edge MỚI phải là chuỗi duy nhất, không được trùng với bất kỳ id nào đã có trong workflow hiện tại. Bỏ hẳn field "title" (đừng để chuỗi rỗng) nếu bạn không cần đặt/đổi tên ở lượt này.
`.trim();

/** Same role as `CHAT_FEWSHOT` above but with a `title` field in its example
 * output — swapped in by `buildChatSystemPrompt` only when `titleHint` is
 * truthy, so the base `CHAT_FEWSHOT` (used otherwise) never changes. */
const CHAT_FEWSHOT_TITLE = `
Ví dụ:
Người dùng: "Đổi nhiệt độ của node viết caption lên 0.9 và thêm 1 node tạo ảnh minh hoạ nối vào sau"
Output mong đợi (CHỈ JSON object):
{"reply":"Mình đã tăng temperature của node viết caption lên 0.9 và thêm node fal.image nối vào sau để tạo ảnh minh hoạ.","ops":[{"op":"update-node","nodeId":"caption","params":{"temperature":0.9}},{"op":"add-node","node":{"id":"illustration2","type":"fal.image","params":{"modelId":"fal-ai/flux/dev"}}},{"op":"add-edge","edge":{"id":"e10","from":{"node":"caption","port":"text"},"to":{"node":"illustration2","port":"prompt"}}}],"title":"Caption và ảnh minh hoạ"}
`.trim();

/**
 * System prompt for `chatTurn.ts`'s `runChatTurn()` (SPEC-step21.md §5): the
 * single system prompt behind "every turn is a patch, even the first one" —
 * unlike `buildGenerateSystemPrompt`/`buildEditSystemPrompt` there's no
 * separate "generate" vs. "edit" mode, just the current workflow (which may
 * be empty) plus an optional digest of changes the user made by hand that
 * this turn hasn't seen yet (changeDigest.ts's `buildChangeDigest` —
 * `''` when there's nothing to report, in which case the whole digest block
 * is omitted).
 *
 * `runSummary` (SPEC-step30.md §3, additive 4th param — every pre-step30
 * caller keeps compiling/behaving identically without passing it): a
 * `chatTurn.ts`-built (`buildRunSummary`) plain-text summary of the
 * workflow's most recent run, so the AI isn't "blind" to what actually
 * happened when the user asks about a run's result/error (the real
 * 2026-07-13 "sao ảnh kết quả không liên quan" session this fixes).
 * `undefined` (the default) omits the whole block, byte-for-byte identical
 * to the pre-step30 prompt.
 *
 * `titleHint` (SPEC-step32.md B4, additive 5th param — every pre-step32
 * caller keeps compiling/behaving identically without passing it): when
 * truthy, adds `TITLE_HINT_BLOCK` right after the digest/run-summary blocks
 * and swaps `CHAT_OUTPUT_CONTRACT`/`CHAT_FEWSHOT` for their `_TITLE` variants
 * (documenting the optional `title` field) — `chatTurn.ts` passes `true`
 * exactly when `conversations.title_source !== 'user'`, i.e. the AI is still
 * allowed to name/rename this conversation. `undefined`/`false` (the
 * default) keeps the whole prompt byte-for-byte identical to the pre-step32
 * one, same "additive" pattern as `runSummary` above.
 */
export function buildChatSystemPrompt(
  registry: NodeRegistry,
  workflow: Workflow,
  digest: string,
  runSummary?: string,
  titleHint?: boolean,
): string {
  const nodeCatalogSection = buildNodeCatalogSection(registry);
  const workflowJson = JSON.stringify(workflow, null, 2);

  const digestBlock =
    digest === ''
      ? []
      : [
          '## Thay đổi người dùng đã tự chỉnh (bạn chưa xem)',
          digest,
          'Hãy tôn trọng các thay đổi này, đừng hoàn tác trừ khi được yêu cầu.',
          '',
        ];

  const runSummaryBlock =
    runSummary === undefined
      ? []
      : [
          '## Run gần nhất của workflow này',
          runSummary,
          '(Dùng thông tin này khi người dùng hỏi về kết quả/lỗi của lần chạy.)',
          '',
        ];

  const titleHintBlock = titleHint ? [TITLE_HINT_BLOCK, ''] : [];
  const outputContract = titleHint ? CHAT_OUTPUT_CONTRACT_TITLE : CHAT_OUTPUT_CONTRACT;
  const fewshot = titleHint ? CHAT_FEWSHOT_TITLE : CHAT_FEWSHOT;

  return [
    CHAT_ROLE,
    '',
    nodeCatalogSection,
    '',
    'Workflow hiện tại:',
    workflowJson,
    '',
    ...digestBlock,
    ...runSummaryBlock,
    ...titleHintBlock,
    CHAT_PATCH_OPS_DESCRIPTION,
    '',
    outputContract,
    '',
    fewshot,
  ].join('\n');
}
