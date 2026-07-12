# SPEC step 26 — AI-native "Copilot Song Song": canvas sống theo từng patch-op

Bước 7/9 (`docs/DESIGN-ai-native.md` I §6). Frontend-only: dùng events `patch-op` (server đã pace sẵn min(180,1500/total)ms — bước 22) để node/edge vật chất hoá dần trên canvas trong lúc AI trả lời. Cần `shared` (bước 25).

## §1 Phạm vi file

- Sửa `apps/web/src/store/chat.ts`: handler `onPatchOp` thật (optimistic apply + highlight), đổi trigger auto-split.
- Sửa `apps/web/src/canvas/NodeCard.tsx` + `canvas/BrutalEdge.tsx` + CSS (`index.css`): hiệu ứng materialize/flash/draw.
- Sửa `apps/web/src/store/flow.ts` nếu cần expose setter workflow tối thiểu cho optimistic apply (KHÔNG đụng semantics dirty/save cũ).
- Tests web. Server KHÔNG đổi.

## §2 `onPatchOp` (store/chat.ts)

Với mỗi `{ op, index, total }` (đã qua guard `isDisplayed()` như các handler khác — op của conversation không còn active thì bỏ):

1. **Op đầu tiên của turn** (`index === 0`): nếu layout đang `chat` mode → `setSplitRatio(0.4, { animate: true })`. GỠ trigger interim ở `onMessage` (bước 24 §2) — chuyển hẳn sang đây.
2. **Optimistic apply**: `applyPatch(workflowHiệnTại, [op])` từ `shared` → cập nhật workflow hiển thị (setter mới `applyOptimisticOp` trong flow store: cập nhật `workflow` KHÔNG set `dirty` — đây là thay đổi AI đã persist server-side, sẽ được reconcile). `PatchError` (vd op phụ thuộc op trước bị lệch) → bỏ qua op đó im lặng (console.warn) — bản authoritative sẽ đến ở `message`.
   - `add-node` thiếu `position` → đặt tạm `{ x: 120 + (index % 4) * 340, y: 120 + Math.floor(index / 4) * 220 }` — autoLayout cuối turn sửa lại.
3. **Highlight**: store `opHighlights: Record<string, { kind: 'added' | 'updated' | 'edge-added'; nonce: number }>` — set cho nodeId/edgeId tương ứng (`add-node`→added, `update-node`/`move-node`→updated, `add-edge`→edge-added; remove-* thì xoá phần tử luôn, không highlight). Clear toàn bộ khi `onDone`.
4. `onMessage` giữ nguyên reconcile bước 23: `adoptWorkflow(workflow server)` + `autoLayout()` + `requestFitView()` — bản server luôn thắng bản optimistic.

## §3 Hiệu ứng (CSS keyframes trong `index.css`, chạy 1 lần theo `nonce` key)

- Node `added`: keyframe `ff-node-pop` ~250ms — scale 0.85→1 + opacity 0→1 + shadow offset từ 0 lên chuẩn (đúng vibe neo-brutalist "đóng dấu").
- Node `updated`: keyframe `ff-node-flash` ~400ms — viền flash sang `accent` rồi về `ink`.
- Edge `edge-added`: `BrutalEdge` áp `stroke-dasharray` + animate `stroke-dashoffset` về 0 (~300ms, tái dùng pattern `ff-dash` nếu có).
- `NodeCard`/`BrutalEdge` đọc highlight qua props/store selector; key bằng `nonce` để re-trigger được khi cùng node được sửa 2 turn liên tiếp. Respect `prefers-reduced-motion: reduce` → tắt animation (CSS media).
- KHÔNG làm nút "Bỏ qua animation" (design gốc có nhưng server đã cap tổng pacing ≤1.5s — không đáng thêm UI; ghi nhận là quyết định lệch design có chủ đích).

## §4 Tests web

1. store: `onPatchOp` áp op đúng thứ tự (2 op add-node → workflow 2 node, dirty vẫn false), op lỗi bị bỏ qua không throw, highlight set đúng kind + clear khi done, guard conversation khác không đụng workflow, op đầu chuyển split khi đang chat mode (và KHÔNG chuyển khi đang split/canvas).
2. `onMessage` reconcile thắng optimistic (mock workflow server khác optimistic → state cuối = server).
3. NodeCard: có class animation khi highlight added/updated, không có khi hết highlight; BrutalEdge: class draw khi edge-added.
4. Cập nhật test bước 24 về trigger auto-split (chuyển từ onMessage sang patch-op đầu).

## §5 Nghiệm thu

`pnpm --filter web test` + `typecheck` + `pnpm --filter server test` (không đổi) + `pnpm run e2e` xanh; không dependency mới; `prefers-reduced-motion` được tôn trọng.
