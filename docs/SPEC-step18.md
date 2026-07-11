# SPEC step 18 — Redesign toàn bộ web theo hướng "Thô Mộc Nổi Loạn" (neo-brutalist)

User đã chọn hướng design "Thô Mộc Nổi Loạn" (neo-brutal) từ 4 đề xuất (artifact 11-07-2026).
Mockup tham chiếu: `/private/tmp/claude-501/-Users-thanh-OFFLINE-FILES-Videos-media-pipeline/4a672ac6-da8f-424e-88cc-1d718913bfa3/scratchpad/mockup-neo-brutal.html` (mở bằng browser để xem; đây là ĐÍCH thị giác, code thật phải giữ đúng chức năng hiện có).

## 0. Mục tiêu

1. Re-theme toàn bộ `apps/web` theo ngôn ngữ neo-brutalist: nền cream, viền đen 2–3px, bóng đổ cứng không blur, màu category bão hoà, bo góc 0.
2. Sửa kèm các lỗi UX cấu trúc audit đã chỉ ra (mục 8).
3. KHÔNG đổi behavior engine/server. KHÔNG đổi API. Chỉ `apps/web` (+ `e2e` nếu test cần cập nhật selector/assertion).

## 1. Design tokens — `apps/web/src/index.css` (Tailwind v4 `@theme`)

Thay file 1 dòng hiện tại bằng:

```css
@import "tailwindcss";

@theme {
  --color-bg: #FDF6E9;          /* nền canvas/app cream */
  --color-paper: #FFFFFF;       /* surface card/panel */
  --color-ink: #0D0D0D;         /* chữ + viền đen */
  --color-ink-soft: #5A5348;    /* chữ phụ */
  --color-accent: #FFDE21;      /* vàng chủ đạo */
  --color-cat-llm: #3B5FFF;
  --color-cat-image: #B6FF3B;
  --color-cat-video: #FF4FA3;
  --color-cat-audio: #FF6B1A;
  --color-cat-utility: #FFDE21;
  --color-status-pending: #C9C4B4;
  --color-status-running: #FFDE21;
  --color-status-success: #B6FF3B;
  --color-status-error: #FF3B3B;
  --color-status-skipped: #C9C4B4;
  --color-status-cached: #3B5FFF;
  --font-display: "Archivo Black", "Arial Black", system-ui, sans-serif;
  --font-mono-data: ui-monospace, SFMono-Regular, Menlo, monospace;
  --shadow-hard-2: 2px 2px 0 #0D0D0D;
  --shadow-hard-3: 3px 3px 0 #0D0D0D;
  --shadow-hard-5: 5px 5px 0 #0D0D0D;
  --shadow-hard-8: 8px 8px 0 #0D0D0D;
}
```

Kèm trong index.css: `@font-face` Archivo Black (mục 2), toàn bộ `@keyframes` (`ff-barber`, `ff-spin`, `ff-shake`, `ff-dash`), block override `.react-flow__*` (Controls, attribution, selection outline), và `@media (prefers-reduced-motion: reduce)` tắt mọi animation trang trí.

Port colors — `apps/web/src/canvas/portColors.ts` (giữ nguyên export shape, chỉ đổi hex):
`text #3B5FFF · image #B6FF3B · video #FF4FA3 · audio #FF6B1A · json #8B5CF6 · number #00D9C0 · any #0D0D0D`.
Thêm file mới `apps/web/src/canvas/statusColors.ts` export map 6 trạng thái theo token trên (hex thô — React Flow cần inline style).

## 2. Font display — Archivo Black self-host

- Tải woff2 subset `latin` + `latin-ext` + `vietnamese` (weight 400) từ fonts.gstatic.com về `apps/web/public/fonts/archivo-black/`; khai `@font-face` với `unicode-range` đúng từng subset, `font-display: swap`.
- Dùng cho: wordmark, header node, thanh category sidebar, tiêu đề modal, nút chính (uppercase).
- **CẤM** `skew`/italic trên text tiếng Việt (vỡ dấu). Wordmark "FLOWFORGE" (ASCII thuần) được phép skew(-8deg).
- Body/label giữ system stack; mọi giá trị kỹ thuật (model id, giá $, timestamp, port type) dùng `--font-mono-data`.
- Cỡ chữ tối thiểu 11px cho mọi text tiếng Việt (audit: 9–10px hiện tại quá nhỏ).

## 3. Primitives dùng chung — `apps/web/src/ui/` (file mới)

Dọn nợ "mỗi file tự gõ lại class" (audit): tạo và dùng ở MỌI nơi đang hand-roll:

- `Button.tsx` — variants: `primary` (nền accent vàng), `secondary` (nền trắng), `ghost` (viền nét đứt nền cream), `ai` (nền hồng cat-video, **chữ ĐEN** — trắng trên hồng fail AA), `danger` (nền trắng chữ đỏ, hover nền đỏ chữ trắng). Chung: `border-2 border-ink`, bo 0, shadow-hard-3, hover `translate(-2px,-2px)` + shadow-hard-5, active `translate(2px,2px)` + shadow none, disabled opacity 50 không hover-effect.
- `Badge.tsx` — chip mono nhỏ, viền đen 2px; prop màu nền.
- `Modal.tsx` — backdrop `bg-black/60` KHÔNG blur; panel nền trắng viền đen 4px bo 0 shadow-hard-8; header dải màu full-width (prop màu, mặc định accent) tiêu đề uppercase font-display + nút đóng ✕ ô vuông viền đen đảo màu khi hover.
- `Spinner.tsx` — thay 3 chỗ duplicate; hình ◐ quay (`ff-spin`).
- `Popover.tsx` — panel `absolute` viền đen 2px shadow-hard-5 nền trắng bo 0 (thay 4 chỗ hand-roll dropdown: Validate issues, cost estimate, Describe, node ✨ edit).

## 4. Store bổ sung — `apps/web/src/store/flow.ts` (làm ở phase Nền móng, consumer dùng sau)

- `fitViewNonce: number` + action `requestFitView()` (tăng nonce). FlowCanvas lắng nghe nonce → gọi `fitView({ padding: 0.15, duration: 300 })`.
- Fix bug tab Kết quả (audit CAO): ResultsPanel đang chỉ đọc run "live" trong store nên sau reload báo "Chưa có run nào" dù DB có run. Bổ sung: khi mount/đổi workflow mà không có run live → fetch danh sách runs của workflow, tự load run mới nhất (tái dùng logic `openRun` hiện có, KHÔNG tự đổi tab). Root-cause fix ở store/api, không chỉ đổi copy.

## 5. Treatment từng bề mặt

### 5.1 Toolbar (`panels/Toolbar.tsx`)
Cao 56–60px, nền trắng, viền dưới đen 3px. Nhóm bằng vạch đen dọc 2px (không phải khoảng trắng), trái→phải:
`[wordmark FLOWFORGE nền vàng viền đen skew(-8deg) + ô tên workflow viền đen 2px bo 0]` | `[New · Workflows · Save]` | `[Validate · badge 💰 nền lime font-mono đậm]` | `[▶ Run nền vàng, TO hơn các nút khác · ⚡ Run bỏ cache viền nét đứt]` | `[🪄 Sắp xếp · 👁 Preview]` | `[✨ Describe — nút `ai` hồng chữ đen + sticker "AI" nền lime xoay -10° đè góc trên-phải]` | `[{} JSON]` | spacer | `[⚙]`.
Badge 💰 đổi nền theo mức phí: lime < $0.05 ≤ vàng < $0.5 ≤ đỏ (chữ đen trên cả 3). `overflow-x: auto` khi hẹp. Nút 🪄 Sắp xếp: sau khi layout xong gọi `requestFitView()`.

### 5.2 Sidebar (`canvas/Sidebar.tsx`)
Rộng ~210px, nền trắng, viền phải đen 3px. Thanh category full-width nền màu category (llm chữ trắng, còn lại chữ đen), font-display uppercase, sticky khi cuộn, viền trên đen 3px. Node item: thẻ viền đen 2px shadow-hard-2, hover xoay -1.5° + dịch nhẹ ("nhặt sticker"), cursor grab. Cuối sidebar: banner tip viền nét đứt "Kéo node vào canvas hoặc bấm ✨ Describe để AI dựng workflow".

### 5.3 NodeCard (`canvas/NodeCard.tsx`) — giữ width 300px cố định
Nền trắng, viền đen 3px, bo 0, shadow-hard-5. Header 32–36px dải màu category đặc, chữ font-display uppercase (llm trắng/còn lại đen), badge type chip mono, nút ✨ ô vuông viền đen đảo màu hover. Port: ô vuông 11–12px viền đen 2px màu theo port, nhô ra ngoài mép card. Selected: viền 4px + shadow-hard-8. Dragging: shadow 10px 10px + xoay 1°. Badge trạng thái 22px đè góc trên-phải (top:-10px; right:-10px).

Run states (badge + hiệu ứng):
- `pending` ○ xám-be, card opacity ~90%.
- `running` ◐ quay (`ff-spin` 0.9s) + header barber-pole vàng-đen chạy (`ff-barber`). **KHÔNG** làm shadow nhảy theo giây (giám khảo: gây mệt).
- `success` ✓ nền lime viền đen + gạch chân lime 4px liền nét dưới header.
- `error` ✕ trắng/đỏ, toàn viền card đỏ 3px, shadow đỏ cứng, rung 1 lần (`ff-shake` 0.3s, không lặp).
- `skipped` badge "—", card phủ sọc chéo 45° (repeating-linear-gradient), opacity 55%, bỏ shadow.
- `cached` tem ⚡ VUÔNG nền cat-llm xoay 13° + gạch chân nét đứt xanh dưới header, tĩnh hoàn toàn.

### 5.4 Canvas + edges (`canvas/FlowCanvas.tsx` + file mới `canvas/BrutalEdge.tsx`)
- **GIỮ** `@xyflow/react/dist/style.css` (bắt buộc cho layout) — chỉ override class.
- `<Background variant="dots" gap={24} size={1.4} color="#0D0D0D" style={{opacity:.13}}/>`, wrapper nền `--color-bg`.
- Custom edge type mặc định: vẽ **2 path** — path đen dưới (strokeWidth 5) + path màu port trên (strokeWidth 3) → mọi edge (kể cả lime/vàng) đọc được trên nền cream (giám khảo bắt buộc). Marker mũi tên tam giác đen ở đầu đến. Edge nối tới node `running`: path màu thêm `stroke-dasharray 8 6` + `ff-dash` 0.6s. Edge selected: width 5/7.
- `<MiniMap nodeColor={node → màu category} maskColor="rgba(0,0,0,.5)" style viền đen 3px nền trắng/>` — hết lỗi minimap vô hình.
- Controls: nút vuông viền đen, bo 0, shadow-hard-2 (override CSS trong index.css).
- Canvas trống (0 node): overlay giữa màn hình khung viền đen nét đứt, chữ đậm "✨ MÔ TẢ WORKFLOW BẰNG LỜI — ĐỂ AI DỰNG CHO BẠN" + nút `ai` mở Describe + dòng phụ "hoặc kéo node từ sidebar trái". Overlay `pointer-events: none` trừ nút.
- Lắng nghe `fitViewNonce` → `fitView`.

### 5.5 Panel phải (`App.tsx` tabs + `panels/ParamsPanel.tsx`, `RunsPanel.tsx`, `ResultsPanel.tsx`)
Viền trái đen 3px. Tab kiểu "bìa hồ sơ": ô viền đen 2px, active nền vàng liền khối với body (bỏ viền dưới). Params: label uppercase mono 11px, input/select/textarea viền đen 2px bo 0, focus viền hồng + shadow hồng 2px. Checkbox "buộc chạy lại" vẽ tay: vuông 16px viền đen, on = nền đen ✓ vàng. Nút "Force re-run" = Button secondary, "Delete node" = Button `danger` **cách trên 24px + có divider** (audit: destructive không được ngang hàng). Runs: thẻ "vé xé" viền đen + cạnh dưới nét đứt, chấm status màu token, giờ mono, click viền hồng. Kết quả: khối viền đen shadow-hard-3, media đóng khung "polaroid" viền đen dày, nút Download/Copy pill viền đen bo 4px (ngoại lệ bo góc duy nhất cùng badge tròn).

### 5.6 Modals (`panels/WorkflowList.tsx`, `SettingsPage.tsx`, `JsonView.tsx`) — dùng `ui/Modal.tsx`
- WorkflowList: hàng viền đen 2px shadow-hard-2 hover nhấc lên; **thêm ô tìm kiếm** lọc theo tên (audit); nút Delete thu thành ô vuông ✕ nhỏ bên phải, hover mới đỏ.
- Settings: label-chip màu theo service (OpenRouter=cat-llm, fal.ai=cat-video, Vbee=cat-audio) trên mỗi input; input mono.
- JsonView: header đen; textarea nền `#0D0D0D` chữ lime mono ("phòng máy" — điểm tối duy nhất của UI).
- Preview.tsx: khung media viền đen theo polaroid style.

## 6. Hiệu chỉnh bắt buộc từ giám khảo (không được bỏ)

1. Display font phải render đủ dấu tiếng Việt (Archivo Black subset vietnamese) — không Arial Black.
2. Mọi edge có outline đen bên dưới + marker đen (lime/vàng trên cream 1.1–1.2:1 nếu không có outline).
3. Chữ trên nền bão hoà: đen trên hồng/lime/vàng/cam; trắng chỉ trên cat-llm xanh (4.58:1 AA large) và nền đen/đỏ.
4. `prefers-reduced-motion: reduce` → tắt barber-pole, ◐ quay (thay bằng badge tĩnh "…"), ff-shake, hover-translate.
5. Không remove React Flow base stylesheet.
6. Không shadow-jump loop trên node running.

## 7. Fix UX cấu trúc kèm theo (đã hứa trong artifact)

| # | Fix | Chỗ |
|---|-----|-----|
| 1 | Onboarding canvas trống + spotlight ✨ Describe | FlowCanvas overlay + Toolbar sticker |
| 2 | Minimap theo màu category | FlowCanvas MiniMap |
| 3 | Fit-view sau 🪄 Sắp xếp | store nonce + FlowCanvas |
| 4 | Toolbar nhóm 5 cụm + phân cấp Run/Describe | Toolbar |
| 5 | Bug tab Kết quả "chưa có run" dù có run | store/ResultsPanel (root cause, mục 4) |
| 6 | Badge 💰 đổi màu theo mức phí | Toolbar |
| 7 | Delete tách khỏi hành động thường | ParamsPanel + WorkflowList |
| 8 | Search trong WorkflowList | WorkflowList |

## 8. Ràng buộc kỹ thuật

- **KHÔNG đổi** `data-testid` hiện có, text label nút/tab (Save/Validate/Run/Params/Runs/Kết quả…), API calls, engine/server code. Thêm testid mới được phép (`empty-canvas-cta`, `workflow-search`).
- Giữ node width 300px + cơ chế `nodeSizes`/auto-layout (step 16) nguyên vẹn.
- Unit test web (115) + e2e free (13) phải xanh; test assert class cũ thì cập nhật assertion theo UI mới (không xoá test, không nới lỏng ý nghĩa).
- TypeScript strict, `pnpm --filter web typecheck` sạch.

## 8b. Addendum sau review (user báo 11-07-2026, fix trong cùng step)

1. **Minimap trắng bóc — root cause đã chẩn đoán xong (orchestrator xác minh bằng DOM):** không phải màu fill. React Flow v12 chỉ render node lên MiniMap khi user-node pass `nodeHasDimensions` (`measured ?? width ?? initialWidth`). `FlowCanvas` dựng node object mới mỗi render từ workflow JSON, không có kích thước → MiniMap render 0 `<rect>` (đã soi: `minimapNodeCount: 0` với 7 node trên canvas; bug tồn tại từ trước redesign). **Fix:** khi map `workflow.nodes` → React Flow nodes trong FlowCanvas, gắn kích thước từ store `nodeSizes` (slice sẵn có của step 16): `initialWidth: nodeSizes[id]?.width ?? 300`, `initialHeight: nodeSizes[id]?.height ?? 140` (KHÔNG dùng `width`/`height` cứng — sẽ pin inline style làm hỏng auto-height của card khi mở preview). Nghiệm thu: DOM `.react-flow__minimap-node` phải có đúng số node, fill đúng màu category.
2. **Pan bằng 2 ngón touchpad (song song với kéo chuột trái):** thêm props ReactFlow: `panOnScroll` + `panOnScrollMode={PanOnScrollMode.Free}`; GIỮ `panOnDrag` mặc định (click trái kéo vẫn pan); zoom vẫn hoạt động qua pinch trackpad / Ctrl+cuộn (behavior mặc định của React Flow khi bật panOnScroll). Không đổi `zoomOnPinch`.

## 9. Nghiệm thu

1. `pnpm -r test` + `pnpm --filter web typecheck` + `pnpm run e2e` xanh.
2. Screenshot app thật (empty canvas, workflow 7 node, params, runs, kết quả, 3 modal) đối chiếu mockup — orchestrator duyệt.
3. Review panel (Fable) trên diff + adversarial verify (Sonnet), sửa hết findings CONFIRMED.
4. Commit + push, noti ntfy, cập nhật CLAUDE.md (step 18).
