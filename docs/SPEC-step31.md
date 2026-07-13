# SPEC step 31 — Canvas UX fix pack (từ audit trực quan 2026-07-13)

> Bối cảnh: user báo "canvas nhiều lỗi UX". Orchestrator audit bằng Playwright screenshot
> (2 viewport 1920×1080 + 1366×768, 34 màn, thao tác read-only trên samples + demo convo)
> + đọc code root-cause. 8 finding dưới đây, đánh số F1–F8, kèm thiết kế fix.
> Ưu tiên của step này: F1/F2/F3/F8 (nặng) → F4/F5/F7 (vừa) → F6 (nhẹ).
> Backlog UX 5 mục cũ (đính kèm ảnh composer, diff chip, summary giàu, AI đặt tên, badge i2i)
> dời sang step 32+.

## Findings & thiết kế fix

### F1 (NẶNG) — Mở/đổi conversation không fitView: workflow nằm ngoài màn hình

Triệu chứng: mở conversation 10 node của user chỉ thấy 1 node; sample 9 node bị clip
nửa trái sát mép palette; minimap cho thấy cụm node nằm ngoài viewport trắng.
Sau khi bấm 🪄 Sắp xếp (có fitView) canvas đẹp ngay — chứng tỏ lỗi là viewport, không phải node design.

Root cause: `adoptWorkflow` (store/flow.ts) không bump `fitViewNonce`. React Flow `fitView`
prop chỉ chạy 1 lần lúc mount; CanvasPane chỉ `requestFitView()` khi pane hidden→visible
(step 24). Canvas luôn mounted nên đổi conversation không fit lại.

Fix (FE — store/flow.ts + nơi gọi adoptWorkflow khi đổi conversation, store/chat.ts):
- Khi adopt một workflow có **id khác** workflow đang hiển thị (đổi conversation, load
  lần đầu) → `requestFitView()` sau khi state đã set.
- **KHÔNG** fit khi reconcile cùng-id (SSE message, POST changes response, revert…) —
  tuyệt đối không reset viewport user đang pan/zoom giữa turn AI (giữ nguyên hành vi step 26).
- Cách làm gợi ý: so sánh `workflow.id` cũ/mới ngay trong `adoptWorkflow`, hoặc thêm tham số
  `opts?: { fit?: boolean }` do caller đổi-conversation truyền — chọn cách ít xâm lấn,
  nhưng phải phủ cả đường load-lần-đầu (mở app đã có conversation active) lẫn đường switch.
- Double-fit với visible-effect của CanvasPane (khi vừa đổi conversation vừa mở split) vô hại — chấp nhận.

Test (web vitest): adopt id mới → fitViewNonce tăng; adopt cùng id → không tăng.
E2E: mở sample từ rail ở mode canvas → bounding box của MỌI node-card nằm trong canvas-pane.

### F2 (NẶNG) — Toolbar tràn ở viewport hẹp (1366×768): mất nút PREVIEW/JSON/⚙

Triệu chứng: 1366px chỉ thấy tới "PRE…", JSON + Settings ngoài màn; header có
`overflow-x-auto` (lưới an toàn từ step 18) nhưng không có affordance scroll — user tưởng mất nút.

Fix (FE — panels/Toolbar.tsx, thuần Tailwind breakpoint, không JS đo đạc):
- Dưới breakpoint (đề xuất `xl` 1280px — nếu 1366 vẫn tràn thì dùng `2xl` 1536, agent tự đo
  bằng cách render thử/tính tổng width): các nút phụ rút còn icon-only, label bọc
  `<span className="hidden xl:inline">`: VALIDATE→✓, SẮP XẾP→🪄, PREVIEW→👁, JSON→`{}`,
  RUN ⚡ BỎ CACHE→⚡, NEW/SAVE giữ chữ (ngắn). Mọi nút icon-only phải có `title` + `aria-label`
  giữ nguyên ngữ nghĩa.
- Ô tên workflow: `w-40 xl:w-64` (đang cố định rộng).
- Giữ `overflow-x-auto` làm lưới an toàn cuối cùng.
- Tiêu chí: ở 1366×768 **toàn bộ** testid `validate-btn, cost-estimate, run-btn, run-force-btn,
  auto-layout-btn, preview-toggle-btn, json-view-btn, settings-btn` nhìn thấy được không cần scroll.

E2E: viewport 1366×768 → tất cả các nút trên `toBeVisible()` + không có horizontal scroll
trong header (`scrollWidth <= clientWidth`).

### F3 (NẶNG) — Popover không đóng bằng click-ra-ngoài / Escape, dính qua cả đổi conversation

Triệu chứng: mở popover 💰 Ước tính chi phí → click node, đổi conversation, đổi mode, Escape —
popover vẫn treo (xuyên 5 bước audit liên tiếp); chỉ đóng bằng ✕.

Root cause: `ui/Popover.tsx` là primitive display-only (portal + position), không có logic đóng;
caller (Toolbar cost/validate) chỉ toggle bằng nút + ✕.

Fix (FE — ui/Popover.tsx + callers):
- Thêm prop `onClose?: () => void`. Khi có: (i) `document` mousedown (capture) mà target nằm
  ngoài panel VÀ ngoài anchor → gọi onClose; (ii) keydown Escape → onClose.
- Toolbar: cost popover + validate popover truyền `onClose={() => setOpen(false)}`.
- NodeCard ✨ edit popover và mọi caller khác của Popover: rà và truyền onClose tương tự.
- ModelPicker nếu tự quản Escape/outside rồi thì không double-handle (kiểm tra, tránh đóng 2 lần
  gây side effect chọn nhầm).

Test (web vitest, testing-library): render Popover với onClose → fireEvent mousedown ngoài →
onClose gọi; Escape → onClose gọi; mousedown trong panel → không gọi.
E2E: mở cost popover → click giữa canvas → popover biến mất.

### F4 (VỪA) — Nút "+" tạo ngay conversation rỗng, bấm nhiều lần tích rác "Chưa đặt tên"

Triệu chứng: mỗi click "+ Cuộc trò chuyện mới" → POST tạo conversation ngay (audit 2 pass
để lại 2 dòng rỗng). Design gốc (DESIGN Phần I §2) là chỉ tạo khi gửi tin đầu — bản ship lệch.

Fix (FE — store/chat.ts `newConversation`): giữ kiến trúc tạo-ngay (không refactor lớn),
nhưng trước khi POST: nếu trong danh sách đã có conversation "chưa dùng"
(`title === '' && nodeCount === 0`) → chuyển sang nó thay vì tạo mới. Kết quả: tối đa 1 dòng
rỗng tồn tại.

Test: unit store — gọi newConversation 2 lần liên tiếp (mock api) → api.createConversation chỉ
được gọi 1 lần, lần 2 switch. E2E: bấm + hai lần → số conversation-item không tăng thêm 2.

### F5 (VỪA) — Panel Ước tính chi phí bị cắt nội dung, không scroll

Triệu chứng: workflow 10 node — list item cắt ngang giữa "img1/img2", dòng "Tổng" đè lên,
không scroll được.

Fix (FE — component cost popover trong Toolbar.tsx): phần list `max-h-[50vh] overflow-y-auto`;
dòng "Tổng" + ghi chú là footer cố định ngoài vùng scroll.

Test: unit render với 30 node giả → list có class overflow-y-auto; footer Tổng vẫn render.

### F6 (NHẸ) — Label params thô: MODELID / ASPECTRATIO / EXTRA

Fix (FE — panels/ParamsPanel.tsx): map label tiếng Việt cho key phổ biến
(`modelId→Model`, `duration→Thời lượng (giây)`, `aspectRatio→Tỉ lệ khung`,
`extra→Tham số thêm (JSON)`, `voiceCode→Giọng đọc`, `speed→Tốc độ`, `format→Định dạng`,
`systemPrompt→System prompt`, `temperature→Temperature`, `instruction→Chỉ dẫn`,
`template→Mẫu ghép`, `value→Nội dung`, `path→Đường dẫn file`, `maxPages→Số trang tối đa`…
— rà đủ params của 13 node types trong `apps/server/src/nodes/`); key lạ fallback
prettify camelCase → "Model Id" (bỏ style UPPERCASE hiện tại cho key lạ).
KHÔNG đổi param key gửi server.

Test: unit — label map cho modelId/aspectRatio; fallback key lạ.

### F7 (VỪA) — 🪄 Sắp xếp không ghi change log (AI mù vị trí mới) + SAVE sáng lên sai semantics

Triệu chứng: sau Sắp xếp trên demo workflow, change log server KHÔNG có move op nào
(xác nhận qua API), và nút SAVE bật sáng (dirty) — trái triết lý step 27
"mọi thao tác tay auto-log, log thành công = đã persist, không cần Save".

Fix (FE — nơi thực thi auto-layout, store/flow.ts / canvas/layout.ts):
- Sau khi áp positions mới → enqueue **1 entry** manualLog chứa N op `move-node`
  (scope cosmetic sẵn có), summary "sắp xếp lại bố cục (N node)".
- Dirty semantics: đi đúng đường manualLog như drag tay (log thành công → không dirty).
- Agent này KHÔNG sửa Toolbar.tsx (file thuộc agent F2/F3/F5) — nếu handler nằm trong
  Toolbar.tsx thì chuyển logic xuống store action rồi Toolbar chỉ gọi action
  (nếu buộc phải sửa 1-2 dòng ở Toolbar.tsx: dừng lại, ghi chú trong kết quả trả về
  để orchestrator tự khâu, KHÔNG tự sửa).

Test: unit — action auto-layout tạo đúng N move-node ops vào manualLog queue; dirty=false
sau flush thành công.

### F8 (NẶNG — data loss) — Revert change đầu tiên của workflow backfill → mất trắng về emptyWorkflow()

Triệu chứng THẬT (orchestrator dính khi dọn demo): workflow "Demo screenshot" có 4 node tạo
trước kỷ nguyên change-log (backfill step 20, 0 change row). Thêm 1 node (change #8 là row
ĐẦU TIÊN) rồi revert #8 → `getPrevSnapshot` không có row trước → fallback `emptyWorkflow()`
→ **mất cả 4 node gốc**. Cùng họ bệnh: PUT /api/workflows/:id (Save cũ + JsonView apply)
không ghi change row (PHẦN 0 deviation #3) → chuỗi snapshot có "lỗ hổng", revert nhảy qua
các thay đổi PUT.

Fix (BE — server):
1. **Seed initial snapshot cho workflow 0-change** (db/changes.ts + backfill sẵn có ở
   server.ts/seed): idempotent — với mọi workflow có conversation nhưng chưa có change row
   nào → tạo row `{source:'user', scope:'structural', ops:[], summary:'Trạng thái khởi tạo',
   snapshot_after = workflow hiện tại}`. Chạy cùng chỗ backfill startup step 20 (đảm bảo
   chạy cả cho DB hiện hữu lẫn seed mới). KHÔNG set last_seen_change_id lùi/đổi digest logic —
   row ops:[] không tạo dòng digest có nghĩa (kiểm tra changeDigest bỏ qua đẹp, giống row revert).
2. **PUT /api/workflows/:id ghi change row** khi nodes/edges thực sự đổi (so sánh
   JSON.stringify bản cũ/mới): row `{source:'user', scope:'structural', ops:[],
   summary:'Cập nhật thủ công (Save/JSON)', snapshot_after = bản mới}`. Đổi mỗi `name`
   (rename) → KHÔNG ghi (tránh noise). Trả thêm được nợ PHẦN 0 #3: AI thấy được
   "có chỉnh sửa JSON tay" qua digest.
3. Giữ fallback emptyWorkflow() CHỈ cho workflow sinh từ chat (chuỗi tự nhiên: row đầu là
   turn đầu — prev của nó đúng là rỗng).

Test (server vitest): (a) workflow backfill 0-change → sau startup có initial row; thêm node
→ revert row đó → về 4 node gốc (KHÔNG rỗng); (b) PUT đổi nodes → có change row mới + digest
không vỡ; PUT chỉ đổi name → không row mới; (c) idempotent: chạy backfill 2 lần → vẫn 1 initial row.

## Phân công (4 agent implement song song — file ownership TUYỆT ĐỐI)

| Agent | Findings | Files được sửa |
| --- | --- | --- |
| FE-canvas | F1, F7 | `apps/web/src/store/flow.ts`, `store/chat.ts` (chỉ chỗ adopt khi đổi conversation), `canvas/FlowCanvas.tsx`, `canvas/layout.ts`, `store/manualLog.ts`, `panels/CanvasPane.tsx`, test web tương ứng |
| FE-toolbar | F2, F3, F5 | `apps/web/src/panels/Toolbar.tsx`, `ui/Popover.tsx`, `canvas/NodeCard.tsx` (chỉ phần truyền onClose), test web tương ứng |
| FE-misc | F4, F6 | `apps/web/src/store/chat.ts` (chỉ hàm newConversation), `panels/ConversationRail.tsx` (nếu cần), `panels/ParamsPanel.tsx`, test web |
| BE-snapshot | F8 | `apps/server/src/db/changes.ts`, `routes/workflows.ts`, `server.ts`, seed script, test server |

Lưu ý xung đột: FE-canvas và FE-misc cùng đụng `store/chat.ts` — FE-canvas chỉ sửa vùng
adopt-conversation, FE-misc chỉ sửa `newConversation`; 2 vùng khác nhau, không đè nhau.
E2E (app.spec.ts / chat.spec.ts) do **1 agent E2E riêng** viết SAU khi 4 agent trên xong
(tránh conflict file spec): thêm describe "canvas UX (step 31)" với các test đã nêu ở
F1/F2/F3/F4, chạy free tier 0 đồng.

## Nghiệm thu (orchestrator)

1. `pnpm -r test` xanh (441+ server, 320+ web, 20 shared — số mới tăng theo test thêm).
2. `pnpm run e2e` xanh (27 + test mới).
3. Screenshot lại đúng kịch bản audit (mở sample → canvas; đổi conversation; 1366×768;
   cost popover + click ngoài) — so trước/sau.
4. Commit main + push, ntfy, dev server :3001 (tsx watch tự reload; kiểm tra).
