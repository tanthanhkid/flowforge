# SPEC step 27 — AI-native "Copilot Song Song": auto-log thay đổi tay + tab Lịch sử + nút Khôi phục

Bước 8/9 (`docs/DESIGN-ai-native.md` II.5 §4 bảng map hành động→op + I §5-§6). Sau bước này, yêu cầu #4 của user hoàn chỉnh: MỌI thao tác tay trên canvas thành PatchOp ghi vào `workflow_changes`, AI đọc được qua digest, và user có nút Khôi phục. Cần `shared` (bước 25).

## §1 Phạm vi file

- Mới `apps/web/src/store/manualLog.ts`: hàng đợi + debounce + rebase logic (module thuần, testable).
- Sửa `apps/web/src/store/flow.ts`: wire mutators → manualLog; semantics `dirty` cập nhật (§4).
- Mới `apps/web/src/panels/HistoryPanel.tsx` + tab "Lịch sử" thứ 4 trong right panel (`App.tsx`).
- Mới `apps/web/src/ui/Toast.tsx` (primitive nhỏ neo-brutalist, dùng chung).
- Tests web + 2 e2e mới (0 đồng — không gọi LLM). Server KHÔNG đổi.

## §2 `manualLog.ts` — hàng đợi log tay

```ts
enqueueManualOps(ops: PatchOp[], summary: string): void
```

- **Promise-chain tuần tự** (mirror lý do DESIGN I §6): mỗi entry POST `/api/workflows/:id/changes` `{ ops, summary, expectedVersion }` với `expectedVersion` = version mới nhất store đang giữ; response `{ version }` cập nhật store TRƯỚC khi entry kế tiếp gửi.
- **Debounce gộp** trước khi vào queue:
  - `update-node` params/label: gộp theo `nodeId`, 800ms sau keystroke cuối (chỉ giữ giá trị cuối mỗi param).
  - `move-node`: 500ms sau drag-end, gộp các lần kéo liên tiếp cùng node thành 1 op vị trí cuối.
  - `add-node`/`remove-node`/`add-edge`/`remove-edge`: gửi ngay (không debounce), nhưng vẫn qua queue để giữ thứ tự.
- **409 version-conflict → rebase đúng 1 lần**: `adoptWorkflow(body.workflow)` + cập nhật version → thử `applyPatch` ops lên bản mới local; thành công → áp local + POST lại; `PatchError` hoặc 409 lần 2 → bỏ entry + toast 'Không áp được thay đổi sau khi đồng bộ — canvas đã cập nhật theo bản mới nhất.'. Rebase thành công → toast nhẹ 'Đã đồng bộ với thay đổi mới nhất'.
- **Lỗi mạng/5xx**: giữ nguyên workflow local, set `dirty=true` + toast 'Không lưu được thay đổi — bấm Save để lưu thủ công.' (nút Save cũ là lưới an toàn). Queue dừng entry đó, KHÔNG retry vô hạn.
- **Summary tiếng Việt tường minh** sinh phía FE theo op (đừng dựa fallback `summarizeOps` server vì nó prefix 'AI:'): 'thêm node fal.image (img-1)', 'xoá node img-1', 'node tts-1: voice_code = "hcm-diemmy"', 'nối img-1.image → video-1.image', 'xoá edge e3', 'di chuyển node img-1'. Nhiều op gộp → nối bằng '; ' cắt 200 ký tự.
- **Flush mốc bắt buộc**: trước `run()` và trước `saveWorkflow()` → flush mọi debounce đang chờ (await queue rỗng) để change log không tụt sau run. `beforeunload` → cố gắng flush sync (best-effort, chấp nhận mất — DESIGN risks).

## §3 Wire mutators (`store/flow.ts`)

Bảng map (DESIGN II.5 §4): thao tác palette-drop/xoá node/nối edge/xoá edge/sửa param/sửa label/kéo node → sau khi áp local như hiện tại, gọi `enqueueManualOps` với op tương ứng. Điều kiện: CHỈ log khi workflow hiện tại có conversation active (`useChatStore.activeConversationId` khớp workflow) — workflow không conversation (edge case legacy) thì bỏ qua log, hành vi cũ giữ nguyên.

QUAN TRỌNG: thao tác AI (adoptWorkflow, applyOptimisticOp từ bước 26) KHÔNG được đi qua manualLog — chỉ mutator do user gọi từ UI.

## §4 Semantics `dirty` + Save

- POST change thành công = đã persist (server applyPatch + saveVersioned) → KHÔNG set `dirty` cho thao tác đã log.
- `dirty=true` chỉ còn khi: log fail (mạng/5xx), sửa qua JSON view, đổi tên workflow — các đường này giữ nút Save (PUT) như cũ.
- **Hạn chế ghi nhận có chủ đích** (ghi vào spec + comment): sửa raw JSON qua JsonView vẫn đi đường PUT cũ, KHÔNG sinh change log entry (AI vẫn thấy workflow mới nhất qua system prompt mỗi turn, chỉ digest thiếu entry). Không mở rộng scope bước này.

## §5 `HistoryPanel.tsx` — tab "Lịch sử"

- Tab thứ 4 right panel (sau Params/Runs/Kết quả), `data-testid="history-tab"`; load `GET /api/workflows/:id/changes?includeCosmetic=<toggle>` khi mở + sau mỗi change mới của chính client (queue thành công / onDone turn AI).
- List mới nhất TRÊN CÙNG: mỗi row (`data-testid="history-item"`): icon nguồn 🤖 (`source='ai'`) / ✋ (`user`), `summary`, thời gian tương đối ('2 phút trước'), badge scope nhỏ khi cosmetic. Toggle 'hiện thay đổi vị trí' (mặc định tắt).
- Row structural có nút `↺ Khôi phục` (`data-testid="history-revert"`): `window.confirm('Khôi phục về trạng thái TRƯỚC thay đổi này?')` → `revertChange(workflowId, changeId)` → `adoptWorkflow(workflow)` + cập nhật version + refresh list + toast 'Đã khôi phục'. Đang có turn streaming → disable nút (title 'AI đang xử lý').
- Empty state: 'Chưa có thay đổi nào được ghi.'

## §6 `ui/Toast.tsx`

Primitive tối giản: hàng đợi toast góc dưới phải, nền paper viền ink 2px shadow cứng, tự ẩn 4s, variant `info|error`. Export hàm `toast(message, variant?)` gọi được từ store (không cần context — module-level store nhỏ hoặc Zustand).

## §7 Tests

**Web:**
1. `manualLog`: debounce gộp param (2 keystroke → 1 op giá trị cuối), move gộp, thứ tự queue tuần tự (POST sau chờ POST trước), version chain (entry 2 dùng version từ response entry 1), 409 → rebase thành công (adopt + re-POST) và 409×2 → bỏ + toast, network fail → dirty + toast, flush trước run/save.
2. flow store wiring: addNode/removeNode/addEdge/removeEdge/updateNodeParams/moveNode gọi enqueue đúng op + summary; adoptWorkflow/applyOptimisticOp KHÔNG gọi; không log khi thiếu conversation.
3. HistoryPanel: render rows đúng icon/summary/order, toggle cosmetic gọi API đúng query, revert flow (confirm → API → adopt + toast), disable khi streaming, empty state.
4. Toast: hiện/tự ẩn/variant.

**E2E (free, không LLM):**
1. Kéo `input.text` từ palette vào canvas (mode Canvas) → mở tab Lịch sử → thấy row ✋ 'thêm node input.text…'; sửa param text → sau ~1s thấy row update-node.
2. Bấm ↺ Khôi phục trên row add-node → confirm → canvas trống lại + Lịch sử có thêm row 'Khôi phục về trước thay đổi #…'.

## §8 Nghiệm thu

`pnpm --filter web test` + `typecheck`, `pnpm --filter server test` (không đổi), `pnpm run e2e` xanh toàn bộ (16 cũ + 2 mới); smoke tay của orchestrator: kéo node → GET /changes thấy entry ✋ với summary tiếng Việt (không prefix 'AI:').
