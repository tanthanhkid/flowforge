# DESIGN — FlowForge AI-native: "Copilot Song Song"

> **Quyết định**: user chọn phương án này ngày 2026-07-12, thắng "Nhà Chat, Xưởng Canvas" (39.7 vs 39.3/50, panel 3 giám khảo).
> Trình bày 2 phương án: https://claude.ai/code/artifact/d89f39f3-03a8-4fe1-a677-e907cba296d6
>
> **Cách đọc tài liệu này**: Phần I (bản hoàn thiện sau review) là AUTHORITATIVE — khi mâu thuẫn với Phần II thì Phần I thắng.
> Phần II (bản gốc của design agent) giữ lại vì chứa chi tiết implement sâu hơn (DDL, bảng map hành động→op, thuật toán digest...).
>
> Triết lý: chat pane và canvas pane LUÔN cùng khung nhìn (splitRatio), AI stream từng patch-op qua SSE, node vật chất hoá dần trên canvas. Mọi thay đổi (AI + tay) đều là PatchOp ghi vào `workflow_changes`.

---

# PHẦN 0 — Hiện trạng sau khi ship (cập nhật 2026-07-13, sau khi hoàn tất 9/9 bước)

Lộ trình đã **ship xong toàn bộ** (project steps 20–28, commits `48a6fa8` → `0e0eec5`). Phần I/II bên dưới giữ nguyên làm tài liệu thiết kế gốc; các điểm sau là **sai lệch giữa thiết kế và bản ship** — khi mâu thuẫn, THỰC TẾ SHIP (mục này + code) thắng:

**Lệch có chủ đích (đã ghi trong spec tương ứng):**
1. **Thứ tự lộ trình đảo**: `packages/shared` (mục 8 của kế hoạch §8 Phần I) được đôn lên chạy TRƯỚC animation (mục 6) và auto-log (mục 7) — vì cả hai bước sau đều cần `applyPatch` phía client. Mapping thực tế: step 25 = shared, step 26 = animation, step 27 = auto-log (xem CLAUDE.md).
2. **KHÔNG có nút "Bỏ qua animation"** (Phần I §6 + rủi ro #2): server đã cap tổng pacing ≤1.5s/turn nên không đáng thêm UI — quyết định tại SPEC-step26.md §3.
3. **Sửa raw JSON qua JsonView và đổi tên workflow KHÔNG vào change log** (vi phạm cục bộ nguyên tắc "mọi thay đổi đều là PatchOp"): 2 luồng này vẫn đi đường PUT cũ — SPEC-step27.md §4 "hạn chế ghi nhận có chủ đích". AI vẫn thấy workflow mới nhất qua system prompt mỗi turn, chỉ digest/tab Lịch sử thiếu entry.
4. `canvas/Sidebar.tsx` KHÔNG đổi tên thành `NodePalette.tsx` như Phần II §II.4 khuyến nghị (khác thư mục với `ConversationRail.tsx` nên không nhầm import; CLAUDE.md gọi là "Sidebar node palette").
5. Template summary thay đổi tay (Phần II §II.5 mục 4) được FE sinh với văn phong chữ thường không ngoặc kép (`thêm node fal.image (img-1)`), không theo mẫu chữ hoa của Phần II — Phần II vốn không authoritative.

**Khoảng trống chưa implement (ứng viên cho bước sau, KHÔNG phải đã ship):**
6. **System-note "Đã xem N thay đổi bạn vừa chỉnh tay…"** trong bubble assistant (Phần I §5): chưa có ở đâu trong code — digest vẫn được đưa vào context AI đầy đủ (cơ chế hoạt động đúng), chỉ thiếu tín hiệu trực quan cho user biết AI đã "đọc" thay đổi tay.
7. **Diff chip 🔧 (+N node · ~N param)** trên bubble assistant (Phần II §II.5 mục 7): chưa implement (Phần II tham khảo, không bắt buộc).

---

# PHẦN I — Bản hoàn thiện sau judge panel (authoritative)


# Copilot Song Song — bản hoàn thiện sau review

Giữ nguyên triết lý cốt lõi: chat pane và canvas pane LUÔN cùng khung nhìn, khác biệt duy nhất là tỉ lệ chia (splitRatio). 4 nhóm điểm yếu giám khảo nêu (mode-switch khó khám phá, không có undo, thiếu migration cho 11 sample, rủi ro race/dual-write) đều được vá mà không phá kiến trúc gốc — chỉ cộng thêm.

## 1. Layout

Khung 3 cột như cũ: ConversationRail (rail 56–260px) | ChatPane | CanvasPane (SplitDivider). SỬA LỚN NHẤT: kéo divider bằng tay không còn là cơ chế đổi chế độ DUY NHẤT nữa. Thêm Mode Toggle — 3 nút tường minh "Chat | Chia đôi | Canvas" neo cố định trong topbar (luôn thấy, không phải popover ẩn), mỗi nút set thẳng splitRatio = 1.0 / 0.5 / 0.0 kèm animate 300ms giống hệt kéo tay. Toggle và divider là 2 lối vào cùng 1 state, không xung đột: kéo tay để tinh chỉnh mượt (giữ đúng gu Cursor/v0.dev cho người quen dev-tool), toggle để người làm content không rành thao tác kéo vẫn đổi mode được ngay trong 1 click. ⌘\ / ⌘⇧\ vẫn là phím tắt phụ trợ. Min-width giữ nguyên: chat ≥320px, canvas ≥420px. `ff.splitRatio` lưu localStorage như cũ.

## 2. Trang chủ chat

Không đổi nhiều so với bản gốc — vẫn đúng: trạng thái mặc định (splitRatio=1.0) khi chưa có conversation hoặc conversation rỗng, composer lớn căn giữa kiểu landing, chip gợi ý lấy từ 11 sample có sẵn. Gửi tin đầu tiên → tạo `conversation` + `emptyWorkflow()` 1-1 ngay lập tức → khi SSE `patch-op` đầu tiên bay về, animate ratio 1.0→0.4. Composer vẫn nhận tin trong lúc AI đang chạy (hàng đợi 1 tin, tự gửi khi turn hiện tại xong). Nút Stop (■) dùng AbortSignal — PHẢI truyền xuyên suốt từ `chatTurn.ts` xuống `chatCompletion()` ngay từ đầu (đây là lỗ hổng thật giám khảo 2 xác nhận đã grep được: `ChatCompletionArgs.signal` tồn tại ở `openrouter.ts` nhưng `generateWorkflow.ts`/`editNode.ts` hiện KHÔNG truyền xuống — `chatTurn.ts` không được kế thừa thiếu sót này).

## 3. Canvas / editor view

Tái dùng gần như nguyên vẹn `FlowCanvas.tsx`/`NodeCard.tsx`/`portColors.ts`. Nút ✨ trên mỗi NodeCard vẫn giữ vị trí, đổi hành vi: mở/focus chat pane + prefill "Sửa node {label}: " thay vì popover riêng — đây là lối tắt vật lý cho yêu cầu 4 ("chỉnh tay xong quay lại chat"). Người dùng chỉnh tay (kéo-thả từ NodePalette, nối/xoá edge, sửa params) hoạt động y hệt hiện tại, không đổi gì về engine. Right panel giữ 3 tab cũ (Params/Runs/Kết quả) + 1 tab mới "Lịch sử". Khi thu gọn hết cỡ (canvas-only), chat không biến mất — rail 48px bên trái vẫn hiện icon AI + badge đỏ đếm tin nhắn mới nếu turn đang chạy nền.

## 4. Sidebar (ConversationRail)

Quan hệ conversation↔workflow vẫn 1-1 bắt buộc (giữ nguyên lý do: khớp `WorkflowsRepo` hiện tại, tránh ambiguity "AI đang patch workflow nào"). Mỗi item: title tự động từ 6-8 từ tin nhắn đầu, sub-label = node type nổi bật, chấm ●/○ trạng thái mở, badge ⚠ đỏ nếu run gần nhất lỗi. Tìm kiếm theo title. SỬA: mục cuối danh sách rail bây giờ LUÔN chứa đủ 11 sample + mọi workflow cũ nhờ backfill (xem Migration §8) — không còn "biến mất" khỏi UI như bản gốc bị chỉ ra. Xoá conversation = xoá cascade workflow 1-1 (app-level).

## 5. Change tracking (siết chặt nhất trong bản refine)

Giữ nguyên xương sống đã được cả 3 giám khảo khen: 1 vocabulary `PatchOp` chung cho cả 2 nguồn (thêm op `move-node`, scope `cosmetic`), bảng `workflow_changes` 1 dòng = 1 lần `applyPatch()` thành công, phân loại `scope` structural/cosmetic để lọc noise vị trí khỏi digest AI, thuật toán nén `buildChangeDigest` dedupe theo `(nodeId, paramKey)` + cap 40 dòng + cap ~1500 token, con trỏ `last_seen_change_id`, system-note "Đã xem N thay đổi bạn vừa chỉnh tay...".

BỔ SUNG MỚI — Revert theo snapshot (vá lỗ hổng "không có undo" mà cả 3 giám khảo cùng nêu là chí mạng): mỗi dòng `workflow_changes` giờ lưu thêm 1 cột `snapshot_after TEXT NOT NULL` — toàn bộ `Workflow` JSON NGAY SAU khi apply xong dòng đó (workflow ở MVP này nhỏ, vài chục node là kịch trần — chi phí lưu trữ chấp nhận được cho SQLite local, không cần nén). Cố tình KHÔNG chọn hướng "tính inverse ops" (phức tạp, dễ sai với `remove-node` mất dữ liệu cạnh liên quan) — snapshot toàn cục đơn giản hơn và đúng 100%. UI: mỗi dòng structural trong tab Lịch sử có nút "↺ Khôi phục về trước thay đổi này" → gọi `POST /api/workflows/:id/changes/:changeId/revert` → server lấy `snapshot_after` của dòng NGAY TRƯỚC dòng đang chọn (hoặc `emptyWorkflow()` nếu là dòng đầu tiên), set làm workflow hiện tại, và — quan trọng — GHI THÊM 1 dòng `workflow_changes` MỚI (`source='user'`, `summary='Khôi phục về trạng thái tại #<id>'`) thay vì xoá lịch sử cũ. Điều này giữ đúng triết lý "mọi thay đổi đều là 1 patch được log" — revert không phải case đặc biệt, nó tự nhiên trở thành 1 change mà AI cũng "thấy" được ở turn kế tiếp qua digest. Đây là undo tối thiểu nhưng đủ an toàn cho MVP, không cần cơ chế branch/redo phức tạp.

Dedupe digest vẫn giữ đánh đổi có chủ đích (chỉ giữ giá trị SAU CÙNG của mỗi (nodeId,paramKey)) — nay có lưới an toàn: vì có revert, user luôn có đường lùi vật lý nếu AI hiểu sai ý đồ "thử-sai" của họ, không chỉ dựa vào việc tự kể lại trong chat như bản gốc.

## 6. AI loop (chatTurn.ts) — siết race condition

Giữ nguyên insight kiến trúc cốt lõi: "mọi turn đều là patch, kể cả turn đầu tiên" — `applyPatch(emptyWorkflow(), manyOps)` chính là "generate". Chỉ 1 hàm mới `chatTurn.ts`, không sửa `generateWorkflow.ts`/`editNode.ts` cũ. Response contract `{ reply: string, ops: PatchOp[] }`, `ops` có thể rỗng. SSE mirror `RunManager`: `thinking` → `patch-op` (delay nhân tạo `min(180ms, 1500ms/total)` để rải nhịp animate, cap tổng ≤1.5s, có nút "Bỏ qua animation") → `message` (final, kèm `workflow` mới + `changeId`) → `done`.

BỔ SUNG MỚI — Optimistic concurrency version (vá race "sửa tay trong lúc AI đang chạy" mà bản gốc chỉ chấp nhận "trễ 1 turn, không mất"): thêm cột `workflows.version INTEGER NOT NULL DEFAULT 0`, tăng +1 mỗi lần `applyPatch()` thành công bất kể nguồn AI hay tay. `chatTurn.ts` đọc `(workflow, version)` MỚI NHẤT ngay trước bước `applyPatch()` cuối cùng (như bản gốc đã có) — NHƯNG giờ so sánh với `version` tại thời điểm build system prompt: nếu KHÁC, không âm thầm apply đè nữa — thay vào đó server rebuild lại system prompt với workflow+digest mới nhất và retry sinh ops 1 lần (tính vào ngân sách `MAX_ATTEMPTS=3` sẵn có, không cần cơ chế mới); nếu vẫn conflict ở lần retry đó, turn kết thúc với `reply` fail-safe: "Workflow vừa được bạn chỉnh tay khi mình đang xử lý — gửi lại yêu cầu để mình cập nhật theo bản mới nhất" thay vì áp patch tính trên ngữ cảnh cũ. Endpoint `POST /api/workflows/:id/changes` (nguồn tay) cũng nhận `expectedVersion` từ FE; lệch version → 409 kèm `workflow` mới nhất, FE báo toast nhẹ "Đã đồng bộ với thay đổi mới nhất" rồi thử áp lại thao tác của user trên bản mới (rebase 1 lần, không rebase vô hạn).

Dual-write giữa FE optimistic và server authoritative: FE có bản `applyPatch` JS thuần dùng để hiển thị NGAY (optimistic) nhưng KHÔNG BAO GIỜ là nguồn sự thật cuối — mỗi response (SSE `message`, `POST /changes`, `revert`) trả `workflow` đầy đủ và FE LUÔN ghi đè state cục bộ bằng bản server trả về (reconcile), nên sai lệch do bug ở bản copy client tự lành trong vòng 1 round-trip, không tích lũy. Các POST log tay từ cùng 1 tab được serialize qua 1 hàng đợi promise-chain phía client (tránh param-edit debounce và move-node debounce race nhau); race giữa NHIỀU TAB dùng chính cơ chế `version`/409 ở trên.

## 7. Data model & API

Bảng mới giữ nguyên `conversations`, `messages`, `workflow_changes` như bản gốc, CỘNG THÊM:
- `workflow_changes.snapshot_after TEXT NOT NULL` (mục 5).
- `workflows.version INTEGER NOT NULL DEFAULT 0` (mục 6) — không cần bảng mới, chỉ 1 cột thêm vào bảng `workflows` sẵn có.

API mới cộng thêm so với bản gốc:
```
POST /api/workflows/:id/changes/:changeId/revert
  200: { change: WorkflowChange, workflow: Workflow }   -- change mới, source='user'

POST /api/workflows/:id/changes   (đã có, nay thêm field)
  body: { ops: PatchOp[], summary?: string, expectedVersion: number }
  409: { error: 'version-conflict', workflow: Workflow, version: number }  -- MỚI
```
Toàn bộ endpoint cũ (`/api/agent/*`, `/api/runs/*`, `/api/workflows/*` gốc, `/api/catalog/*`, `/api/estimate`) vẫn giữ nguyên không đổi.

Chi phí client-side `applyPatch` (giám khảo 2 nêu bị nói nhẹ) ghi rõ ràng: cần 1 package thật trong pnpm workspace (`packages/shared`, export `applyPatch` + `PatchOpSchema` dùng chung server/web) — ước lượng ~0.5 ngày công riêng cho việc tách package (package.json, tsconfig, wiring 2 app import qua workspace protocol), KHÔNG downplay thành "copy nhẹ". Vì FE luôn reconcile theo server (mục 6), bug ở bản client không gây hậu quả vĩnh viễn — chỉ ảnh hưởng animation/optimistic UI trong khoảnh khắc ngắn.

## 8. Migration — BỔ SUNG backfill cho 11 sample (thiếu sót cả 3 giám khảo cùng nêu)

Vì `conversations.workflow_id` là `UNIQUE NOT NULL`, mọi workflow không có conversation đi kèm sẽ mồ côi khỏi sidebar mới. Giải pháp 2 lớp:
1. **Migration tự động khi server khởi động** (idempotent, không phải chỉ chạy 1 lần thủ công): mỗi lần start, server quét `SELECT id FROM workflows WHERE id NOT IN (SELECT workflow_id FROM conversations)` → với mỗi workflow mồ côi, tạo 1 `conversation` mới: `title` = `workflow.name`, `workflow_id` = id workflow đó (tái dùng, KHÔNG tạo workflow trùng), `created_at/updated_at` = timestamp gốc của workflow, `last_seen_change_id = NULL`, và chèn 1 message hệ thống dạng assistant: "Workflow này được nhập từ mẫu có sẵn — bạn có thể chat để AI tiếp tục chỉnh sửa." (để chat pane không trống trơn khi mở lại). Chạy an toàn nhiều lần vì điều kiện `NOT IN` luôn hội tụ về 0 workflow mồ côi sau lần đầu.
2. **Seed script cập nhật**: `pnpm --filter server seed` (tạo 11 sample) sau khi implement bước này sẽ tự tạo conversation đi kèm luôn (gọi cùng hàm backfill ở cuối script) — không phụ thuộc migration khởi động server nữa cho lần seed đầu.

Thứ tự triển khai (mỗi bước 1 spec, dừng hỏi user theo luật orchestration hiện có) — giữ 8 bước gốc, chèn thêm 2 bước mới:
1. Data model + repo (`conversations`, `messages`, `workflow_changes` + cột `version`/`snapshot_after`) — kèm unit test backfill idempotent.
2. `agent/chatTurn.ts` + `changeDigest.ts` + `PatchOpSchema` thêm `move-node` + optimistic-concurrency retry.
3. SSE `ChatTurnManager` + routes (kèm route `revert` + 409 version-conflict).
4. `ConversationRail` + `ChatPane` tĩnh thay modal `WorkflowList` — verify backfill hiện đủ 11 sample trong rail.
5. `SplitDivider` + Mode Toggle + `CanvasPane` refactor `App.tsx`.
6. Nối SSE streaming + animation canvas theo op.
7. Auto-log thay đổi tay (kèm `expectedVersion` + hàng đợi client) + tab "Lịch sử" + nút Khôi phục.
8. `packages/shared` tách `applyPatch` dùng chung 2 app.
9. E2E free-tier mới cho luồng chat + revert + version-conflict (mock OpenRouter, `CATALOG_LIVE=0`).

## 9. Rủi ro (cập nhật)

1. Chi phí OpenRouter tăng do mỗi tin nhắn = 1 LLM call — giữ nguyên giảm thiểu bản gốc (💰 estimate trong composer, cân nhắc model rẻ hơn riêng cho chat-turn, quyết định ở bước implement).
2. Streaming giả ở mức op — giữ nguyên cap 1.5s + nút bỏ qua animation.
3. ĐÃ VÁ — race sửa tay lúc AI đang chạy: version-conflict + 1 lần retry rebuild prompt, fail-safe rõ ràng thay vì âm thầm ghi đè (mục 6).
4. ĐÃ VÁ — AbortSignal: bắt buộc truyền từ `chatTurn.ts` ngay từ đầu, không kế thừa thiếu sót cũ.
5. Animation xoá node trễ 400ms + add-node cùng id trong lúc đang "removing" — giữ nguyên giảm thiểu bản gốc (huỷ animation xoá, coi node chưa từng bị xoá).
6. Dedupe digest mất "quá trình thử-sai" — vẫn là đánh đổi có chủ đích, nhưng nay có lưới an toàn thật: nút Khôi phục snapshot (mục 5) là đường lùi vật lý, không chỉ dựa vào "tự kể lại trong chat".
7. `workflow_changes` phình to theo thời gian, nay CÒN NẶNG HƠN vì mỗi dòng có thêm `snapshot_after` đầy đủ — giảm thiểu: `GET /changes` vẫn phân trang cursor mặc định; cân nhắc giai đoạn sau nén/xoá snapshot của các dòng cosmetic cũ hơn N ngày (không cần trong MVP vì scale local single-user, nhưng ghi rõ đây là nợ kỹ thuật cần theo dõi thay vì giả vờ không tồn tại).
8. Revert KHÔNG phải redo/branch đầy đủ — chỉ "về lại 1 điểm trong quá khứ rồi ghi thêm 1 dòng mới", không có cây lịch sử phân nhánh. Đủ cho MVP theo yêu cầu, không tự nhận là undo hoàn chỉnh kiểu editor chuyên nghiệp.
9. Chi phí thật của việc tách `packages/shared` (~0.5 ngày) và của Mode Toggle + backfill (thêm ~2 route, 1 migration, UI mới) làm tăng scope so với bản gốc — chấp nhận được vì đây chính là các khoản "nợ" giám khảo đã chỉ rõ là bắt buộc phải trả nếu chọn thiết kế này, không phải phát sinh ẩn.


---

# PHẦN II — Bản gốc chi tiết (tham khảo implement)

## II.1 Layout tổng thể


## Khung layout duy nhất, không router, không modal full-screen

```
┌──────────┬──────────────────────────┬───────────────────────────────────────────┐
│          │                          │                                             │
│ SIDEBAR  │        CHAT PANE         │              CANVAS PANE                    │
│ (rail)   │   (persistent, không     │   (FlowCanvas + right panel Params/Runs/    │
│ 56–260px │    phải popover)         │    Kết quả/Lịch sử — TÁI DÙNG NGUYÊN VẸN)   │
│          │                          │                                             │
└──────────┴──────────────────────────┴───────────────────────────────────────────┘
     ↑                    ↑↕ drag chia tỉ lệ (0–100%)              ↑
  collapse            SplitDivider — đây LÀ cơ chế đổi mode          panel phải bên
  độc lập,            duy nhất theo triết lý B. Không có nút          trong canvas pane
  không liên           "chat-only/split/canvas-only" riêng —          giữ y nguyên 3
  quan tỉ lệ            kéo tới 2 đầu là tự động snap.                tab hiện có, thêm
  chat/canvas                                                          tab thứ 4 "Lịch sử"
```

Toàn app là **1 màn hình duy nhất**, không có "trang chủ" tách biệt khỏi "editor" — đây chính là tinh thần triết lý B: copilot và canvas luôn cùng khung nhìn, khác biệt duy nhất giữa "trang chủ" và "đang sửa workflow" là **tỉ lệ chia** (100/0 lúc chưa có gì, tự nới sang split khi AI bắt đầu tạo node). Route duy nhất cần thêm là điều hướng theo `conversationId` (không bắt buộc router thật — có thể vẫn giữ SPA 1 trang như hiện tại, `conversationId` chỉ là state chọn item sidebar, tương tự cách `workflow` hiện đang được chọn qua `loadWorkflow(id)`).

**SplitDivider — cơ chế trung tâm:**
- Kéo chuột ngang trên thanh chia (rộng 6px, hover nở 10px, màu `--color-ink`, con trỏ `col-resize`) chỉnh `splitRatio` (0.0–1.0, % bề rộng dành cho chat pane).
- 3 vùng snap (không phải 3 nút riêng, chỉ là ngưỡng khi thả chuột):
  - `ratio < 0.08` → snap về `0.0` = **chat-only**: canvas pane thu về dải icon dọc 48px bên phải (hiện mini badge số node + trạng thái run nếu có).
  - `ratio > 0.92` → snap về `1.0` = **canvas-only**: chat pane thu về dải icon dọc 48px bên trái, có badge đỏ số tin nhắn AI chưa đọc nếu turn đang chạy nền.
  - Khoảng giữa → **split**, kẹp min-width thật: chat pane tối thiểu 320px, canvas pane tối thiểu 420px (nếu cửa sổ quá hẹp, ưu tiên giữ canvas ≥420px, chat co trước).
- Animate bằng CSS transition `width 300ms ease` (tắt dưới `prefers-reduced-motion`, khớp pattern đã có ở `ff-*` keyframes) — cả khi user kéo tay lẫn khi hệ thống tự đổi ratio (ví dụ auto-split khi AI tạo node đầu tiên, xem `homeScreen`).
- Lưu `splitRatio` vào `localStorage` (`ff.splitRatio`, không theo từng workflow — theo thói quen dùng app) và khôi phục khi mở lại app; dải rail thu gọn của sidebar lưu riêng `ff.sidebarCollapsed`.
- Phím tắt phụ trợ (không thay thế kéo tay, chỉ tiện cho bàn phím): `⌘\` toggle nhanh về chat-only/split gần nhất, `⌘⇧\` reset 40/60.
- Khi ratio đổi (kéo xong, thả chuột / snap), gọi `requestFitView()` (action đã có trong `store/flow.ts`) để React Flow tự canh giữa lại canvas theo kích thước mới.

Sidebar là trục điều hướng **độc lập** với SplitDivider — thu/mở bằng nút riêng ở góc trên (`⟨⟨`/`⟩⟩`), không tính vào 3 chế độ chat/canvas.


## II.2 Trang chủ chat


## Trang chủ = trạng thái khởi tạo của chính khung Copilot (yêu cầu 1)

Không có "trang chủ" là 1 view khác — nó là `splitRatio = 1.0` (chat-only) khi chưa chọn conversation nào, hoặc khi mở 1 conversation mà `workflow.nodes.length === 0`. Cụ thể:

- App mở lần đầu (chưa từng có conversation): sidebar hiện trống với CTA "+ Cuộc trò chuyện mới", canvas pane vô hình (ratio 1.0), chat pane full-bề rộng, bố cục căn giữa kiểu landing:
  - Logo/wordmark nhỏ góc trên trái (giữ nguyên gu neo-brutalist: `font-display` uppercase + `shadow-hard-3`).
  - Khung composer lớn căn giữa dọc màn hình (không dính đáy như chat thường) — textarea auto-resize, placeholder "Mô tả workflow bạn muốn tạo... vd: viết caption Facebook rồi tạo ảnh minh hoạ".
  - Dưới composer: hàng chip gợi ý nhanh lấy từ `samples/` có sẵn (11 mẫu) — click 1 chip = điền sẵn text mô tả tương ứng vào composer (không tự gửi, để user xem/sửa trước).
  - Nút gửi dùng `ui/Button` variant `ai` (hồng cat-video) — tái dùng nguyên component.
- User gõ mô tả đầu tiên, bấm gửi (hoặc Enter):
  1. Store tạo `conversation` mới (`POST /api/conversations`) kèm 1 `workflow` rỗng gắn 1-1 ngay từ đầu (xem `dataModel` — không đợi AI trả lời mới có workflow, tạo `emptyWorkflow()` claim luôn `workflow_id` để mọi patch sau này có chỗ ghi).
  2. Tin nhắn user render thành bubble ngay (optimistic).
  3. Bubble "assistant" xuất hiện ở trạng thái "đang nghĩ" (dùng `ui/Spinner.tsx` ◐ có sẵn) trong lúc gọi `POST /api/conversations/:id/messages`.
  4. Ngay khi sự kiện SSE đầu tiên `patch-op` bay về (xem `aiLoop`), **animate `splitRatio` từ 1.0 → 0.4** (chat co lại, canvas pane hiện ra) — đây là khoảnh khắc "AI bắt đầu vẽ" chuyển từ trang chủ sang copilot thật, đúng tinh thần "AI edit tới đâu canvas animate tới đó" (yêu cầu 2) ngay từ giây đầu tiên.
  5. Từng node/edge lần lượt "vật chất hoá" trên canvas (xem `aiLoop` phần animation) trong lúc chat vẫn tiếp tục hiện dòng "đang thêm node X..." dạng system-note nhỏ (chữ nghiêng, `text-ink-soft`, không phải bubble đầy) — user thấy đồng thời cả 2 pane chuyển động ăn khớp.
  6. Khi turn xong, bubble assistant chốt lại bằng câu trả lời tự nhiên ngắn (field `reply`, xem `aiLoop`) + 1 "diff chip" tóm tắt (xem `changeTracking`).
- Mở lại 1 conversation cũ đã có workflow: `splitRatio` khôi phục theo giá trị đã lưu (không phải luôn về 1.0) — trang chủ chỉ áp dụng cho conversation trống hoặc lần đầu mở app.

**Trong lúc AI đang edit** (turn đang chạy), composer chuyển placeholder thành "AI đang chỉnh workflow..." + disable gửi tin mới NHƯNG vẫn cho phép user gõ trước (hàng đợi 1 tin, gửi tự động khi turn hiện tại `done`) — tránh cảm giác app "đơ". Nút Stop (■, variant `danger`) xuất hiện cạnh composer để huỷ giữa chừng (mở endpoint mới, xem `risks` về AbortSignal — theo khảo sát backend, `ChatCompletionArgs.signal` đã tồn tại ở `openrouter.ts` nhưng chưa được truyền xuống từ `generateWorkflow`/`editNode`; agent mới `chatTurn.ts` PHẢI truyền signal này ngay từ đầu).


## II.3 Canvas / editor view


## Canvas pane — tái dùng gần như nguyên vẹn `FlowCanvas.tsx` + `NodeCard.tsx` (yêu cầu 3)

**Vào/ra:** không có "vào canvas view" như 1 điều hướng riêng — canvas LUÔN mounted (không unmount khi chat-only, chỉ bị `width: 0` + `overflow: hidden`, giữ React Flow instance sống để tránh remount tốn refit) miễn có 1 conversation đang mở. "Vào" canvas-only đơn giản là kéo divider hết cỡ phải (hoặc `⌘\`); "ra" là kéo lại. Khác biệt lớn nhất so với hiện tại: **không còn nút "✨ Describe" ở Toolbar và không còn popover "✨ edit-node" trên mỗi NodeCard** — cả 2 lối vào AI cũ (khảo sát mục 2a/2b) được **hợp nhất về chat pane trung tâm**:

- Nút ✨ nhỏ góc NodeCard **giữ nguyên vị trí, giữ nguyên icon**, nhưng đổi hành vi: click → nếu chat pane đang thu gọn thì mở lại (snap về ratio đã lưu trước đó, tối thiểu split 30/70) + focus composer + prefill `"Sửa node ${label || type} (${nodeId}): "` (con trỏ đặt sau dấu `:`), KHÔNG mở popover riêng nữa. Đây là cách "chỉnh tay xong quay lại chat" (yêu cầu 4) có 1 lối tắt vật lý ngay tại chỗ user đang nhìn.
- Toolbar bớt hẳn 1 nhóm nút (Describe) — xem `migration` phần cắt giảm.

**Người dùng vẫn chỉnh tay được graph (yêu cầu 3) — không đổi gì về mặt engine:**
- Kéo-thả node từ sidebar palette theo category (giữ nguyên `Sidebar` hiện có — cần làm rõ: đây là 2 "sidebar" khác namespace, xem lưu ý cuối `migration`).
- Kéo node đổi vị trí, nối/xoá edge với port-type validation màu port (`portColors.ts`), sửa params qua `ParamsPanel` (tab "Params" bên phải) — mọi hành vi y hệt hiện tại.
- ĐIỂM MỚI DUY NHẤT về hành vi: mọi hành động tay này giờ **tự động log vào `workflow_changes`** (xem `changeTracking`) — người dùng không thấy gì khác biệt khi thao tác (vẫn optimistic, tức thời trên Zustand store như cũ), việc ghi log chạy nền, không chặn UI.

**Chat hiện diện ra sao trong canvas-only mode:** khi thu gọn hết cỡ, chat không biến mất hẳn — dải rail 48px bên trái vẫn hiện: avatar/icon AI + badge tròn đỏ đếm số message mới nhận trong lúc thu gọn (trường hợp turn đang chạy nền khi user đang bận chỉnh canvas) + click vào rail = bung lại chat pane. Điều này đảm bảo dù đang ở canvas-only, user không "mất" AI, chỉ tạm giấu — đúng tinh thần "LUÔN thấy cả hai" của triết lý B (rail vẫn là 1 phần thấy được, không phải ẩn tuyệt đối).

**Right panel bên trong canvas pane** (Params | Runs | Kết quả) **+ 1 tab mới "Lịch sử"**: liệt kê `workflow_changes` của workflow hiện tại theo thời gian, mỗi dòng: nguồn (chip `[AI]` màu cat-video hồng / `[Tay]` màu ink trung tính) + tóm tắt 1 dòng + thời gian tương đối + click để mở rộng xem `ops_json` raw (dùng lại pattern JSON view đã có). Tab này thuần đọc, không có hành động revert ở bản MVP (xem `risks`).


## II.4 Sidebar (ConversationRail)


## Sidebar = danh sách conversation (thay thế hoàn toàn modal `WorkflowList.tsx`) — yêu cầu 5

**Quan hệ conversation ↔ workflow: 1-1, bắt buộc.** Đây là quyết định thiết kế cốt lõi để đơn giản hoá mental model cho app local single-user: mỗi item sidebar = 1 cặp (cuộc trò chuyện, workflow) không tách rời. Lý do chọn 1-1 thay vì N-1 (nhiều thread cho 1 workflow) hay 1-N (nhiều workflow trong 1 thread):
- Khớp với cách `WorkflowsRepo` hiện tại đã định danh workflow theo `id` duy nhất — không cần thiết kế lại tầng đó.
- Tránh câu hỏi khó "AI đang patch workflow nào nếu 1 thread quản nhiều workflow" — với 1-1, ngữ cảnh luôn rõ ràng: mở conversation = mở đúng 1 workflow, không có ambiguity khi build prompt.
- Nếu sau này user thực sự cần "nhánh thử nghiệm" (branch), có thể làm bằng "Nhân bản cuộc trò chuyện" (duplicate conversation + duplicate workflow với `id` mới) — không phá vỡ ràng buộc 1-1, chỉ tạo thêm 1 cặp mới. Không thiết kế trong MVP này, chỉ note khả năng mở rộng.

**Cấu trúc sidebar (rail bên trái, 260px mở / 56px thu gọn):**
```
┌────────────────────────┐
│ FlowForge        [⟨⟨]  │  ← logo + nút thu gọn
├────────────────────────┤
│ [+ Cuộc trò chuyện mới]│  ← luôn ở đầu, variant primary
│ [🔍 Tìm...............]│  ← lọc theo title, tái dùng UX ô search WorkflowList cũ
├────────────────────────┤
│ ● Video TikTok mèo     │  ← item đang mở: nền accent vàng (mirror style cũ)
│   fal.video · 2 phút   │
│ ○ Caption Facebook     │
│   fal.image · hôm qua  │
│ ○ Đọc kịch bản Vbee    │  ⚠ (badge đỏ nhỏ nếu run gần nhất lỗi)
│   vbee.tts · 3 ngày    │
└────────────────────────┘
```
- Mỗi item: `title` (auto từ 6-8 từ đầu tin nhắn đầu tiên — dùng lại đúng logic `injectWorkflowDefaults` hiện có cho `workflow.name`, áp cho `conversation.title`), sub-label = node type nổi bật nhất trong workflow (hoặc "Trống" nếu workflow rỗng) + thời gian tương đối (`updated_at` của conversation, bump mỗi khi có message mới HOẶC change mới).
- Chấm tròn trạng thái đầu dòng: `●` đầy nếu đang mở, `○` rỗng nếu không; badge `⚠` đỏ nhỏ góc phải nếu run gần nhất của workflow đó kết thúc `error` (query nhẹ `runs` table theo `workflow_id`, lấy status mới nhất — tái dùng thẳng `listRuns` API đã có).
- Click item → load conversation (`GET /api/conversations/:id`, trả cả `messages[]` + `workflow`) → nạp vào cả chat pane lẫn canvas pane cùng lúc, khôi phục `splitRatio` đã lưu.
- Hover item hiện nút ✕ xoá nhỏ (mirror UX cũ của `WorkflowList`, chỉ đỏ khi hover) — xoá conversation thì xoá luôn workflow 1-1 gắn với nó (xoá cascade ở tầng app, không cần FK cascade thật vì SQLite hiện không bật `PRAGMA foreign_keys`).
- Sidebar hoàn toàn thay thế modal `WorkflowList.tsx` (bỏ luôn nút Toolbar mở nó) — không còn khái niệm "danh sách workflow" tách biệt "danh sách conversation" nữa, vì luôn đi cùng cặp.

**Lưu ý đặt tên tránh nhầm lẫn:** sidebar node-palette hiện có (kéo-thả node theo category vào canvas, nằm cạnh `FlowCanvas`) và "sidebar conversation" mới này là 2 khối UI khác nhau, khác vị trí (palette nằm sát cạnh canvas pane bên trong, conversation-rail nằm ngoài cùng bên trái toàn app) — trong tài liệu implement cần đặt tên khác nhau rõ ràng, ví dụ `ConversationRail` vs `NodePalette` (đổi tên component `Sidebar.tsx` hiện tại thành `NodePalette.tsx` khi implement, tránh trùng tên với `ConversationRail.tsx` mới).


## II.5 Change tracking


## Change tracking — phần khó nhất, thiết kế chi tiết (đáp ứng yêu cầu 4)

### 1. Nguyên tắc nền: mọi thay đổi, dù AI hay tay, đều đi qua CÙNG MỘT vocabulary — `PatchOp`

`apps/server/src/agent/patch.ts` đã có sẵn `PatchOpSchema` (5 op: `update-node`, `add-node`, `remove-node`, `add-edge`, `remove-edge`) + `applyPatch()` pure/immutable + `PatchError` có `opIndex`. Đây là tài sản quan trọng nhất để tái dùng: **không tạo ra 1 định dạng change log riêng cho "tay" và 1 định dạng riêng cho "AI"** — cả 2 nguồn đều sinh ra `PatchOp[]`, chỉ khác `source`. Điều này vừa tiết kiệm code vừa (quan trọng hơn) làm cho change log là thứ AI đọc lại được dễ dàng vì nó đúng là ngôn ngữ mà AI đã quen "nói" (agent vốn đã được dạy trả patch ops).

**Bổ sung 1 op mới** cho việc kéo node đổi vị trí (hiện chưa có op nào cho `position`):
```ts
z.object({
  op: z.literal('move-node'),
  nodeId: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
})
```
`applyPatch()` xử lý y hệt các op khác (tìm node, deep-clone, gán `position` mới). Op này được đánh dấu `scope: 'cosmetic'` (xem mục 3) — không bao giờ vào digest gửi cho LLM, chỉ tồn tại để tab "Lịch sử" hiển thị đầy đủ nếu user muốn xem, và để tương lai có thể "undo" cả việc dời vị trí nếu cần.

### 2. Bảng `workflow_changes` — 1 dòng = 1 lần `applyPatch()` thành công

```sql
CREATE TABLE IF NOT EXISTS workflow_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,     -- 1-1 với workflow nên luôn suy ra được, lưu thẳng cho query nhanh
  source TEXT NOT NULL,              -- 'ai' | 'user'
  scope TEXT NOT NULL,               -- 'structural' | 'cosmetic'
  message_id TEXT,                   -- FK messages.id, chỉ set khi source='ai' (change này do đúng 1 turn nào sinh ra)
  ops_json TEXT NOT NULL,            -- PatchOp[] — CÙNG schema agent/patch.ts (+ move-node)
  summary TEXT NOT NULL,             -- 1 dòng tiếng Việt, human-readable
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_changes_workflow_id ON workflow_changes(workflow_id, id);
CREATE INDEX idx_changes_conversation ON workflow_changes(conversation_id, id);
```

`conversations` có thêm cột con trỏ:
```sql
last_seen_change_id INTEGER   -- AI đã "đọc" tới change nào; NULL = chưa turn nào chạy
```

### 3. Phân loại `scope`: structural vs cosmetic — quyết định cái gì AI cần biết

| scope | Gồm op nào | Vào digest gửi AI? | Hiện trong tab Lịch sử? |
|---|---|---|---|
| `structural` | `add-node`, `remove-node`, `remove-edge`, `add-edge`, `update-node` (params/label) | **Có** | Có |
| `cosmetic` | `move-node` | **Không** | Có (mặc định ẩn, có toggle "hiện cả thay đổi vị trí") |

Lý do tách: vị trí node là thẩm mỹ layout, không ảnh hưởng logic workflow — nhét vào context AI chỉ tốn token vô ích (AI không cần biết node bị kéo từ (100,200) sang (140,260)).

### 4. Ghi log — nguồn `user` (tay) vs `ai`

**Nguồn AI**: server tự ghi ngay sau khi `applyPatch()` + `validateWorkflow()` thành công trong 1 turn chat (xem `aiLoop`) — 1 turn = 1 dòng `workflow_changes` (dù turn đó sinh ra nhiều op, gộp chung `ops_json`), `message_id` trỏ tới message assistant vừa tạo.

**Nguồn tay**: frontend gọi `POST /api/workflows/:id/changes` bất cứ khi nào 1 hành động canvas commit xong. Map hành động → op:

| Hành động canvas | Op sinh ra | Thời điểm gửi |
|---|---|---|
| Kéo node từ palette thả vào canvas | `add-node` | Ngay (không debounce) |
| Xoá node (nút xoá/phím Delete) | `remove-node` | Ngay |
| Nối edge mới | `add-edge` | Ngay |
| Xoá edge | `remove-edge` | Ngay |
| Sửa param trong ParamsPanel (gõ chữ, kéo slider) | `update-node` (chỉ field đổi) | **Debounce 800ms sau keystroke cuối** (tái dùng đúng pattern debounce đã có cho `refreshEstimate` ở Toolbar) — tránh 1 dòng log cho mỗi ký tự gõ |
| Sửa label node | `update-node` (label) | Debounce 800ms |
| Kéo node đổi vị trí | `move-node` | Debounce 500ms sau khi thả chuột (drag-end), gộp nhiều lần kéo liên tiếp trong 500ms thành 1 dòng |

Endpoint tự sinh `summary` bằng rule-based template nếu FE không truyền (không tốn LLM call cho việc này — cố tình tránh gọi AI chỉ để tóm tắt 1 thao tác tay đơn giản):
```
update-node → `Đổi ${Object.keys(params).join(', ')} của node "${label||nodeId}"`
add-node    → `Thêm node "${type}" (${nodeId})`
remove-node → `Xoá node "${nodeId}"`
add-edge    → `Nối ${from.node}.${from.port} → ${to.node}.${to.port}`
remove-edge → `Xoá kết nối ${edgeId}`
move-node   → `Di chuyển node "${nodeId}"` (scope cosmetic, ít khi cần đọc)
```

### 5. Nén thành digest đưa vào context LLM — thuật toán cụ thể, có giới hạn token

Hàm `buildChangeDigest(workflowId, sinceChangeId)` (mới, `apps/server/src/agent/changeDigest.ts`):

1. Query `SELECT * FROM workflow_changes WHERE workflow_id=? AND id > ? AND scope='structural' ORDER BY id ASC` (nếu `sinceChangeId` NULL — turn đầu tiên — trả digest rỗng, không có gì để "nhớ lại").
2. **Dedupe theo khoá `(nodeId, paramKey)`** cho các `update-node`: nếu cùng 1 field của cùng 1 node bị đổi nhiều lần liên tiếp (ví dụ user gõ `prompt` rồi sửa lại 3 lần), chỉ giữ **giá trị SAU CÙNG**, bỏ các bước trung gian — dùng `Map` giữ lần xuất hiện cuối cùng theo thứ tự duyệt tăng dần id.
3. Nếu số dòng sau dedupe > **40**, cắt còn 40 dòng gần nhất + 1 dòng rollup đầu digest: `"... và N thay đổi khác trên node: id1, id2, ... (đã rút gọn, xem tab Lịch sử để biết chi tiết)"`.
4. Format mỗi dòng (ngắn, tiết kiệm token, ước lượng ~15–25 token/dòng):
   ```
   #<id> [<tay|AI>] <op> <mô_tả_ngắn>
   #118 [tay] update-node fal_image_1.size: "1024x1024" → "1024x1536"
   #121 [tay] remove-edge e_3 (llm_1.text → fal_image_1.prompt)
   #122 [tay] add-edge e_7 (input_text_2.text → fal_image_1.prompt)
   #130 [AI]  add-node vbee_tts_1 (vbee.tts)
   ```
   (dòng `[AI]` chỉ xuất hiện nếu có change AI xen giữa — thực tế hiếm vì mỗi turn tự cập nhật `last_seen_change_id` của chính nó, nhưng vẫn có thể xảy ra nếu 2 tab trình duyệt cùng mở, xem `risks`).
5. Ngân sách token cứng: cap tổng digest ở **~1500 token** (đo bằng ước lượng ký tự/4, không cần tokenizer thật) — nếu vượt dù đã dedupe+cắt 40 dòng, cắt tiếp theo LIFO (giữ các dòng MỚI NHẤT, bỏ dòng cũ hơn) tới khi vừa ngân sách.
6. Kết quả digest được `buildChatTurnSystemPrompt()` (xem `aiLoop`) chèn vào system prompt dưới heading riêng: `"### Người dùng vừa tự tay chỉnh workflow (từ lần AI trả lời trước):"` — tách bạch rõ với phần "workflow hiện tại dạng JSON" đã có sẵn trong `buildEditSystemPrompt` cũ, để LLM hiểu đây là NGỮ CẢNH THAY ĐỔI chứ không phải trạng thái tĩnh.

### 6. Cập nhật con trỏ `last_seen_change_id`

Ngay trước khi build system prompt cho 1 turn, server đọc `MAX(id)` hiện tại của `workflow_changes` cho workflow đó → dùng làm mốc TRÊN của digest kỳ này → sau khi turn xong (kể cả turn đó tự tạo thêm change mới), set `conversation.last_seen_change_id = MAX(id)` mới nhất (bao gồm cả change do chính turn này sinh ra) — đảm bảo turn kế tiếp không đọc lại những gì vừa xử lý.

### 7. Hiển thị UI cho user thấy AI "đã nắm được"

- Bubble assistant đầu mỗi turn (khi digest không rỗng) tự thêm 1 system-note nhỏ trước câu trả lời chính: *"Đã xem N thay đổi bạn vừa chỉnh tay..."* (N = số dòng digest trước dedupe) — đây là tín hiệu trực quan trả lời thẳng yêu cầu 4 ("chỉnh tay xong quay lại chat, AI phải biết") mà user KHÔNG cần tự hỏi lại AI có biết không.
- Tab "Lịch sử" (canvas pane) là nguồn sự thật đầy đủ, không nén, cho cả debug lẫn nhu cầu xem lại của user.
- Mỗi bubble assistant có patch cũng gắn "diff chip" (`🔧 +2 node · +2 edge · ~1 param`) — đếm trực tiếp từ `ops_json` của chính change đó (không cần tính lại digest).


## II.6 AI loop


## Vòng lặp AI — hợp nhất generate + edit thành 1 luồng "chat turn" duy nhất

### Ý tưởng cốt lõi: mọi turn đều là patch, kể cả turn đầu tiên

Thay vì giữ 2 đường riêng (`generateWorkflow` cho lần đầu, `editNode` cho các lần sau — như khảo sát mô tả), thiết kế mới coi **workflow luôn tồn tại từ đầu** (được tạo rỗng ngay khi conversation được tạo — `emptyWorkflow()`, xem `dataModel`). Turn đầu tiên chỉ là 1 patch gồm toàn `add-node`/`add-edge` áp lên workflow rỗng — về mặt kỹ thuật, `applyPatch(emptyWorkflow(), manyOps)` hoạt động y hệt việc "generate". Nhờ vậy chỉ cần **1 hàm agent mới** `apps/server/src/agent/chatTurn.ts`, KHÔNG sửa `generateWorkflow.ts`/`editNode.ts` hiện có (giữ nguyên cho e2e/unit test cũ và mọi API cũ vẫn hoạt động — tái dùng tối đa, không phá gì).

`chatTurn.ts` tái dùng gần như 100% hạ tầng có sẵn:
- `extractJson()` (agent/json.ts) — parse tolerant y hệt.
- `applyPatch()` + `PatchOpArraySchema` (agent/patch.ts) — thêm `move-node` như đã nêu.
- `validateWorkflow()` (engine/schema.ts) — không đổi gì.
- `zodErrorToIssues()` — không đổi.
- `buildEditSystemPrompt()` (promptBuilder.ts) làm khung — viết hàm chị em `buildChatTurnSystemPrompt(registry, workflow, changeDigest, chatHistory)`:
  - Nếu `workflow.nodes.length === 0` (turn đầu): chèn thêm 2 few-shot `GENERATE_FEWSHOT_*` đã có sẵn trong `promptBuilder.ts` (tái dùng nguyên văn) + đổi khung role thành "hãy TẠO workflow bằng patch ops (toàn add-node/add-edge)".
  - Nếu đã có node: giữ khung `buildEditSystemPrompt` (full workflow JSON + node catalog động + model catalog live/static) nhưng **bỏ dòng ép buộc "Node đích cần chỉnh sửa..."** (đây chính là hạn chế #5 khảo sát backend đã chỉ ra) — thay bằng "Người dùng có thể yêu cầu sửa bất kỳ phần nào của workflow, không giới hạn 1 node".
  - Luôn chèn thêm (mới): khối `changeDigest` (mục `changeTracking` §5) + **lịch sử hội thoại rút gọn**: N=10 message gần nhất dạng `{role, content}` thô (không tóm tắt — OpenRouter tính phí theo token nhưng history hội thoại vốn đã ngắn vì đây là chat lệnh, không phải văn bản dài; nếu vượt ngân sách 3000 token cho phần history, cắt bớt các message CŨ NHẤT trước).

### Response contract mới (khác `PatchOpArraySchema` trần của `editNode`)

```ts
const ChatTurnResponseSchema = z.object({
  reply: z.string().min(1),   // câu trả lời ngắn, tiếng Việt, hiện thành bubble assistant
  ops: PatchOpArraySchema,    // có thể RỖNG — hợp lệ khi user chỉ hỏi/làm rõ, không cần sửa gì
});
```
Retry loop giữ nguyên khuôn mẫu cũ (`MAX_ATTEMPTS=3`, feedback lỗi zod/patch/validate bơm ngược vào `messages`, giữ nguyên `workflow` gốc làm base mỗi attempt) — chỉ khác điểm dừng: nếu `ops` rỗng, bỏ qua bước `applyPatch`/`validateWorkflow`, coi turn thành công ngay với `reply` là câu trả lời thuần văn bản (không tạo dòng `workflow_changes` nào).

### Streaming "giả" ở mức OP, không phải token — quyết định kỹ thuật quan trọng

Khảo sát backend xác nhận `chatCompletion()` (OpenRouter) hiện là **non-streaming** (đợi full JSON response, timeout 120s). Streaming token-thật cần đổi hẳn sang `stream: true` của OpenRouter — đây là nâng cấp giai đoạn 2, KHÔNG bắt buộc cho MVP. Thay vào đó, để vẫn đạt hiệu ứng "AI edit tới đâu canvas animate tới đó" (yêu cầu 2) ngay cả khi LLM trả về ops 1 phát:

- Server, sau khi có `ops[]` hợp lệ đầy đủ (đã qua `applyPatch`+`validateWorkflow`), **phát lại tuần tự** từng op qua SSE với độ trễ nhân tạo ~180ms/op (`await sleep(180)` giữa các lần `send('patch-op', {op, index, total})`) — cảm giác "đang vẽ dần" dù thực chất toàn bộ đã tính xong trong bộ nhớ. Đây là giải pháp thực dụng, không cần đổi kiến trúc LLM call, ghi rõ trong code là "giả lập nhịp, chờ backend đổi sang OpenRouter streaming thật ở giai đoạn sau".
- Trước đó, ngay khi bắt đầu gọi LLM, gửi `send('thinking', {note: 'Đang phân tích workflow...'})` để composer/bubble hiện trạng thái sớm, không để user nhìn màn hình chết trong lúc chờ 120s timeout tối đa.

### Kiến trúc SSE — mirror 1:1 `RunManager`/`routes/runs.ts` đã có

1. `POST /api/conversations/:id/messages` `{content: string}` → tạo message user (status `done`) + message assistant placeholder (status `pending`) NGAY, trả 202 `{userMessageId, assistantMessageId}` — không block. Kích hoạt xử lý nền (giống cách `runManager` chạy `Engine` nền, không gắn với 1 HTTP request cụ thể).
2. Client mở `GET /api/conversations/:id/turns/:assistantMessageId/events` — SSE, dùng **đúng khuôn mẫu hijack** đã có ở `routes/runs.ts` (`reply.raw.writeHead` + `event:`/`data:` + heartbeat 15s + cleanup on `close`).
3. `ChatTurnManager` (file mới `apps/server/src/chatTurnManager.ts`, sao chép cấu trúc `RunManager`: `Map<turnId, Set<listener>>`, `activeTurns: Set<string>`) phát các event: `thinking`, `patch-op`, `message` (final, kèm `workflow` mới + `changeId`), `error` (kèm `issues?` nếu là `AgentValidationError`), `done`.
4. Frontend (`store/chat.ts` mới, song song `store/flow.ts`): nhận `patch-op` → gọi action mới `flowStore.applyIncrementalOp(op)` — áp NGAY op đó lên `workflow` cục bộ (không đợi cả batch xong) bằng cách gọi `applyPatch(workflow, [op])` (client cần 1 bản JS thuần của `applyPatch`, tách ra `packages/shared` hoặc copy nhẹ — xem `migration`) → đồng thời đánh dấu node/edge liên quan vào `recentlyChangedIds` để trigger animation.

### Animation canvas theo từng op (đáp ứng yêu cầu 2 cụ thể)

| Op nhận qua SSE | Hiệu ứng canvas |
|---|---|
| `add-node` | Node mount với keyframe mới `ff-materialize` (scale 0.85→1.02→1, opacity 0→1, viền chớp accent vàng 3 nhịp trong 1.2s) — style cùng họ với `ff-shake`/`ff-barber` đã có, gate `motion-safe:` |
| `add-edge` | Edge vẽ bằng `ff-dash` đã có sẵn trong CSS (nét đứt chạy), chuyển về nét liền sau ~1s |
| `update-node` | Viền node chớp nhẹ theo màu category (không phải accent — phân biệt "sửa" khỏi "thêm mới") 1 nhịp 600ms |
| `remove-node` | KHÔNG xoá khỏi DOM ngay — chuyển node sang trạng thái "removing" (opacity 1→0 + dịch nhẹ xuống, 400ms) rồi mới thật sự lọc khỏi `workflow.nodes`, tránh giật hình |
| `remove-edge` | Edge fade-out 300ms trước khi biến mất |
| `move-node` | Không tự sinh từ AI trong thiết kế này (AI không chủ động dời layout — nếu ops có `move-node` từ AI, vẫn animate nhẹ bằng CSS `transition: transform 300ms`) |

`recentlyChangedIds` tự clear sau 1.2s (timeout phía store), không cần server báo "hết animate".


## II.7 Data model & API


## Bảng SQLite mới

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL UNIQUE,   -- 1-1 bắt buộc; tạo cùng lúc với conversation (emptyWorkflow())
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_change_id INTEGER         -- NULL = chưa turn AI nào chạy qua workflow này
);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 'user' | 'assistant'
  content TEXT NOT NULL,              -- với assistant: field `reply` từ ChatTurnResponseSchema
  status TEXT NOT NULL DEFAULT 'done',-- 'pending' | 'streaming' | 'done' | 'error'
  error TEXT,                         -- message lỗi nếu status='error' (AgentValidationError.issues serialize JSON, hoặc network error)
  change_id INTEGER,                  -- FK workflow_changes.id nếu turn này tạo ra 1 change (NULL nếu chỉ trả lời, không patch)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'ai' | 'user'
  scope TEXT NOT NULL,                -- 'structural' | 'cosmetic'
  message_id TEXT,                    -- set khi source='ai'
  ops_json TEXT NOT NULL,             -- PatchOp[] (schema agent/patch.ts + move-node)
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_changes_workflow ON workflow_changes(workflow_id, id);
CREATE INDEX idx_changes_conversation ON workflow_changes(conversation_id, id);
```

Không đổi schema `workflows`/`runs`/`node_runs`/`cache`/`settings`/`catalog_cache` hiện có — `workflows.id` chính là `conversations.workflow_id`, mọi API chạy workflow (`POST /api/runs`, SSE run events...) không đổi 1 dòng.

## API endpoints mới

```
POST   /api/conversations
  body: {}  →  tạo conversation trống + emptyWorkflow() gắn 1-1
  200: { conversation: {id, workflowId, title, createdAt, updatedAt} }

GET    /api/conversations
  query: ?search=<text>
  200: { conversations: Array<{id, workflowId, title, updatedAt, nodeCount, lastRunStatus?}> }
  -- lastRunStatus: JOIN nhẹ subquery MAX(created_at) trên runs theo workflow_id, chỉ lấy status

GET    /api/conversations/:id
  200: { conversation, messages: Message[], workflow: Workflow }

PATCH  /api/conversations/:id
  body: { title?: string }
  200: { conversation }

DELETE /api/conversations/:id
  -- xoá cascade (app-level): messages, workflow_changes, workflow, runs/node_runs liên quan (tái dùng DELETE workflow đã có nếu tồn tại, hoặc thêm)
  204

POST   /api/conversations/:id/messages
  body: { content: string }  -- min length 1
  202: { userMessageId: string, assistantMessageId: string }
  400: content rỗng / conversation không tồn tại

GET    /api/conversations/:id/turns/:assistantMessageId/events   (SSE, hijack, mirror routes/runs.ts)
  events: thinking {note} | patch-op {op, index, total} | message {content, workflow, changeId} |
          error {message, issues?} | done {}

POST   /api/conversations/:id/messages/:messageId/stop
  -- huỷ turn đang chạy (AbortSignal truyền xuống chatCompletion), best-effort
  200: { stopped: boolean }

GET    /api/workflows/:id/changes
  query: ?since=<changeId>&limit=<n default 100>&includeCosmetic=<bool default false>
  200: { changes: WorkflowChange[] }

POST   /api/workflows/:id/changes
  body: { ops: PatchOp[], summary?: string }   -- nguồn tay, server set source='user', tự phân scope theo op
  200: { change: WorkflowChange, workflow: Workflow }   -- server tự applyPatch + validateWorkflow, 422 nếu invalid
  422: { error, issues: ValidationIssue[] }
```

Toàn bộ endpoint cũ (`/api/agent/generate-workflow`, `/api/agent/edit-node`, `/api/runs/*`, `/api/workflows/*` gốc, `/api/catalog/*`, `/api/estimate`) **giữ nguyên không đổi** — chat-first chỉ CỘNG THÊM, không thay thế tầng dưới.


## II.8 Migration


## Lộ trình từ UI hiện tại sang bản redesign

**Giữ nguyên 100% (không đổi 1 dòng logic nghiệp vụ):**
- `apps/server/src/{engine,nodes,catalog,db/sqlite.ts (bảng cũ), db/workflows.ts}` — toàn bộ execution engine, node providers, catalog, cache.
- `apps/server/src/agent/{generateWorkflow,editNode,patch,promptBuilder,json,layout}.ts` — dùng làm nền tảng cho `chatTurn.ts` mới, không sửa (chỉ *thêm* hàm `buildChatTurnSystemPrompt` cạnh `buildEditSystemPrompt`, *thêm* op `move-node` vào `PatchOpSchema`).
- `apps/server/src/routes/{runs,agent (cũ),catalog,estimate}.ts` — route cũ vẫn sống song song route mới.
- `apps/web/src/canvas/{FlowCanvas,NodeCard,categoryColors,statusColors,portColors,layout}.tsx/.ts` — canvas rendering, port validation, auto-layout không đổi.
- `apps/web/src/store/flow.ts` — gần như toàn bộ giữ nguyên (`setWorkflowJson`, `run()`, SSE run handling, `validate`, `refreshEstimate`, `autoLayout`...). Chỉ **thêm** action mới: `applyIncrementalOp(op)`, `recentlyChangedIds`, bỏ `describeOpen` (không cần popover Describe nữa).
- `apps/web/src/ui/{Button,Modal,Badge,Spinner}.tsx` — dùng nguyên cho chat bubble, composer, diff chip.
- `apps/web/src/index.css` (`@theme` tokens, `ff-*` keyframes) — giữ nguyên, chỉ **thêm** 1-2 keyframe mới (`ff-materialize`, fade-out cho remove-node).

**Sửa/refactor:**
- `App.tsx` — thay layout 3-cột cố định (Sidebar | Canvas | Params-aside) bằng `ConversationRail | ChatPane | CanvasPane(SplitDivider)`. `WorkflowList` modal, `describeOpen` popover bị loại khỏi luồng chính.
- `Toolbar.tsx` — bỏ nhóm nút "✨ Describe" (popover), bỏ nút mở `WorkflowList` (chuyển hẳn vào `ConversationRail`); giữ lại: Run, Validate, 💰 estimate, JSON view, Settings, 🪄 Sắp xếp — các nhóm này gắn với canvas pane, di chuyển vào bên trong `CanvasPane` header thay vì header toàn app.
- `NodeCard.tsx` — nút ✨ giữ nguyên vị trí, đổi handler: từ "mở popover riêng" sang "mở/focus chat pane + prefill composer" (xem `canvasScreen`).
- `Popover.tsx` — vẫn giữ, dùng cho các use-case còn lại (validate issues, 💰 estimate detail, model picker) — không dùng cho AI edit nữa.
- Đổi tên `Sidebar.tsx` (node palette) → `NodePalette.tsx` để tránh đụng tên với `ConversationRail.tsx` mới (xem lưu ý cuối `sidebar`).

**Thêm mới hoàn toàn:**
- Backend: `agent/chatTurn.ts`, `agent/changeDigest.ts`, `chatTurnManager.ts`, `routes/conversations.ts`, `routes/workflowChanges.ts`, migration SQL (3 bảng mới, thêm vào `SCHEMA_SQL` trong `db/sqlite.ts`), `db/conversations.ts` + `db/changes.ts` (repo pattern mirror `db/workflows.ts`).
- Frontend: `store/chat.ts` (message list, turn streaming state), `ConversationRail.tsx`, `ChatPane.tsx` (composer + bubble list), `ChatBubble.tsx`, `DiffChip.tsx`, `SplitDivider.tsx`, `CanvasPane.tsx` (bọc `FlowCanvas` + right-panel, thêm tab "Lịch sử" → `ChangeHistoryPanel.tsx`), `ui/Textarea.tsx` (tách trích từ pattern lặp lại — đúng như khảo sát frontend đã gợi ý).

**Thứ tự triển khai đề xuất (mỗi bước 1 spec riêng, dừng hỏi user theo luật orchestration hiện có):**
1. Data model + repo (`conversations`, `messages`, `workflow_changes` tables + CRUD) — không đụng UI, có unit test riêng.
2. `agent/chatTurn.ts` + `changeDigest.ts` + `PatchOpSchema` thêm `move-node` — unit test cô lập (giống cách `generateWorkflow.test.ts`/`editNode.test.ts` hiện có).
3. SSE `ChatTurnManager` + routes — test kiểu route-level giống `routes/runs.test.ts`.
4. `ConversationRail` + `ChatPane` tĩnh (chưa streaming, gọi API thường trước) thay modal `WorkflowList`.
5. `SplitDivider` + `CanvasPane` refactor `App.tsx`.
6. Nối SSE streaming + animation canvas theo op.
7. Auto-log thay đổi tay (`POST /api/workflows/:id/changes` từ mọi store mutator) + tab "Lịch sử".
8. E2E free-tier mới cho luồng chat (mock OpenRouter y hệt cách e2e hiện tại mock, `CATALOG_LIVE=0`).


## II.9 Rủi ro


## Rủi ro & giảm thiểu

1. **Chi phí OpenRouter tăng do mỗi tin nhắn = 1 LLM call trọn vẹn** (thay vì trước đây user chỉ gọi khi bấm nút Describe/Apply có chủ đích). Chat tự nhiên khuyến khích gõ nhiều lượt ngắn hơn. Giảm thiểu: hiển thị 💰 cost estimate ngay trong composer (số node hiện tại → ước lượng chi phí nếu Run, tái dùng `costEstimate` store field), và cân nhắc model rẻ hơn mặc định cho riêng chat-turn (khác `OPENROUTER_DEFAULT_MODEL` dùng cho run) — để orchestrator quyết định ở bước implement, không tự ý đổi default trong bản thiết kế này.

2. **Streaming "giả" ở mức op (delay nhân tạo 180ms/op)** có thể cảm giác gượng nếu turn chỉ có 1 op (không có gì để "rải nhịp") hoặc rất nhiều op (>20, chat cảm giác chậm chờ animation chạy hết ~3.6s dù dữ liệu đã sẵn). Giảm thiểu: cap độ trễ tổng tối đa ~1.5s bất kể số op (giảm delay động khi op nhiều: `delay = min(180, 1500/total)`), và cho phép user bấm "Bỏ qua animation" (skip) áp hết ngay lập tức nếu họ không quan tâm hiệu ứng.

3. **Race điều kiện: user chỉnh tay TRONG LÚC turn AI đang chạy nền.** AI build system prompt tại thời điểm T dựa trên workflow snapshot T; nếu user đổi param ngay sau đó, `applyPatch()` của AI (dựa trên workflow đã cache trong closure của turn) có thể ghi đè lại thay đổi tay đó khi merge. Giảm thiểu: `chatTurn.ts` đọc lại `workflow` MỚI NHẤT từ DB ngay trước bước `applyPatch()` cuối cùng (không dùng bản đã cache từ lúc build prompt) — nếu `workflow` đã đổi so với lúc prompt được build (so `updated_at` hoặc hash), digest turn tiếp theo sẽ tự động bắt được thay đổi này qua `last_seen_change_id` (không mất, chỉ trễ 1 turn) — chấp nhận được cho app single-user, không cần khoá pessimistic.

4. **Không có AbortSignal xuyên suốt hiện tại** (khảo sát backend đã nêu: `ChatCompletionArgs.signal` tồn tại ở tầng `openrouter.ts` nhưng chưa được truyền từ `generateWorkflow`/`editNode`). Nút Stop trong composer sẽ vô dụng nếu `chatTurn.ts` không cố ý truyền `signal` xuống — PHẢI làm đúng từ đầu khi viết `chatTurn.ts`, không kế thừa thiếu sót cũ.

5. **"Xoá node có animation trễ 400ms trước khi filter khỏi state"** — nếu user thao tác dồn dập (xoá rồi thêm lại node cùng id trong <400ms), có thể tạo trạng thái nhấp nháy kỳ lạ. Giảm thiểu: nếu `add-node` với cùng `id` đến trong lúc node đó đang ở trạng thái "removing", huỷ animation xoá, coi như node chưa từng bị xoá (id trùng về mặt logic là node "khác" theo op nhưng UI nên xử amiable).

6. **Digest dedupe theo `(nodeId, paramKey)` có thể MẤT ngữ cảnh "tại sao"** nếu user thử nhiều giá trị rồi chốt — AI chỉ thấy giá trị cuối, không thấy quá trình thử-sai. Đây là đánh đổi CÓ CHỦ ĐÍCH để giữ token thấp; tab "Lịch sử" đầy đủ vẫn có sẵn nếu user muốn AI "biết cả quá trình" — họ có thể tự kể lại trong tin nhắn.

7. **Bảng `workflow_changes` không giới hạn dung lượng** — với workflow bị chỉnh nhiều (hàng trăm change), truy vấn digest mỗi turn phải quét `id > sinceChangeId` (đã có index `(workflow_id, id)` nên nhanh) nhưng tab "Lịch sử" load full có thể chậm dần theo thời gian. Giảm thiểu: `GET /api/workflows/:id/changes` luôn có `limit` mặc định + phân trang kiểu cursor (`before=<id>`), không load hết 1 lần.

8. **Revert/undo KHÔNG có trong MVP này** (chỉ xem, không phục hồi) — nếu user thực sự cần "quay lại version trước", hiện chỉ có thể tự yêu cầu AI "đổi lại như cũ" (AI đọc digest + workflow JSON để tự suy luận cách undo, không có nút 1-click). Nêu rõ đây là giới hạn chấp nhận được cho MVP, không phải thiếu sót của thiết kế — undo thật cần thêm cơ chế snapshot/replay phức tạp hơn, để lại cho bước sau nếu user yêu cầu.

