# SPEC — Bước 6: Polish — JSON view, cache/force indicator, Settings page, README

Bước cuối MVP. KHÔNG phá API/behavior cũ; mọi suite hiện có phải tiếp tục xanh.

## 1. Settings API (server)

```
apps/server/src/settings.ts          # đọc/ghi .env.local + cập nhật process.env
apps/server/src/routes/settings.ts   # GET/PUT /api/settings
apps/server/test/api-settings.test.ts
```

- Keys quản lý: `OPENROUTER_API_KEY`, `FAL_KEY`, `VBEE_APP_ID`, `VBEE_TOKEN` (secret — mask) và `OPENROUTER_DEFAULT_MODEL` (không secret — hiện full).
- `GET /api/settings` → `{ settings: [{ key, isSet: boolean, preview: string | null, secret: boolean, value?: string }] }` — secret: `preview` = `'••••' + 4 ký tự cuối` khi isSet (null khi chưa set), KHÔNG BAO GIỜ trả full value; non-secret: trả `value` full.
- `PUT /api/settings` body `{ [key]: string }` (chỉ nhận 5 key trên, key lạ → 400; value rỗng → bỏ qua key đó): cập nhật `process.env` NGAY + ghi xuống file env (mặc định `.env.local` ở repo root; `buildServer` opts thêm `envFilePath?` để test trỏ file tmp). Ghi file: giữ nguyên các dòng không liên quan (comment, key khác), replace dòng key đã có, append key chưa có. Trả về masked summary như GET. Response/log không bao giờ chứa full secret.
- Đăng ký route trong buildServer.

## 2. JSON view panel (web)

- Toolbar thêm nút `{} JSON` toggle panel (chiếm cột phải hoặc overlay rộng): textarea monospace chứa `JSON.stringify(workflow, null, 2)`, đồng bộ khi workflow đổi (nếu user chưa sửa dở — có draft state).
- Nút **Apply**: `JSON.parse` fail → báo lỗi inline, không apply. Parse ok → `setWorkflowJson(parsed)` (graph tự cập nhật, dirty=true) rồi gọi `POST /api/workflows/validate` hiển thị issues (cảnh báo, không block). Nút **Reset** quay về JSON hiện tại của store.
- File: `apps/web/src/panels/JsonView.tsx` + test `json-view.test.tsx` (apply valid → store đổi; JSON hỏng → lỗi + store không đổi; reset).

## 3. Cache / force indicator (web)

- NodeCard: khi node nằm trong `forceNodeIds` → chip nhỏ `🔁 force` cạnh badge (test trong node-card.test.tsx hiện có hoặc file mới).
- Toolbar: cạnh Run thêm nút phụ `Run ⚡ bỏ cache` = run với forceNodes = tất cả node id (không đụng forceNodeIds đã queue).

## 4. Settings page (web)

- `apps/web/src/panels/SettingsPage.tsx` — mở từ Toolbar (nút ⚙). GET /api/settings render: secret key → password input placeholder = preview (`••••cf40`) + nhãn "đã set"/"chưa set"; non-secret → text input với value hiện tại. Nút Save: chỉ gửi các field user đã nhập (khác rỗng). Thành công → reload GET, hiện "Đã lưu". Lỗi → message.
- api/client.ts thêm getSettings/putSettings. Test `settings-page.test.tsx`: render masked (không bao giờ hiện full secret), PUT chỉ chứa field đã nhập.

## 5. README.md (root)

Ngắn gọn (≤80 dòng): FlowForge là gì, screenshot placeholder, yêu cầu (Node 22+, pnpm), setup (`pnpm install`, `.env.local` mẫu với 5 biến — GIÁ TRỊ GIẢ), chạy (`pnpm --filter server dev` + `pnpm --filter web dev`, mở :5173), test (`pnpm -r test`), kiến trúc 1 đoạn (engine JSON-first → xem docs/SPEC-step*.md), danh sách 9 node.

## 6. Definition of Done

- Server: typecheck + test xanh (cũ + api-settings). Web: typecheck + build + test xanh (cũ + json-view + settings-page).
- Orchestrator browser smoke: JSON view roundtrip, settings hiện mask đúng, Run ⚡ bỏ cache chạy lại node.
