# SPEC — Bước 9: Results UX — canvas gọn + panel Kết quả + download

Vấn đề user báo: (1) preview in thẳng lên node làm node phình to, edge rối "mũi tên chĩa tá lả"; (2) không có chỗ xem result cuối cùng rõ ràng; (3) tưởng result không được lưu (thực tế đã lưu trong `node_runs.outputs_json` + `data/artifacts/` — chỉ thiếu UI surface). Chỉ sửa frontend + 1 bổ sung nhỏ backend; mọi suite cũ (183 server + 68 web + 10 e2e free) phải tiếp tục xanh.

## 1. Canvas gọn (NodeCard)

- Preview inline mặc định **thu nhỏ cố định**: thumbnail ảnh/video max 80px cao, audio chỉ hiện icon 🔊 + duration nếu có, text chỉ 1 dòng đầu (clamp-1) — **node không đổi bề rộng, cao thêm tối đa ~90px** → edge ổn định.
- Mỗi node có nút toggle nhỏ (▾/▸) ẩn/hiện preview của node đó; giữ `data-testid="node-preview"` khi hiện.
- Toolbar thêm toggle **"👁 Preview"** (bật/tắt toàn bộ preview trên canvas, default BẬT). State trong store (`showNodePreviews`).
- Click vào thumbnail/preview trên node → mở panel Kết quả và scroll tới output node đó.

## 2. Panel "Kết quả" (ResultsPanel — tab thứ 3 cột phải: Params | Runs | Kết quả)

- `apps/web/src/panels/ResultsPanel.tsx`, testid `results-tab` / `results-panel`.
- Nội dung theo run đang xem (`runId` hiện tại hoặc run mở từ history qua `openRun`):
  - **Khối "Kết quả cuối"**: outputs của mọi node `output.collect` (nếu không có node collect → outputs của các leaf node success). Hiển thị TO: ảnh full-width, video/audio player đầy đủ controls, text trong khung monospace scroll + nút 📋 Copy.
  - **Khối "Tất cả node"** (collapse mặc định đóng): từng node success + outputs thu gọn.
  - Mỗi media có nút **⬇ Tải về** (`<a download href="/artifacts/...">`) + hiện tên file; mỗi text có nút Copy.
  - Run lỗi → hiện node lỗi + error message đỏ ở đầu panel.
- **Auto-switch**: khi run kết thúc (status success/error) → tự chuyển sang tab Kết quả. Khi user click run cũ trong RunsPanel (`openRun`) → cũng chuyển sang tab Kết quả. (Cơ chế tab đang là local state trong App.tsx — nâng lên store nếu cần.)
- Panel ghi rõ dòng nhỏ: "Kết quả lưu tại data/artifacts/ và lịch sử Runs — không mất khi reload."

## 3. Backend bổ sung nhỏ (duy nhất)

- `GET /artifacts/:filename` thêm header `Content-Disposition: attachment` KHI có query `?download=1` (để nút Tải về ra tên file gốc; default inline như cũ). Test bổ sung trong api-artifacts.test.ts.

## 4. Tests

- Web unit: `results-panel.test.tsx` — render kết quả cuối từ output.collect (image + text), nút download đúng href `?download=1`, copy button gọi clipboard mock, run lỗi hiện error, không có collect → dùng leaf nodes; cập nhật node-card tests cho preview compact + toggle; store test cho `showNodePreviews` + auto-switch tab state.
- E2E free tier: cập nhật app.spec.ts nếu selector đổi (giữ `node-preview` testid); THÊM 1 test: sau happy run, tab Kết quả tự mở và chứa text "Lời chào: xin chào" + panel có nút copy; download link có `?download=1`. E2E free phải pass 2 lần liên tiếp.

## 5. DoD

- Server: typecheck + 183+ tests xanh (thêm artifacts download test). Web: typecheck + build + tests xanh (cũ + mới). E2E free 2 lần xanh. KHÔNG chạy e2e real / workflow tốn tiền.
