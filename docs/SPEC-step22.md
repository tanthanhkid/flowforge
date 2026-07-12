# SPEC step 22 — AI-native "Copilot Song Song": tầng HTTP (ChatTurnManager SSE, routes conversations/messages/changes/revert, 409)

Bước 3/9 của lộ trình AI-native (`docs/DESIGN-ai-native.md` I §6-§7). Backend-only: đưa `runChatTurn` (bước 21) ra HTTP + SSE, log thay đổi tay, revert. **KHÔNG** UI (bước 23+), **KHÔNG** đổi contract route cũ (`/api/agent/*`, `/api/runs/*`, `/api/workflows` CRUD gốc giữ nguyên).

## §1 Phạm vi file

- Mới `apps/server/src/chatTurnManager.ts` — quản lý turn đang chạy, mirror pattern `runManager.ts`.
- Mới `apps/server/src/routes/conversations.ts` + `apps/server/src/routes/changes.ts`.
- Sửa nhẹ `apps/server/src/agent/chatTurn.ts`: thêm event `onStart` (xem §2).
- Sửa nhẹ `apps/server/src/agent/changeDigest.ts`: change có `ops` rỗng → 1 dòng digest từ `summary` (xem §5).
- Sửa `apps/server/src/server.ts`: wire repos bước 20 + manager + 2 route mới.
- Tests mới trong `apps/server/test/`.

## §2 `chatTurn.ts` — bổ sung `onStart` (additive, test cũ giữ nguyên)

```ts
export interface ChatTurnEvents {
  onStart?: (ids: { userMessageId: string; assistantMessageId: string }) => void; // MỚI — bắn NGAY sau khi ghi 2 message đầu turn
  onThinking?: ...; onPatchOp?: ...; onMessage?: ...;  // như bước 21
}
```

Lý do: route `POST .../messages` phải trả 202 kèm 2 id NGAY khi turn bắt đầu (client cần id để subscribe SSE), trong khi `runChatTurn` tự sinh id bên trong.

## §3 `chatTurnManager.ts`

```ts
export type ChatTurnSseEvent =
  | { event: 'thinking';  data: { note: string } }
  | { event: 'patch-op';  data: { op: PatchOp; index: number; total: number } }
  | { event: 'message';   data: { content: string; workflow: Workflow; version: number; changeId: number | null } }
  | { event: 'error';     data: { message: string; issues?: ValidationIssue[] } }
  | { event: 'done';      data: Record<string, never> };

export class TurnInProgressError extends Error {}

export class ChatTurnManager {
  constructor(deps: ChatTurnManagerDeps) {}  // registry + 4 repo + model? + paceMs? injection
  start(conversationId: string, content: string): { userMessageId: string; assistantMessageId: string };
  subscribe(assistantMessageId: string, listener: (e: ChatTurnSseEvent) => void): (() => void) | undefined;
  stop(assistantMessageId: string): boolean;
  isActive(assistantMessageId: string): boolean;
}
```

Hành vi:

1. **`start`**: nếu conversation đó ĐANG có turn chạy → throw `TurnInProgressError` (route → 409; FE queue tin nhắn phía client). Tạo `AbortController`, gọi `runChatTurn(conversationId, content, { ..., signal, events })` KHÔNG await (mirror `RunManager.start`, catch cuối để không unhandled-rejection). `onStart` bắn đồng bộ ngay đầu `runChatTurn` → `start()` lấy ids từ đó trả về (nếu vì lý do gì `onStart` chưa bắn khi `runChatTurn` ném lỗi đồng bộ — ví dụ `ConversationNotFoundError` — thì propagate lỗi đó ra `start()`; route map 404).
2. **Buffer + replay**: mọi event của turn được ghi vào buffer theo `assistantMessageId`. `subscribe` phát lại toàn bộ buffer cho listener mới rồi stream tiếp live — SSE connect muộn (sau 202) không mất event. Trả `undefined` nếu manager không biết turn này (route fallback DB — §4.7).
3. **Chuyển đổi events → SSE events**: `onThinking`→`thinking`, `onPatchOp`→`patch-op`, `onMessage`→`message`; `runChatTurn` resolve → phát `done`; reject → phát `error` (`AgentValidationError` kèm `issues`; `ChatTurnAbortedError` → message 'Đã dừng theo yêu cầu'; lỗi khác → `err.message`) rồi `done`.
4. **Pacing** (DESIGN I §6): các event `patch-op` phát cách nhau `paceMs(total) = min(180, 1500/total)` ms (setTimeout chain trong manager, sau khi `runChatTurn` bắn dồn); `message`/`done` chỉ phát SAU khi hàng đợi patch-op đã xả hết. Injection `paceMs?: (total: number) => number` để test đặt 0. Replay buffer thì KHÔNG delay lại.
5. **Dọn bộ nhớ**: sau khi `done` đã phát và không còn listener → giữ buffer thêm để reconnect, dọn theo cap LRU tối đa 200 turn (đơn giản, local single-user; không cần TTL timer).
6. **`stop`**: abort controller nếu turn đang chạy → `true`; turn xong/không tồn tại → `false`.

## §4 Routes `conversations.ts`

| # | Method/Path | Hành vi |
|---|---|---|
| 1 | `POST /api/conversations` `{}` | Tạo `emptyWorkflow(randomUUID(), 'Workflow mới')` qua `workflowsRepo.create` + `conversations.create({ title: '' })` → 200 `{ conversation }` |
| 2 | `GET /api/conversations?search=` | 200 `{ conversations: ConversationSummary[] }` |
| 3 | `GET /api/conversations/:id` | 404 nếu không có; 200 `{ conversation, messages, workflow, version }` |
| 4 | `PATCH /api/conversations/:id` `{ title }` (string 1-120 ký tự) | rename → 200 `{ conversation }` |
| 5 | `DELETE /api/conversations/:id` | `deleteCascade` → 204; 404 nếu không có |
| 6 | `POST /api/conversations/:id/messages` `{ content }` (min 1) | 404/400; nếu `conversation.title === ''` → đặt title = 8 từ đầu của content, cắt ≤60 ký tự; `manager.start` → 202 `{ userMessageId, assistantMessageId }`; `TurnInProgressError` → 409 `{ error: 'turn-in-progress' }` |
| 7 | `GET /api/conversations/:id/turns/:assistantMessageId/events` | SSE — pattern hijack + headers + ping y hệt `routes/runs.ts` (`event: <name>\ndata: <json>\n\n`). `subscribe` có buffer → replay + live, đóng response sau `done`. Manager không biết turn (restart/buffer bị dọn): fallback DB — message tồn tại & role assistant: `status done` → phát `message` (content, workflow+version hiện tại, changeId) + `done` rồi đóng; `status 'error'` → `error` + `done`; `pending/streaming` mồ côi → `error` ('turn không còn chạy') + `done`; không có message → 404 trước khi hijack |
| 8 | `POST /api/conversations/:id/messages/:messageId/stop` `{}` | 200 `{ stopped: manager.stop(messageId) }` |

## §5 Routes `changes.ts`

**`GET /api/workflows/:id/changes?since=<id>&limit=<n≤500 default 100>&includeCosmetic=<bool default false>`** — 404 nếu workflow không tồn tại; 200 `{ changes }` — mỗi change gồm `{ id, workflowId, conversationId, source, scope, messageId, ops, summary, createdAt }`, **KHÔNG trả `snapshotAfter`** (nặng, chỉ dùng nội bộ revert). Trả theo `id` giảm dần? — KHÔNG: giữ `id` TĂNG dần như repo (UI timeline bước 26 tự đảo nếu cần).

**`POST /api/workflows/:id/changes`** body `{ ops: PatchOp[] (min 1), summary?: string, expectedVersion: number }` — nguồn tay từ canvas:
1. Workflow không tồn tại → 404. Body sai schema → 400.
2. `getWithVersion` → `expectedVersion !== version` → **409** `{ error: 'version-conflict', workflow, version }`.
3. `applyPatch` → `PatchError` → **422** `{ error, issues: [{ code: 'patch', message }] }`.
4. Kết quả CHỈ shape-validate (`WorkflowSchema`) — **KHÔNG chạy full `validateWorkflow`**, vì thao tác tay từng bước luôn đi qua trạng thái dở dang (node chưa nối edge, thiếu required input) y như PUT `/api/workflows` hiện hành cho phép draft. (Ghi chú: đây là quyết định lệch chữ nhưng đúng tinh thần DESIGN — full-validate chỉ áp cho turn AI ở bước 21, vì AI phải trả workflow chạy được.) Shape sai → 422.
5. `saveVersioned(next, expectedVersion)` — `VersionConflictError` → 409 như (2).
6. Ghi change `{ source: 'user', scope: changeScope(ops), summary: body.summary || summarizeOps(ops), snapshotAfter: next }` — tách/tái dùng `summarizeOps` từ bước 21 thành export dùng chung (đừng duplicate logic).
7. 200 `{ change (không snapshotAfter), workflow: next, version: <mới> }`.

**`POST /api/workflows/:id/changes/:changeId/revert`** `{}`:
1. Change không tồn tại hoặc khác workflow → 404.
2. `prev = changes.getPrevSnapshot(workflowId, changeId) ?? emptyWorkflow(workflowId, <name hiện tại của workflow>)` — trạng thái NGAY TRƯỚC khi change `#changeId` được apply.
3. `saveVersioned(prev)` (không `expectedVersion` — revert là hành động chủ đích; turn AI đang bay sẽ tự thấy version đổi và đi nhánh conflict của bước 21).
4. Ghi change MỚI `{ source: 'user', scope: 'structural', ops: [], summary: 'Khôi phục về trước thay đổi #<changeId>', snapshotAfter: prev }` — KHÔNG xoá lịch sử cũ, KHÔNG đụng `last_seen_change_id` (AI sẽ "thấy" revert qua digest ở turn sau).
5. 200 `{ change (không snapshotAfter), workflow: prev, version: <mới> }`.

**`changeDigest.ts` sửa nhẹ**: change có `ops.length === 0` (hiện chỉ có revert) → sinh đúng 1 dòng `[tay] <summary>` (hoặc `[AI]` theo source), không dedupe, chịu cap 40 dòng/6000 ký tự chung. (Không có dòng nào cho change ops-rỗng là lỗ hổng: AI sẽ không biết user vừa revert.)

## §6 `server.ts` wiring

Khởi tạo `ConversationsRepo`/`MessagesRepo`/`ChangesRepo` (db đã có), `ChatTurnManager` (registry + repos, model để `runChatTurn` tự default), `registerConversationsRoutes(app, …)`, `registerChangesRoutes(app, …)`. Giữ nguyên thứ tự backfill trước khi đăng ký route.

## §7 Tests (fastify `inject` pattern như `test/api-*.test.ts`; mock `chatCompletion` như `chat-turn.test.ts`; SSE test pattern tham khảo test SSE của runs nếu có, hoặc inject + parse text stream)

1. **CRUD conversations**: POST tạo cặp 1-1 (workflow rỗng version 0 tồn tại thật); GET list + search; GET :id trả messages + workflow + version; PATCH rename (validate 1-120); DELETE cascade sạch (messages/changes/workflow/runs); 404 các path.
2. **POST messages**: 202 + 2 id đúng là message trong DB; title auto 8 từ/≤60 ký tự chỉ đặt khi title rỗng; 404 conversation lạ; 400 content rỗng; 409 khi turn đang chạy (mock LLM treo).
3. **SSE happy path** (paceMs → 0): nhận đúng chuỗi `thinking → patch-op ×N (index/total đúng) → message (workflow mới + changeId) → done`; **replay**: subscribe sau khi turn xong vẫn nhận đủ chuỗi; **fallback DB**: manager mới tinh (giả lập restart bằng manager thứ 2 cùng db) → SSE trả `message` tổng hợp + `done`; message lạ → 404.
4. **stop**: mock LLM treo → stop → `{stopped: true}`, assistant message `status='error'` 'Đã dừng theo yêu cầu', SSE nhận `error` + `done`; stop turn đã xong → `{stopped: false}`.
5. **POST changes tay**: happy path (version bump, change source `user`, scope đúng, response không có snapshotAfter); 409 expectedVersion lệch (kèm workflow + version hiện tại); 422 PatchError; 400 body sai; workflow draft dở dang (add-node không edge) → **200** (không bị full-validate chặn).
6. **revert**: seed 2 change AI (qua ChangesRepo trực tiếp) → revert #2 → workflow = snapshot sau #1; revert change ĐẦU TIÊN → emptyWorkflow (giữ name); change mới `ops: []`, summary đúng, version bump; **digest turn kế tiếp chứa dòng revert** (test qua buildChangeDigest hoặc spy prompt của runChatTurn).
7. **Contract cũ**: không sửa assertion nào của suite cũ.

## §8 Nghiệm thu

`pnpm --filter server test` + `typecheck` xanh (403 cũ + mới); e2e free 13/13 (route cũ không đổi); không dependency mới; không đọc `.env.local`.
