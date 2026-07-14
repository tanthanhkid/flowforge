# SPEC step 32 — UX backlog pack: đính kèm ảnh, diff chip, summary giàu, AI đặt tên, badge i2i/t2i

> 5 mục backlog UX từ session 2026-07-13 (CLAUDE.md), làm trọn trong 1 step theo goal user.
> Đánh số B1–B5. Contract API/LLM chốt ở đây là AUTHORITATIVE để FE/BE implement song song.

## B1 — Đính kèm ảnh trong composer chat

Hiện trạng: upload chỉ có trong ParamsPanel (`POST /api/upload` multipart field `file`, cap 50MB,
trả `{path:'uploads/<uuid>.<ext>', filename, mime, size, kind}`; serve qua `GET /artifacts/uploads/<file>`).
Chat chưa có khái niệm attachment (`ChatMessage.content` là string thuần).

### Contract
- `POST /api/conversations/:id/messages` body mở rộng **additive**:
  `{ content: string, attachments?: Array<{path: string, filename?: string, mime?: string}> }`
  Validate: tối đa **3** phần tử; `path` phải match `^uploads\/[A-Za-z0-9.-]+\.(png|jpe?g|webp|gif)$`
  (chặn traversal — cùng triết lý route /artifacts). Sai → 400. Không gửi field → hành vi cũ 100%.
- Bảng `messages` thêm cột `attachments TEXT` (JSON array, NULL khi không có) qua `ensureColumn`.
  `MessagesRepo.create` nhận optional attachments; mọi API trả message (GET conversation, SSE fallback)
  kèm field `attachments` đã parse (null/undefined khi không có).
- LLM context: khi user message có attachments, dòng content đưa vào LLM (cả turn hiện tại LẪN
  prior-history khi rebuild) được append:
  `\n\n[Đính kèm N ảnh đã upload sẵn: <path1>, <path2>. Khi cần đưa ảnh vào workflow, tạo node input.image với params.path = path tương ứng.]`
  DB persist content GỐC (không kèm note) — note chỉ sinh lúc build LLM messages (hàm build history
  đọc attachments từ row message).

### FE (ChatPane + store/chat.ts + api)
- Composer thêm nút 📎 (data-testid `chat-attach-btn`) + `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>`
  (data-testid `chat-attach-input`), mirror pattern fileInputRef của ParamsPanel. Chọn file →
  `uploadFile()` sẵn có (spinner trên chip khi đang upload) → giữ list pending attachments (≤3,
  vượt → toast) dạng chip thumbnail `<img src={/artifacts/${path}}>` + nút ✕ gỡ
  (testid `chat-attach-chip`). Gửi khi đang upload dở → disable nút GỬI.
- `sendMessage(content, attachments?)`: POST kèm attachments; optimistic user message kèm attachments;
  gửi xong clear chips.
- Bubble user render thumbnails dưới content (ảnh nhỏ ~96px, click mở `/artifacts/<path>` tab mới).
  Message load lại từ server cũng render như vậy (đọc `message.attachments`).

## B2 — Diff chip + CTA trên bubble assistant

- **Live**: store/chat.ts `onPatchOp` đã nhận `{op, index, total}` — thêm accumulator per-turn đếm
  theo `op.op` (add-node/remove-node/update-node/add-edge/remove-edge/move-node), reset lúc
  sendMessage, gán vào assistant message khi finalize ở `onMessage` (field client-side `diff`).
- **Reload**: `GET /api/conversations/:id` — với message có `changeId`, server join
  `workflow_changes` → đếm ops → trả thêm `diff?: {addNode,removeNode,updateNode,addEdge,removeEdge,moveNode}`
  (omit khi không changeId; các key 0 vẫn gửi đủ object cho đơn giản).
- **Chip UI** (ChatPane, dưới bubble assistant `status==='done'` có diff tổng > 0,
  testid `chat-diff-chip`): nội dung gọn kiểu `🔧 +2 node · ~1 param · +3 nối` (chỉ hiện thành phần ≠0;
  update-node → `~N param`, move-node gộp vào `↔N vị trí` chỉ khi không có gì khác). Click chip =
  CTA: nếu layout đang chat-only → `setSplitRatio(0.5, {animate:true})`; luôn `requestFitView()`.
- Trả nợ DESIGN-ai-native PHẦN 0 mục 7 — cập nhật doc sau khi ship (orchestrator làm).

## B3 — Summary change giàu thông tin

Hiện trạng: summary sinh inline ở call site flow.ts, `update-node` chỉ ghi key=value mới;
digest server (changeDigest.ts) tự dựng dòng từ ops, không có label/old value.

- **FE (flow.ts + manualLog.ts)**: summary `update-node` sinh tại **flush time** trong
  `flushNodeUpdate` (nơi đã có `baselineParams`): format
  `sửa <key> của "<label>" (<type> <id>): <old> → <new>` — old/new stringify cắt 30 ký tự mỗi giá trị,
  nhiều key → nối `; ` từng key, tổng cap 200 chars (đã có). Label lấy tại flush time
  (`useFlowStore.getState()` — node có thể đã đổi tên; node biến mất → fallback nodeId).
  `add-node`/`remove-node` summary kèm label nếu có: `thêm node fal.image (img-1) "Ảnh minh hoạ"`.
- **BE (changeDigest.ts)**: `buildChangeDigest(changes, workflow?)` — param 2 optional **additive**
  (không truyền → output byte-identical hiện tại, giữ test cũ). Khi có workflow: dòng update-node/
  add-edge/remove-edge/move-node resolve `nodeId → (type, label)` từ workflow hiện tại để dòng digest
  đọc được: `[tay] sửa params "Ảnh minh hoạ" (fal.image img-1): modelId=...`. Call site duy nhất
  trong chatTurn.ts truyền workflow hiện tại (cả đường rebuild version-conflict).
  KHÔNG đổi cap 40 dòng/6000 chars. `summarizeOps` (chatTurn.ts, summary rows nguồn AI) kèm label
  tương tự khi resolve được.

## B4 — AI đặt tên workflow

Hiện trạng: `routes/conversations.ts` autoTitle từ tin đầu khi `title===''` (trước khi turn chạy),
không phân biệt title do user đặt; workflow.name mặc định "Workflow mới"; FE sync title qua
`loadConversations()` lúc `done`.

### Contract
- Cột mới `conversations.title_source TEXT NOT NULL DEFAULT 'auto'` (`ensureColumn`).
  `ConversationsRepo.rename(id, title, source)` — PATCH rename route (user đổi tên) set `'user'`;
  autoTitle giữ `'auto'`; AI đặt set `'ai'`.
- LLM contract: `ChatTurnResponseSchema` thêm `title: z.string().min(1).max(80).optional()`.
  Fixtures `{reply, ops}` cũ vẫn parse (optional).
- Prompt: `buildChatSystemPrompt` thêm param optional `titleHint?: boolean` (additive, absent →
  byte-identical — pattern runSummary step 30). Khi `title_source !== 'user'` chatTurn truyền true →
  prompt thêm khối ngắn: conversation chưa có tên người dùng đặt — hãy kèm field `title` (≤8 từ,
  tiếng Việt, mô tả mục tiêu workflow) trong JSON trả về; nếu đã đặt ở turn trước và không đổi bản chất
  workflow thì bỏ qua. `CHAT_OUTPUT_CONTRACT` + 1 fewshot cập nhật field title.
- Apply phía server (chatTurn.ts): khi response có `title` && `title_source !== 'user'`:
  `conversations.rename(id, title, 'ai')`; nếu turn có ops (đường saveVersioned) → đồng thời
  `workflow.name = title` trước khi save (workflow hết "Workflow mới"). Không ops → chỉ rename conversation.
- SSE: payload event `message` thêm `title?: string` (chỉ khi vừa áp). FE `onMessage`: có title →
  cập nhật `activeTitle` + item trong `conversations` list ngay (khỏi đợi loadConversations ở done —
  vẫn giữ refetch done như cũ).

## B5 — Badge [i2i]/[t2i] trong ModelPicker

Chỉ sửa `apps/web/src/panels/ModelPicker.tsx` (option-row JSX ~line 397-408, chỗ ⭐/MỚI):
khi `isFalEntry(entry) && entry.kind === 'image' && entry.imageKind` → badge `[i2i]`/`[t2i]`
theo pattern span hiện có, màu bg khác MỚI (chọn token cat-* sẵn có, phân biệt được), thêm vào
`title` tooltip. Không đụng server (imageKind đã có trong catalog API + web types từ step 29).
Không phá flatIds/ARIA/keyboard.

## Phân công (ownership TUYỆT ĐỐI — 2 wave + e2e)

**Wave 1 (4 agent song song):**

| Agent | Mục | Files |
| --- | --- | --- |
| BE-1 | B1-server + B4-server | `apps/server/src/db/sqlite.ts` (2 ensureColumn), `db/messages.ts`, `db/conversations.ts`, `routes/conversations.ts`, `agent/chatTurn.ts`, `agent/promptBuilder.ts`, `chatTurnManager.ts`, test server mới `test/step32-*.test.ts` + cập nhật test cũ nếu buộc phải |
| FE-chat | B1-web + B2-web + B4-web | `apps/web/src/panels/ChatPane.tsx`, `store/chat.ts`, `api/client.ts`, `api/types.ts`, test web mới `test/*.step32.test.ts(x)` |
| FE-log | B3-FE | `apps/web/src/store/flow.ts` (chỗ sinh summary), `store/manualLog.ts` (flushNodeUpdate), test web mới |
| FE-picker | B5 | `apps/web/src/panels/ModelPicker.tsx`, test web mới |

**Wave 2 (sau BE-1, vì cùng file):** BE-2 — B2-server (GET messages join diff) + B3-BE
(`changeDigest.ts` + `summarizeOps` + call sites trong `chatTurn.ts`, `routes/conversations.ts`),
test server.

**Wave 3:** E2E agent — `e2e/mock-openrouter.ts` (thêm `title` vào response kịch bản phù hợp,
kịch bản mới nếu cần) + `e2e/tests/chat.spec.ts`: (a) title AI hiện trên rail + header;
(b) diff chip hiện đúng số + click mở split; (c) composer đính kèm ảnh (setInputFiles fixture từ
`samples/assets/`) → chip thumbnail → gửi → bubble user có thumbnail + POST body có attachments
(mock OpenRouter xác nhận note đính kèm trong prompt nếu tiện). Free tier 0 đồng.

Xung đột cần tránh: FE-chat sở hữu `store/chat.ts` TOÀN BỘ ở step này (FE-log không đụng);
FE-log sở hữu `flow.ts` + `manualLog.ts`. BE-2 chỉ chạy sau BE-1.

## Nghiệm thu (orchestrator)

1. `pnpm -r test` + `pnpm run e2e` xanh (số test tăng so 449/356/20/32).
2. Review 2 Opus → Sonnet adversarial verify → fix (trong workflow).
3. Smoke thật 1 turn (grok-4.5): tạo conversation mới, nhắn yêu cầu tạo workflow → kiểm title AI đặt
   + diff chip + (nếu tiện) 1 ảnh đính kèm.
4. Cập nhật CLAUDE.md (step 32 + hiện trạng + xoá backlog), README (tính năng + số test),
   DESIGN-ai-native PHẦN 0 mục 7 (đã trả nợ). Commit + push + ntfy.
