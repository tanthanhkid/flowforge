# SPEC step 23 — AI-native "Copilot Song Song": ConversationRail + ChatPane (thay modal WorkflowList)

Bước 4/9 của lộ trình AI-native (`docs/DESIGN-ai-native.md` I §1-§4). Frontend: đưa hội thoại vào UI với layout INTERIM (chưa split-pane — bước 24), chat gửi/nhận được end-to-end nhưng CHƯA animation per-op (bước 25 mới xử lý `patch-op`). Backend không đổi (dùng API bước 22).

## §1 Phạm vi file

- Sửa `apps/web/src/api/types.ts` + `api/client.ts`: types + functions cho toàn bộ API bước 22.
- Mới `apps/web/src/store/chat.ts` (`useChatStore`).
- Sửa `apps/web/src/store/flow.ts`: thêm action `adoptWorkflow` (refactor từ `loadWorkflow`, KHÔNG đổi hành vi cũ).
- Mới `apps/web/src/panels/ConversationRail.tsx` + `apps/web/src/panels/ChatPane.tsx`.
- Sửa `App.tsx`, `Toolbar.tsx`; **xoá** `panels/WorkflowList.tsx` (+ test/usage của nó).
- Tests web mới + cập nhật e2e.

## §2 API client (`api/client.ts` — pattern y hệt các function hiện có, ApiError giữ nguyên)

Types mới (`api/types.ts`): `Conversation { id, workflowId, title, createdAt, updatedAt, lastSeenChangeId }`, `ConversationSummary { id, workflowId, title, createdAt, updatedAt, nodeCount, lastRunStatus? }`, `ChatMessage { id, conversationId, role: 'user'|'assistant', content, status: 'pending'|'streaming'|'done'|'error', error?, changeId?, createdAt }`, `WorkflowChangeSummary { id, workflowId, conversationId, source, scope, messageId?, ops, summary, createdAt }`.

Functions:

```ts
listConversations(search?: string): Promise<ConversationSummary[]>
createConversation(): Promise<Conversation>
getConversation(id): Promise<{ conversation: Conversation; messages: ChatMessage[]; workflow: Workflow; version: number }>
renameConversation(id, title): Promise<Conversation>
deleteConversation(id): Promise<void>
postChatMessage(conversationId, content): Promise<{ userMessageId: string; assistantMessageId: string }>  // 409 → ApiError(status 409)
stopTurn(conversationId, messageId): Promise<{ stopped: boolean }>
openTurnEvents(conversationId, assistantMessageId, handlers): () => void   // EventSource, pattern openRunEvents
  // handlers: { onThinking?, onPatchOp?, onMessage(data), onError(data), onDone() } — onDone PHẢI unsubscribe (server đóng sau done)
listChanges(workflowId, opts?): Promise<WorkflowChangeSummary[]>          // dùng ở bước 26, thêm sẵn
postManualChange(workflowId, body: { ops; summary?; expectedVersion }): Promise<{ change; workflow; version }>  // 409 → ApiError kèm body
revertChange(workflowId, changeId): Promise<{ change; workflow; version }>
```

`ApiError` phải giữ được body JSON của 409 (`{ error, workflow, version }`) để bước 26 rebase — nếu class hiện tại chưa lưu body, thêm field `body?: unknown` (additive).

## §3 `store/flow.ts` — `adoptWorkflow` (refactor an toàn)

```ts
adoptWorkflow(workflow: Workflow): void
```

= phần thân `loadWorkflow` hiện tại SAU KHI đã có workflow object: reset run-state/SSE cũ, `dirty: false`, clear selection + validationIssues, giữ nguyên mọi semantics. `loadWorkflow(id)` refactor thành GET + `adoptWorkflow`. Test store cũ phải xanh nguyên trạng.

## §4 `store/chat.ts` (`useChatStore`)

State: `conversations: ConversationSummary[]`, `activeConversationId: string | null`, `activeTitle: string`, `messages: ChatMessage[]`, `workflowVersion: number`, `turnState: 'idle' | 'streaming'`, `activeTurnMessageId: string | null`, `chatError: string | null`, `railCollapsed: boolean`, `search: string`.

Actions:
- `loadConversations(search?)` — GET list.
- `selectConversation(id)` — `getConversation` → set messages/version/title + `useFlowStore.getState().adoptWorkflow(workflow)` + reset `chatError`/`turnState`.
- `newConversation()` — POST → prepend vào list → `selectConversation`.
- `renameActive(title)`, `removeConversation(id)` — DELETE; nếu là conversation đang mở → `activeConversationId=null`, messages rỗng, `useFlowStore.getState().newWorkflow()`.
- `sendMessage(content)`:
  1. Guard `turnState === 'idle'` và có active conversation; content trim ≥1.
  2. `postChatMessage` → 202. Append vào `messages`: user message (content, status done) + assistant placeholder (status `pending`) với đúng 2 id server trả. `turnState='streaming'`, `activeTurnMessageId=assistantMessageId`.
  3. `openTurnEvents(...)`:
     - `onThinking` → assistant placeholder status `streaming` (nội dung hiển thị do component lo).
     - `onPatchOp` → BỎ QUA ở bước này (bước 25 mới dùng — vẫn khai báo handler rỗng có comment).
     - `onMessage({ content, workflow, version, changeId })` → assistant message: content, status `done`, changeId; `workflowVersion=version`; `useFlowStore.getState().adoptWorkflow(workflow)` rồi `autoLayout()` + `requestFitView()` (mirror hành vi Describe cũ — workflow AI trả về có thể thiếu position).
     - `onError({ message })` → assistant message status `error` + error; `chatError=message`.
     - `onDone` → unsubscribe (bắt buộc), `turnState='idle'`, `activeTurnMessageId=null`, `loadConversations()` (title auto có thể vừa đổi) và cập nhật `activeTitle` nếu đổi.
  4. `postChatMessage` ném ApiError 409 (`turn-in-progress`) → `chatError='AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.'`, KHÔNG append message.
- `stopActiveTurn()` — `stopTurn(activeConversationId, activeTurnMessageId)`; events sẽ tự đưa message về error qua SSE.
- `toggleRail()`, `setSearch(q)`.

KHÔNG auto-select conversation khi mount (empty-state của ChatPane xử lý) — bước 24 mới làm luồng chat-first đầy đủ.

## §5 `ConversationRail.tsx`

- Cột TRÁI NGOÀI CÙNG của app, `w-64` (collapse → `w-14`, nút toggle ‹/›), `border-r-[3px] border-ink bg-paper`, flex-col.
- Header: nút `+ Cuộc trò chuyện mới` (Button variant accent, full width, `data-testid="new-conversation"`) + ô search (placeholder 'Tìm...', debounce 300ms → `loadConversations(search)`).
- List scroll: mỗi item (`data-testid="conversation-item"`) hiện `title` (fallback `'Chưa đặt tên'`), dòng phụ `${nodeCount} node`, badge ⚠ (màu `status-error`) khi `lastRunStatus === 'error'`; item active nền `bg-accent`; hover hiện nút ✕ xoá (`window.confirm` như WorkflowList cũ). Click → `selectConversation`.
- Collapsed: chỉ nút toggle + nút `+` dạng icon.
- Style neo-brutalist đúng token hiện có (tham khảo WorkflowList.tsx trước khi xoá).

## §6 `ChatPane.tsx`

- Cột `w-96 shrink-0 border-r-[3px] border-ink bg-bg` giữa rail và Sidebar (layout interim), flex-col, `data-testid="chat-pane"`.
- Header: title conversation + nút ✏️ rename (input inline, Enter/blur lưu qua `renameActive`).
- Message list (scroll, auto-scroll xuống cuối khi có message mới): bubble user căn phải nền `accent` viền ink; assistant căn trái nền `paper` viền ink shadow cứng; assistant `pending/streaming` → Spinner + 'AI đang xử lý…'; `error` → nền đỏ nhạt + text lỗi. `data-testid="chat-message"`.
- Composer sticky đáy (`data-testid="chat-composer"`): textarea 1→4 dòng auto-grow, Enter gửi / Shift+Enter xuống dòng; nút Gửi (variant `ai`, `data-testid="chat-send"`) → khi `turnState==='streaming'` đổi thành nút `■ Dừng` gọi `stopActiveTurn()`. `chatError` hiện dòng đỏ trên composer, tự ẩn khi gõ tiếp.
- Empty states: chưa chọn conversation → headline 'Chọn hoặc tạo cuộc trò chuyện để bắt đầu' + nút tạo mới; conversation 0 message → 3 chip gợi ý mô tả workflow (click → fill composer, KHÔNG tự gửi).

## §7 `App.tsx` + `Toolbar.tsx` + xoá WorkflowList

- `App.tsx`: `<ConversationRail /> <ChatPane /> <Sidebar /> <main FlowCanvas /> <aside 3 tab>` dưới Toolbar. Xoá `showWorkflowList` + import/render `WorkflowList`. Mount: `loadConversations()`.
- `Toolbar.tsx`: xoá nút 'Workflows' + prop `onOpenWorkflowList`. Mọi thứ khác (Describe ✨, Run, Save, JSON, Settings, 💰, 🪄) GIỮ NGUYÊN (bước 24 mới đụng tiếp).
- Xoá file `panels/WorkflowList.tsx` và test/usage liên quan (tìm bằng grep trước khi xoá; KHÔNG đụng test không liên quan).

## §8 Tests

**Web (vitest + testing-library, pattern `apps/web/test/`):**
1. `api-client`: mọi function §2 — URL/method/body đúng, `openTurnEvents` parse events + unsubscribe (mirror test `openRunEvents` hiện có), ApiError 409 giữ body.
2. `store/chat`: selectConversation → adoptWorkflow được gọi + dirty false; sendMessage happy path với EventSource/fetch mock (placeholder pending → done, workflow adopt, version set, turnState về idle sau done); 409 → chatError, không append; stop; removeConversation active → newWorkflow.
3. `ConversationRail`: render list + active highlight + ⚠ badge, search debounce gọi API đúng query, delete có confirm, collapse toggle.
4. `ChatPane`: render bubbles theo role/status, Enter gửi + Shift+Enter không gửi, nút Dừng khi streaming, empty states, chip gợi ý fill composer.
5. `toolbar.test.tsx`: cập nhật (không còn nút Workflows).
6. `flow store`: test cũ xanh nguyên trạng + 1 test `adoptWorkflow` (reset đúng như loadWorkflow).

**E2E (free tier — KHÔNG test send message vì gọi OpenRouter tốn tiền; bước 28 mới mock):**
- Sửa các test đang dùng nút 'Workflows'/`workflow-search` (vd `app.spec.ts:269`) → thao tác qua rail (`conversation-item`).
- Thêm: (a) sau seed, rail hiện ≥11 conversation (verify backfill end-to-end); (b) `new-conversation` → item mới + canvas trống; (c) xoá conversation → biến mất khỏi rail.
- Toàn bộ suite e2e phải xanh lại.

## §9 Nghiệm thu

`pnpm --filter web test` + `typecheck` xanh; `pnpm --filter server test` không đổi; `pnpm run e2e` xanh toàn bộ; UI đúng design tokens neo-brutalist hiện có; không dependency mới.
