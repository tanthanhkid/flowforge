/**
 * System-prompt builders for the AI agent layer (SPEC-step5.md §2).
 * Both prompts embed the node catalog generated live from the real
 * `NodeRegistry` (`registry.describeForAgent()`) — never a hardcoded node
 * list — so the prompt always matches whatever node types are actually
 * registered.
 */
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS, type FalModelPreset } from '../catalog/falModels.js';
import { OPENROUTER_LLM_MODELS, type OpenRouterModelPreset } from '../catalog/openrouterModels.js';
import type { NodeRegistry } from '../engine/registry.js';
import type { Workflow } from '../engine/schema.js';

const TIER_LABEL: Record<FalModelPreset['tier'], string> = {
  xin: '💎 xịn',
  kha: '✅ khá',
  re: '💸 rẻ',
};

function formatModelLine(model: FalModelPreset | OpenRouterModelPreset): string {
  const note = model.note ? ` — ${model.note}` : '';
  return `- [${TIER_LABEL[model.tier]}] ${model.id} (${model.label}), giá: ${model.cost}${note}`;
}

/**
 * "MODEL CATALOG (fal)" section (SPEC-step13.md §2): rendered from the same
 * curated `falModels.ts` catalog the UI's ParamsPanel select reads, so the
 * agent picks `modelId` values that are actually good defaults — while
 * `fal.image`/`fal.video`'s `modelId` param stays a free-form string (the
 * agent MAY still emit an id outside this list if the user names one).
 */
function buildFalCatalogSection(): string {
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

/**
 * "MODEL CATALOG (OpenRouter LLM)" section (SPEC-step14.md §2-3): rendered
 * from the same curated `openrouterModels.ts` catalog the UI's ParamsPanel
 * select reads, for `llm.generate`/`llm.transform`'s `model` param — which
 * stays a free-form string (the agent MAY still emit an id outside this
 * list if the user names one).
 */
function buildOpenRouterCatalogSection(): string {
  return [
    'MODEL CATALOG (OpenRouter LLM) — dùng để chọn "model" cho node llm.generate / llm.transform:',
    '',
    ...OPENROUTER_LLM_MODELS.map(formatModelLine),
    '',
    'Luật chọn model: mặc định để params.model = "" (chuỗi rỗng — hệ thống sẽ tự dùng model mặc định OPENROUTER_DEFAULT_MODEL), TRỪ KHI người dùng yêu cầu một model cụ thể hoặc nói rõ về chi phí/chất lượng (vd "dùng Claude", "rẻ nhất có thể", "chất lượng cao nhất") — khi đó chọn id phù hợp từ catalog trên theo cùng luật tier ở trên (mặc định "kha", "đẹp/xịn" → "xin", "rẻ/test" → "re").',
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
  const catalog = JSON.stringify(registry.describeForAgent(), null, 2);

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
    'Catalog các node type khả dụng (type, category, title, description, inputs/outputs kèm port type + required, paramsJsonSchema):',
    catalog,
    '',
    buildFalCatalogSection(),
    '',
    buildOpenRouterCatalogSection(),
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
  const catalog = JSON.stringify(registry.describeForAgent(), null, 2);
  const workflowJson = JSON.stringify(workflow, null, 2);

  return [
    EDIT_ROLE,
    '',
    'Catalog các node type khả dụng (type, category, title, description, inputs/outputs kèm port type + required, paramsJsonSchema):',
    catalog,
    '',
    buildFalCatalogSection(),
    '',
    buildOpenRouterCatalogSection(),
    '',
    'Workflow hiện tại:',
    workflowJson,
    '',
    `Node đích cần chỉnh sửa theo hướng dẫn của người dùng: "${nodeId}"`,
    '',
    PATCH_OPS_DESCRIPTION,
  ].join('\n');
}
