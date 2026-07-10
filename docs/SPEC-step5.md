# SPEC — Bước 5: AI Agent layer (generate-workflow + edit-node)

Agent gọi OpenRouter (client có sẵn `providers/openrouter.ts`), system prompt sinh **tự động từ NodeRegistry** (không hardcode danh sách node). Model default: `getEnv('OPENROUTER_DEFAULT_MODEL')`, override được per-request. Test mock 100% fetch.

## 1. Files

```
apps/server/src/agent/promptBuilder.ts    # buildGenerateSystemPrompt(registry), buildEditSystemPrompt(registry, workflow, nodeId)
apps/server/src/agent/json.ts             # extractJson(raw): parse tolerant (```json fence, text thừa trước/sau, balanced braces)
apps/server/src/agent/layout.ts           # autoLayout(workflow): gán position còn thiếu theo topo depth (x=depth*280, y=index*150)
apps/server/src/agent/patch.ts            # PatchOp zod + applyPatch(workflow, ops) — pure
apps/server/src/agent/generateWorkflow.ts # generateWorkflow({description, model?, registry}) → {workflow, attempts}
apps/server/src/agent/editNode.ts         # editNode({workflow, nodeId, instruction, model?, registry}) → {workflow, ops, attempts}
apps/server/src/routes/agent.ts           # POST /api/agent/generate-workflow, POST /api/agent/edit-node
apps/server/test/{agent-prompt,agent-json,agent-patch,agent-generate,agent-edit,api-agent}.test.ts
apps/web: Toolbar thêm "✨ Tạo workflow từ mô tả"; NodeCard thêm nút ✨ edit node
apps/web/test/agent-ui.test.tsx
```

## 2. promptBuilder.ts

- `buildGenerateSystemPrompt(registry)`: (1) vai trò — "chuyển mô tả người dùng (VI/EN) thành workflow JSON hợp lệ, TRẢ VỀ DUY NHẤT JSON"; (2) mô tả schema workflow v1 (nodes/edges/from/to/port, params theo schema từng node, position optional); (3) catalog node từ `registry.describeForAgent()` serialize JSON (type, title, description, inputs/outputs với port type + required, paramsJsonSchema); (4) luật: id unique, edge nối đúng tên port tồn tại, type tương thích (bằng nhau hoặc `any`), input port tối đa 1 edge, node cần input required phải được nối, ưu tiên `input.text` làm điểm bắt đầu và `output.collect` gom kết quả cuối; (5) 2 few-shot cứng: (a) "viết caption và tạo ảnh minh họa" → input.text → llm.generate → fal.image → output.collect; (b) "viết script rồi đọc bằng giọng nữ Vbee" → input.text → llm.generate → vbee.tts → output.collect. Few-shot phải hợp lệ 100% theo schema thật (test sẽ validate).
- `buildEditSystemPrompt(registry, workflow, nodeId)`: catalog node + workflow JSON hiện tại + node đích + **danh sách PatchOp cho phép** (mô tả từng op + ví dụ) — "TRẢ VỀ DUY NHẤT JSON array các op".

## 3. patch.ts

```ts
export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update-node'), nodeId: z.string(), params: z.record(z.string(), z.unknown()).optional(), label: z.string().optional() }), // params: merge từng key (không replace toàn bộ)
  z.object({ op: z.literal('add-node'), node: z.object({ id: z.string(), type: z.string(), params: z.record(z.string(), z.unknown()).default({}), position: z.object({x:z.number(),y:z.number()}).optional(), label: z.string().optional() }) }),
  z.object({ op: z.literal('remove-node'), nodeId: z.string() }),   // xóa cả edges dính tới node
  z.object({ op: z.literal('add-edge'), edge: z.object({ id: z.string(), from: z.object({node:z.string(),port:z.string()}), to: z.object({node:z.string(),port:z.string()}) }) }),
  z.object({ op: z.literal('remove-edge'), edgeId: z.string() }),
]);
export function applyPatch(workflow: Workflow, ops: PatchOp[]): Workflow; // pure, deep-clone; op lỗi cấu trúc (id không tồn tại / trùng) → throw PatchError kèm index op
```

## 4. generateWorkflow.ts / editNode.ts — retry loop

```
messages = [system, user(description)]
tối đa 3 lần gọi (1 + 2 retry):
  raw = chatCompletion({ model, messages, temperature: 0.2 })
  json = extractJson(raw)  → parse fail → issue giả code 'parse' 
  (generate) wf = autoLayout(json); v = validateWorkflow(wf, registry)
  (edit)     ops = PatchOpSchema array parse; wf2 = applyPatch(...); v = validateWorkflow(wf2, registry)
  v.ok → return { workflow, attempts }
  không ok → messages += assistant(raw) + user("Workflow/patch chưa hợp lệ, sửa và trả về JSON đầy đủ. Lỗi:\n- <issues từng dòng: code, message, nodeId/edgeId>")
sau 3 lần vẫn fail → throw AgentValidationError { issues, rawLastResponse }
```
- `generateWorkflow` bơm `id`/`version`/`name` nếu LLM thiếu (id = randomUUID, version 1, name từ 6-8 từ đầu của description).
- `editNode`: nodeId không tồn tại trong workflow → throw ngay (route 400, không gọi LLM).

## 5. routes/agent.ts

- `POST /api/agent/generate-workflow` body `{ description: string minLen 3, model?: string }` → 200 `{ workflow, attempts }`; AgentValidationError → 422 `{ error, issues }`; HttpError từ OpenRouter → 502 `{ error }` (message không chứa key).
- `POST /api/agent/edit-node` body `{ workflow, nodeId, instruction, model? }` → 200 `{ workflow, ops, attempts }`; 400 nodeId sai; 422/502 như trên.
- Đăng ký vào buildServer.

## 6. Frontend

- **Toolbar**: nút "✨ Describe" mở panel nhỏ: textarea mô tả + nút Generate (spinner khi chờ). Thành công → `setWorkflowJson(workflow)` (dirty=true, cần Save như thường); nếu workflow hiện tại dirty → confirm trước khi ghi đè. 422 → hiện issues list; lỗi khác → message.
- **NodeCard**: nút ✨ mở popover: input instruction + Apply (spinner) → POST edit-node với workflow hiện tại → thành công `setWorkflowJson(kết quả)` giữ selection; lỗi hiện trong popover.
- api/client.ts thêm 2 hàm tương ứng.

## 7. Tests

- `agent-prompt.test.ts`: system prompt chứa đủ 9 node type + tên port + chuỗi paramsJsonSchema; 2 few-shot parse được bằng WorkflowSchema và pass validateWorkflow với registry thật.
- `agent-json.test.ts`: extractJson với ```json fence, text thừa, JSON bare, array; input không có JSON → throw.
- `agent-patch.test.ts`: từng op type (update-node merge params từng key, add/remove node dọn edge, add/remove edge); op tham chiếu id sai → PatchError kèm index; pure (input không bị mutate).
- `agent-generate.test.ts` (mock fetch OpenRouter): lần 1 valid → attempts=1; lần 1 invalid (edge sai port) → request 2 chứa message lỗi có code issue → valid → attempts=2; 3 lần invalid → AgentValidationError kèm issues; autoLayout gán position thiếu; id/version/name được bơm.
- `agent-edit.test.ts`: happy path ops → workflow mới validate ok; nodeId sai → throw không gọi fetch; retry khi patch ra workflow invalid.
- `api-agent.test.ts` (inject, mock fetch): 200 generate + edit; 422 kèm issues; 400 nodeId; body thiếu description → 400.
- `agent-ui.test.tsx`: Describe panel gọi đúng API + setWorkflowJson khi thành công; hiện issues khi 422; nút ✨ node gửi đúng nodeId + instruction.

## 8. Definition of Done

- Server: typecheck + test xanh (119 + mới). Web: typecheck + build + test xanh.
- Orchestrator smoke thật: gọi generate-workflow với mô tả tiếng Việt qua model default thật, nhận workflow hợp lệ.
