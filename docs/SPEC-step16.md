# SPEC — Bước 16: Fix layout tè le — node cố định bề rộng + auto-layout chuẩn

Bug user (có screenshot): sau ✨ generate/run, node LLM giãn rộng cả nghìn px theo text preview, node đè nhau, edge chéo loạn. 2 nguyên nhân: NodeCard không cap width; autoLayout server giả định node ~280px.

## 1. NodeCard cố định bề rộng

- Mọi node: `w-[300px]` cố định (không min/max co giãn). Title/ports/preview/badge đều truncate/wrap trong khung đó:
  - Title: `truncate` + `title` tooltip full.
  - Text preview: giữ clamp-1 nhưng thêm `break-all`/`overflow-hidden` (không đẩy width).
  - Video/image preview: `w-full` max-h như cũ (media không vượt 300px).
- Cập nhật test node-card: assert class width cố định.

## 2. Auto-layout client-side chuẩn (`apps/web/src/canvas/layout.ts`)

```ts
export function layoutWorkflow(wf: Workflow, sizes?: Record<string, {width:number;height:number}>): Workflow; // pure, trả bản mới có positions
```
- Layered theo topo depth (BFS từ node không có input edge; cycle-safe — node còn lại dồn cột cuối).
- x: mỗi cột rộng = max width thực của node trong cột (fallback 300) + gap 100; x cột n = tổng trước đó.
- y trong cột: xếp dọc theo height thực (fallback 200) + gap 60, căn giữa quanh trục.
- `sizes` lấy từ React Flow `useNodesInitialized`/node.measured khi có; không có → fallback.

## 3. Wiring

- Toolbar nút **"🪄 Sắp xếp"** (testid `auto-layout-btn`): store action `autoLayout()` — lấy sizes đo được từ React Flow hiện tại, gọi layoutWorkflow, setWorkflowJson (giữ selection, dirty=true).
- **Tự chạy layout sau ✨ generate thành công** (setWorkflowJson từ Describe panel → khi nodes render + measured xong chạy autoLayout 1 lần; đơn giản: sau generate gọi autoLayout với fallback sizes ngay — không cần đợi đo).
- Server `agent/layout.ts`: bump khoảng cách x 280→380, y 150→240 (spec đồng bộ; positions LLM sinh ra bớt chồng ngay cả trước khi client layout).

## 4. Tests

- Web unit `layout.test.ts`: depth columns đúng (diamond), không chồng (bounding box disjoint với sizes giả), cycle-safe, pure. Toolbar test: nút gọi autoLayout. node-card width test.
- Server `agent-layout` test hiện có: cập nhật khoảng cách mới.
- E2E free: test mới — apply workflow qua JSON view với positions chồng nhau (cùng 1 điểm) → bấm 🪄 Sắp xếp → đọc `data-node-id` transform/position qua React Flow DOM (hoặc JSON view) xác nhận positions đã tách và không trùng. Chạy e2e 2 lần.

## 5. DoD

Server + web typecheck/test/build xanh; e2e (13 tests) 2 lần xanh; KHÔNG chạy model thật.
