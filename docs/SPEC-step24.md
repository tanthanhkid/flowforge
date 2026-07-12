# SPEC step 24 — AI-native "Copilot Song Song": SplitDivider + Mode Toggle + CanvasPane (refactor App.tsx)

Bước 5/9 của lộ trình AI-native (`docs/DESIGN-ai-native.md` I §1-§3). Frontend: layout split-pane thật — chat và canvas LUÔN cùng khung nhìn, khác nhau chỉ ở `splitRatio`. Đây là bước đổi layout lớn nhất → phần e2e phải sửa có chủ đích (§7).

## §1 Phạm vi file

- Sửa `apps/web/src/store/chat.ts`: thêm state layout (`splitRatio`, mode derive, persist).
- Mới `apps/web/src/panels/ModeToggle.tsx` + `apps/web/src/panels/SplitDivider.tsx` + `apps/web/src/panels/CanvasPane.tsx`.
- Sửa `App.tsx` (layout mới), `Toolbar.tsx` (thêm ModeToggle, gỡ nút ✨ Describe), `ChatPane.tsx` (landing hero khi full-width + rỗng), `FlowCanvas.tsx` (onboarding CTA đổi sang chat), `store/flow.ts` (gỡ describe state).
- Tests web mới/cập nhật + e2e helper & test mới.

## §2 State layout (`store/chat.ts`)

```ts
splitRatio: number            // 0..1 = phần bề rộng của ChatPane (0 = canvas-only, 1 = chat-only)
setSplitRatio(ratio: number, opts?: { animate?: boolean }): void
layoutMode(): 'chat' | 'split' | 'canvas'   // derive: >=0.99 chat, <=0.01 canvas, else split — expose qua selector
```

- Persist localStorage key `ff.splitRatio` (đọc khi init, ghi mỗi lần set — throttle 200ms). Giá trị init mặc định khi chưa từng lưu: `1.0` (chat-first).
- Clamp + snap: sau khi tính min-width (§4), ratio kéo xuống làm pane < min → snap về 0 hoặc 1 (đóng hẳn pane đó).
- `animate: true` → component áp CSS transition 300ms (state chỉ lưu ratio đích + cờ `animating` tự clear sau 300ms).
- Auto-hành vi:
  - `selectConversation` một conversation có `nodes.length > 0` khi đang `chat` mode → `setSplitRatio(0.5, { animate: true })`.
  - Trong `sendMessage.onMessage`: nếu `changeId !== null` (AI vừa sửa workflow) và đang `chat` mode → `setSplitRatio(0.4, { animate: true })` (interim — bước 25 chuyển trigger sang patch-op đầu tiên).
- Phím tắt global (đăng ký ở App, cleanup đúng): `⌘\` (Ctrl+\ non-Mac) cycle chat → split → canvas → chat; `⌘⇧\` chiều ngược. Không bắt khi focus trong input/textarea.

## §3 `ModeToggle.tsx` (đặt trong Toolbar, luôn thấy)

- 3 nút liền nhau kiểu segmented control neo-brutalist: `Chat | Chia đôi | Canvas` (`data-testid="mode-chat" / "mode-split" / "mode-canvas"`), nút active nền `bg-accent`.
- Click → `setSplitRatio(1.0 / 0.5 / 0.0, { animate: true })`.
- Badge chấm đỏ (●, màu `status-error`) trên nút `Chat` khi `turnState === 'streaming'` VÀ layout đang `canvas` (turn chạy nền mà chat bị ẩn).

## §4 `SplitDivider.tsx` + layout App

```
<Toolbar (…cũ, + <ModeToggle/>, − nút Describe) />
<div flex flex-1 min-h-0>
  <ConversationRail />                                   // luôn hiện (w-64/w-14 như bước 23)
  <section ChatPane  style={{ width: chatPx }} />        // ẩn hẳn khi ratio<=0.01 (width 0, overflow hidden)
  <SplitDivider />                                       // w-2, cursor-col-resize, bg-ink, hover bg-accent
  <section CanvasPane style={{ flex: 1 }} />             // LUÔN MOUNTED — kể cả khi ratio>=0.99 (width 0)
</div>
```

- `SplitDivider`: pointer events (down/move/up + setPointerCapture), kéo cập nhật ratio realtime KHÔNG animate; double-click → 0.5. Ẩn (w-0) khi mode chat hoặc canvas (không có gì để kéo — dùng ModeToggle/phím tắt để mở lại).
- Min-width: ChatPane ≥ 320px, CanvasPane ≥ 420px khi cả hai visible; kéo vượt → snap 0/1 (qua logic store §2).
- **CanvasPane.tsx** = gói `<Sidebar /> + <main FlowCanvas /> + <aside 3 tab>` (bê nguyên từ App.tsx hiện tại, không đổi bên trong). QUAN TRỌNG: luôn mounted để giữ React Flow instance — khi width 0 dùng `overflow-hidden` + `visibility: hidden` (không `display: none` — tránh React Flow đo sai khi hiện lại); khi ratio đổi từ chat-only sang visible → `requestFitView()`.
- ChatPane khi mode `chat` (full-width): nếu conversation rỗng/chưa chọn → landing hero: headline lớn font-display, composer to căn giữa (max-w-2xl), chip gợi ý bên dưới (tái dùng chip bước 23); có message → layout chat thường nhưng cột nội dung max-w-3xl căn giữa.

## §5 Gỡ ✨ Describe (chat thay thế)

- `Toolbar.tsx`: xoá nút Describe + popover + `describe-input` + handleGenerate (giữ nguyên MỌI nút khác: Run, Save, JSON, Settings, 💰, 🪄, tên workflow...).
- `store/flow.ts`: xoá `describeOpen`/`toggleDescribe`/`openDescribe`/`closeDescribe`.
- `FlowCanvas.tsx` onboarding overlay (canvas trống): CTA '✨ Mô tả workflow bằng lời' đổi thành '💬 Chat với AI để tạo workflow' → `setSplitRatio(0.5, {animate:true})` + focus composer (expose `focusComposer()` qua chat store: cờ nonce, ChatPane effect focus).
- Server route `POST /api/agent/generate-workflow` GIỮ NGUYÊN (không đụng server bước này).
- Tests cũ của Describe (`agent-ui.test.tsx`, phần liên quan trong `toolbar.test.tsx`, `store.test.ts`) — cập nhật/xoá phần Describe, KHÔNG đụng phần edit-node ✨ trên NodeCard (vẫn giữ nguyên ở bước này).

## §6 Tests web

1. Store layout: `setSplitRatio` clamp/snap theo min-width (mock container width qua tham số hoặc logic thuần), mode derive 3 vùng, persist localStorage (mock), auto 0.5 khi select conversation có node, auto 0.4 khi onMessage có changeId, cycle phím tắt (test hàm thuần `nextMode(current, dir)`).
2. `ModeToggle`: 3 nút set đúng ratio, active đúng theo ratio, badge đỏ khi streaming + canvas mode.
3. `CanvasPane`: luôn mounted — render app ở ratio 1.0 → FlowCanvas vẫn trong DOM (queryByTestId), visibility hidden; đổi ratio → visible + fitView được gọi.
4. `ChatPane`: landing hero khi mode chat + rỗng; layout thường khi có message.
5. Toolbar: không còn nút Describe; ModeToggle render.
6. `SplitDivider`: double-click → 0.5; drag pointer events cập nhật ratio (fireEvent pointer down/move/up với clientX mock).

## §7 E2E (rủi ro chính của bước này — sửa có chủ đích, không nới lỏng assertion)

- Thêm helper `e2e/tests/helpers.ts` (hoặc trong spec file): `openCanvasMode(page)` = click `mode-canvas`; `openSplitMode(page)` = click `mode-split`.
- Mọi test cũ thao tác canvas/palette/params: sau khi mở app (+ chọn conversation nếu cần), gọi `openCanvasMode(page)` trước bước thao tác canvas đầu tiên (canvas full-width → drag-drop ổn định với viewport 1280px).
- Test mới: (a) mở app lần đầu (localStorage sạch) → landing hero chat full-width hiện, canvas ẩn; (b) 3 nút mode chuyển đúng (canvas hiện/ẩn qua visibility); (c) chọn conversation có node từ rail → tự về split; (d) ⌘\ cycle mode.
- Suite phải xanh toàn bộ; nghiêm cấm skip/xoá test cũ (chỉ được thêm bước mở mode + đổi selector khi UI đổi thật).

## §8 Nghiệm thu

`pnpm --filter web test` + `typecheck` + `pnpm --filter server test` (không đổi) + `pnpm run e2e` xanh toàn bộ; canvas giữ nguyên mọi chức năng (kéo node, params, run, results); không dependency mới.
