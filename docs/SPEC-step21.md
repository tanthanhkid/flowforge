# SPEC step 21 — AI-native "Copilot Song Song": vòng lặp AI (`chatTurn.ts`, `changeDigest.ts`, op `move-node`, retry version-conflict)

Bước 2/9 của lộ trình AI-native (`docs/DESIGN-ai-native.md` — Phần I authoritative, chi tiết II.5/II.6). Bước này CHỈ làm tầng agent phía server: hàm chạy 1 lượt chat + digest change log + op mới. **KHÔNG** route mới (bước 22), **KHÔNG** UI, **KHÔNG** sửa hành vi `generateWorkflow.ts`/`editNode.ts` (2 hàm cũ giữ nguyên contract — route `/api/agent/*` không đổi).

## §1 Phạm vi file

- Sửa `apps/server/src/agent/patch.ts`: thêm op `move-node` + helper phân loại scope.
- Mới `apps/server/src/agent/changeDigest.ts`: nén change log thành digest cho context LLM.
- Mới `apps/server/src/agent/chatTurn.ts`: `runChatTurn()` — trái tim của redesign.
- Sửa `apps/server/src/agent/promptBuilder.ts`: thêm `buildChatSystemPrompt()` (KHÔNG đổi output 2 builder cũ — test `agent-prompt.test.ts` hiện có phải xanh nguyên trạng).
- Nếu chưa có helper tạo workflow rỗng: thêm `emptyWorkflow(id: string, name: string): Workflow` vào `apps/server/src/engine/schema.ts` (nodes/edges rỗng, version field theo schema hiện hành).
- Unit tests mới trong `apps/server/test/`.

## §2 `patch.ts` — op `move-node` + scope

Thêm vào `PatchOpSchema` (discriminated union):

```ts
z.object({
  op: z.literal('move-node'),
  nodeId: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
})
```

- `applyPatch`: case `move-node` — node phải tồn tại (không thì `PatchError` như các op khác), gán `position` mới (clone, giữ tính pure).
- Export mới:
  - `opScope(op: PatchOp): 'structural' | 'cosmetic'` — `move-node` → `cosmetic`, mọi op khác → `structural`.
  - `changeScope(ops: PatchOp[]): 'structural' | 'cosmetic'` — `cosmetic` khi và chỉ khi MỌI op đều cosmetic (mảng rỗng coi là `cosmetic`).
- System prompt KHÔNG quảng cáo `move-node` cho LLM (vị trí node là việc của user/auto-layout); nếu LLM lỡ trả `move-node` thì vẫn hợp lệ, không cần chặn.

## §3 `changeDigest.ts`

```ts
import type { WorkflowChange } from '../db/changes.js';
export function buildChangeDigest(changes: WorkflowChange[]): string
```

Input: các change CHƯA XEM (caller đã lọc `sinceId=last_seen_change_id`, `includeCosmetic=false`), thứ tự `id` tăng dần. Output: chuỗi digest tiếng Việt, `''` nếu không có gì. Thuật toán (DESIGN II.5):

1. Flatten mọi `ops` của các change theo thứ tự, mỗi op giữ kèm `source` của change chứa nó.
2. **Dedupe update-node theo `(nodeId, paramKey)`**: nhiều lần sửa cùng param → chỉ giữ giá trị SAU CÙNG (đánh đổi có chủ đích — mất quá trình thử-sai, đã có lưới an toàn revert). Sửa `label` dedupe theo `(nodeId, 'label')`.
3. Mỗi op → 1 dòng, prefix nguồn `[tay]` / `[AI]`, template deterministic (không gọi LLM):
   - `add-node`: `[tay] thêm node <type> (id <id>)`
   - `remove-node`: `[tay] xoá node <id>`
   - `update-node` param: `[tay] node <id>: <paramKey> = <giá trị JSON, cắt 120 ký tự>`
   - `add-edge`: `[tay] nối <from.node>.<from.port> → <to.node>.<to.port>`
   - `remove-edge`: `[tay] xoá edge <edgeId>`
   - `move-node` (nếu lọt vào): bỏ qua, không sinh dòng.
4. **Cap 40 dòng**: giữ 40 dòng MỚI NHẤT, thêm dòng đầu `… (<n> thay đổi cũ hơn đã lược bớt)`.
5. **Cap ~1500 token** ước lượng 4 ký tự/token → tổng ≤ 6000 ký tự; vượt thì cắt tiếp từ đầu (dòng cũ nhất) và cập nhật dòng lược bớt.

## §4 `chatTurn.ts` — `runChatTurn()`

```ts
export interface ChatTurnEvents {
  onThinking?: (note: string) => void;
  onPatchOp?: (op: PatchOp, index: number, total: number) => void;
  onMessage?: (p: { reply: string; workflow: Workflow; version: number; changeId: number | null }) => void;
}

export interface ChatTurnDeps {
  registry: NodeRegistry;
  workflows: WorkflowsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  changes: ChangesRepo;
  model?: string;              // default OPENROUTER_DEFAULT_MODEL như generateWorkflow
  signal?: AbortSignal;        // BẮT BUỘC truyền xuống MỌI lần gọi chatCompletion
  events?: ChatTurnEvents;
  now?: () => number;
  id?: () => string;           // uuid injection cho test
}

export interface ChatTurnResult {
  reply: string;
  workflow: Workflow;
  version: number;
  changeId: number | null;     // null nếu turn không patch gì
  userMessageId: string;
  assistantMessageId: string;
}

export class ConversationNotFoundError extends Error { ... }
export class ChatTurnAbortedError extends Error { ... }

export async function runChatTurn(
  conversationId: string,
  content: string,
  deps: ChatTurnDeps,
): Promise<ChatTurnResult>
```

Luồng ("mọi turn đều là patch, kể cả turn đầu" — DESIGN I §6):

1. Load conversation (`ConversationNotFoundError` nếu không có) + `getWithVersion(workflowId)` → `(wf0, v0)`. (Workflow luôn tồn tại nhờ quan hệ 1-1 + backfill; nếu thiếu vẫn throw lỗi rõ ràng.)
2. Ghi message user (`role='user'`, `status='done'`). Tạo message assistant `status='pending'`.
3. Unseen changes = `changes.listByWorkflow(workflowId, { sinceId: conversation.lastSeenChangeId ?? 0, includeCosmetic: false })` → `digest = buildChangeDigest(unseen)`; `maxSeenId` = id lớn nhất trong unseen (nếu có).
4. Build messages LLM: system = `buildChatSystemPrompt(registry, wf0, digest)` + lịch sử hội thoại (tối đa 20 message gần nhất, map `role`/`content` — assistant chỉ lấy text reply) + message user mới. `events.onThinking('Đang phân tích yêu cầu…')`.
5. Vòng `attempt 1..MAX_ATTEMPTS=3` (dùng chung hằng số 3, khai báo cục bộ):
   - `raw = await chatCompletion({ model, messages, temperature: 0.2, signal: deps.signal })` — **signal truyền vào MỌI attempt**.
   - `extractJson(raw)` → validate `ChatTurnResponseSchema = z.object({ reply: z.string().min(1), ops: PatchOpArraySchema.default([]) })`. Lỗi parse/validate → push assistant(raw) + user(feedback lỗi — tái dùng `issuesToFeedback` pattern) vào `messages`, attempt tiếp.
   - **`ops` rỗng**: không patch — update assistant message (`content=reply`, `status='done'`), `setLastSeenChangeId(conversationId, maxSeenId)` nếu có unseen, `touch(conversationId)`, `events.onMessage`, return (`changeId: null`).
   - **`ops` có phần tử** — optimistic concurrency (DESIGN I §6):
     a. Đọc lại `(wfFresh, vFresh) = getWithVersion(workflowId)` NGAY trước khi apply.
     b. Nếu `vFresh !== v0` (user sửa tay trong lúc LLM chạy): nếu CHƯA từng rebuild trong turn này → rebuild toàn bộ (quay lại bước 3-4 với `wf0=wfFresh, v0=vFresh`, digest tính lại), đánh dấu đã rebuild, attempt tiếp (vẫn trong ngân sách 3); nếu ĐÃ rebuild rồi → kết thúc fail-safe: update assistant message `status='done'`, `content = 'Workflow vừa được bạn chỉnh tay khi mình đang xử lý — gửi lại yêu cầu để mình cập nhật theo bản mới nhất.'`, không change, không đổi last_seen, return (`changeId: null`, `workflow=wfFresh`, `version=vFresh`).
     c. `next = applyPatch(wfFresh, ops)` → `validateWorkflow(next)`. `PatchError`/validation issues → feedback cho LLM, attempt tiếp (như generateWorkflow).
     d. `newVersion = workflows.saveVersioned(next, vFresh)` — nếu ném `VersionConflictError` (race hiếm giữa (a) và (d)) → xử lý y hệt nhánh (b).
     e. Ghi change: `changes.create({ workflowId, conversationId, source: 'ai', scope: changeScope(ops), messageId: assistantMessageId, ops, summary, snapshotAfter: next })` — `summary` deterministic 1 dòng từ ops (vd `AI: +2 node, ±1 node, +2 edge` — đếm theo loại op).
     f. Update assistant message (`content=reply`, `status='done'`, `changeId`); `setLastSeenChangeId(conversationId, changeId)` (change mới nhất — AI đương nhiên đã "thấy" cả unseen lẫn change của chính nó); `touch(conversationId)`.
     g. Events: `onPatchOp(op, i, ops.length)` cho TỪNG op (sau khi apply thành công toàn bộ — bước 22 dùng để rải nhịp SSE), rồi `onMessage`.
6. Hết 3 attempt không thành → update assistant message `status='error'` + `error` (serialize issues) → throw `AgentValidationError` (tái dùng class cũ).
7. **Abort**: nếu `signal` abort (chatCompletion ném lỗi abort — nhận diện `AbortError`/`signal.aborted`) → update assistant message `status='error'`, `error='Đã dừng theo yêu cầu'` → throw `ChatTurnAbortedError`. Không ghi change.

## §5 `promptBuilder.buildChatSystemPrompt(registry, workflow, digest)`

- Tái dùng phần mô tả NodeRegistry schema của `buildGenerateSystemPrompt` (refactor phần chung thành hàm nội bộ được, miễn OUTPUT 2 builder cũ không đổi byte nào so với hiện tại).
- Thêm: JSON workflow HIỆN TẠI; nếu `digest !== ''` thêm khối `## Thay đổi người dùng đã tự chỉnh (bạn chưa xem)` + digest + câu lệnh "hãy tôn trọng các thay đổi này, đừng hoàn tác trừ khi được yêu cầu"; contract output: JSON duy nhất `{ "reply": string, "ops": PatchOp[] }` — `reply` tiếng Việt ngắn gọn nói đã làm gì/hỏi lại khi thiếu thông tin, `ops: []` khi chỉ trả lời; mô tả 5 op structural (KHÔNG nhắc move-node); quy tắc id mới không trùng; 1 few-shot ngắn (user hỏi + reply kèm 2-3 ops).

## §6 Unit tests (`apps/server/test/`, mock `chatCompletion` theo pattern `agent-generate.test.ts`)

1. `agent-patch` bổ sung: `move-node` apply đúng/`PatchError` node lạ; `opScope`/`changeScope` (rỗng → cosmetic, lẫn lộn → structural).
2. `change-digest.test.ts`: dedupe (nodeId,paramKey) giữ giá trị cuối; label dedupe riêng; cap 40 dòng + dòng "lược bớt" đúng số; cap 6000 ký tự; prefix `[tay]`/`[AI]`; input rỗng → `''`; move-node bị bỏ qua.
3. `chat-turn.test.ts`:
   - Happy path turn đầu (workflow rỗng + ops add-node/add-edge): vòng đời messages đúng (user done, assistant pending→done + changeId), change row đúng (source `ai`, scope, snapshot_after = workflow mới, message_id), version bump, `last_seen_change_id` = changeId, events đúng thứ tự thinking → patch-op ×N (index/total đúng) → message.
   - Ops rỗng: chỉ reply, không change, `last_seen_change_id` = maxSeenId của unseen.
   - Digest vào prompt: tạo trước 1 change tay chưa seen → spy messages gửi LLM chứa dòng digest `[tay] …`.
   - Retry: attempt 1 JSON hỏng → attempt 2 ok (đúng 2 lần gọi LLM, feedback đúng).
   - Version conflict 1 lần: bump version (giả lập sửa tay) trong callback mock LLM → rebuild (system prompt lần 2 chứa workflow mới) → thành công.
   - Version conflict 2 lần liên tiếp → reply fail-safe, không change, không AgentValidationError.
   - Abort: `AbortController` abort trong khi mock LLM pending → assistant message `status='error'`, throw `ChatTurnAbortedError`.
   - Hết 3 attempt → assistant `status='error'`, throw `AgentValidationError`.

## §7 Nghiệm thu

- `pnpm --filter server test` + `typecheck` xanh toàn bộ (374 cũ + mới); `agent-prompt.test.ts`/`agent-generate.test.ts`/`agent-patch.test.ts` cũ không sửa assertion nào (trừ file patch test được BỔ SUNG case mới).
- Không route/contract nào đổi; không dependency mới; không đọc `.env.local`.
