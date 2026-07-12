# SPEC step 25 — AI-native "Copilot Song Song": `packages/shared` — applyPatch + PatchOpSchema dùng chung FE/BE

Bước 6/9 (đã đôn lên trước bước animation/auto-log vì cả hai cần `applyPatch` phía client — quyết định orchestrator 2026-07-12, xem CLAUDE.md). Thuần hạ tầng: KHÔNG đổi hành vi nào của app, KHÔNG UI mới.

## §1 Phạm vi

- Mới `packages/shared`: pnpm workspace package tên `shared` chứa toàn bộ domain PatchOp.
- Sửa `pnpm-workspace.yaml`: thêm `packages/*`.
- `apps/server`: `agent/patch.ts` thành **thin re-export** từ `shared` (mọi import path cũ `../agent/patch.js` GIỮ NGUYÊN hoạt động — không sửa hàng loạt caller).
- `apps/web`: thêm dependency `shared` (workspace protocol) — bước này CHỈ cần import được (dùng thật ở bước 26/27); thêm 1 smoke test import.
- Di chuyển unit tests của patch sang `packages/shared/test`; server giữ 1 test mỏng xác nhận re-export.

## §2 Nội dung `packages/shared`

Chuyển NGUYÊN VẸN từ `apps/server/src/agent/patch.ts` (không đổi logic/message — chỉ đổi chỗ ở):
- `PatchOpSchema`, `PatchOpArraySchema`, type `PatchOp` (đủ 6 op gồm `move-node`)
- `applyPatch()` (pure), `PatchError`
- `opScope()`, `changeScope()`

Kèm type `WorkflowLike` tối thiểu mà `applyPatch` cần (`{ nodes, edges, ... }` — generic/structural để cả `Workflow` của server (`engine/schema.ts`) lẫn `Workflow` của web (`api/types.ts`) đều gán được mà KHÔNG kéo zod-schema workflow của server sang shared). Nếu giải pháp generic phức tạp hoá chữ ký, được phép định nghĩa `WorkflowShape` cụ thể (nodes/edges đúng shape hiện dùng) trong shared và cho 2 bên cast — chọn phương án đơn giản, ghi notes.

Dependency của shared: chỉ `zod` (đúng version range server đang dùng).

## §3 Ràng buộc tích hợp (QUAN TRỌNG NHẤT của bước này)

Sau khi tách, TẤT CẢ các lệnh sau phải chạy đúng **không cần thêm bước build thủ công nào**:

```
pnpm install
pnpm --filter server test / typecheck / dev / seed / smoke
pnpm --filter web test / typecheck / build / dev
pnpm -r test
pnpm run e2e            # webServer của Playwright tự start server+web như hiện tại
```

Cách đạt được (implementer chọn phương án đơn giản nhất thoả toàn bộ, ghi rõ notes; gợi ý ưu tiên): package `shared` export **TypeScript source trực tiếp** (`exports` trỏ `./src/index.ts`) — Vite/vitest/tsx đều ăn TS source trong workspace; nếu `tsc --noEmit` của server/web không resolve được exports-trỏ-.ts với moduleResolution hiện tại thì điều chỉnh cấu hình typecheck tối thiểu (vd `customConditions`/`paths` chỉ trong tsconfig, không đổi runtime) HOẶC chuyển sang phương án build `dist/` + `.d.ts` với build được wire tự động vào các script trên (prepack/predev/pretest) — cấm trạng thái "phải nhớ chạy build tay".

## §4 Tests

1. `packages/shared/test/patch.test.ts`: chuyển toàn bộ case của `apps/server/test/agent-patch.test.ts` sang (giữ nguyên assertions).
2. `apps/server/test/agent-patch.test.ts` thu gọn thành smoke: import từ `../src/agent/patch.js` vẫn trả đúng `applyPatch`/`PatchOpSchema`/`PatchError`/`opScope` (re-export sống).
3. `apps/web/test/shared-import.test.ts`: import `applyPatch` từ `shared`, apply 1 op `add-node` lên workflow rỗng của web (`api/types.ts` Workflow) — chạy được trong môi trường vitest của web.
4. `pnpm -r test` phải chạy cả test của shared (thêm vitest config cho package nếu cần).

## §5 Nghiệm thu

Toàn bộ lệnh §3 xanh; `pnpm run e2e` 16+/16+ (hành vi app không đổi); server 429+ test vẫn xanh (chỉ patch test dời chỗ); không mất case test nào (đếm tổng case patch trước/sau phải ≥ cũ).
