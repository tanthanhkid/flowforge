# SPEC — Bước 10: Input ảnh / PDF / Markdown + upload từ browser

Mục tiêu: user đưa được tài liệu/ảnh của mình vào workflow trực tiếp từ UI. 3 node mới + endpoint upload. Mọi suite cũ phải xanh. Registry là nguồn sự thật — agent LLM (✨) tự thấy node mới qua `describeForAgent()`, không cần sửa prompt.

## 1. Backend

### 1.1 Upload endpoint
- Dep mới: `@fastify/multipart`. `POST /api/upload` (multipart, field `file`): lưu vào `<artifactsDir>/uploads/<uuid>.<ext-gốc-sanitized>` → 201 `{ path: "uploads/<file>", filename: "<tên gốc>", mime, size, kind: "image"|"pdf"|"markdown"|"video"|"audio"|"other" }`.
- Giới hạn 50MB → 413; không file → 400. Ext sanitize (chỉ `[a-z0-9]{1,8}`). `GET /artifacts/uploads/<file>` phải serve được (artifacts route hiện chặn `/` trong filename — nới đúng 1 cấp `uploads/` hoặc dùng route param riêng; vẫn chặn traversal tuyệt đối, thêm test).

### 1.2 Ba node mới (mỗi node 1 file, đăng ký vào nodes/index.ts — registry 9 → 12)
- `input.image` (utility): params `{ path: string min(1) }` (relative artifactsDir hoặc absolute) → out `image:image` (MediaValue kind image, mime theo ext png/jpg/jpeg/webp/gif). File thiếu/ext sai → error tiếng Việt rõ. `cacheable: false`.
- `input.pdf` (utility): params `{ path, maxPages?: int>0 (optional) }` → out `text:text` (text trích từ PDF, dùng package **`unpdf`** — ESM, không native dep) + out `info:json` (`{ pages, truncated }`). PDF không có text layer → error gợi ý "PDF scan chưa OCR". `cacheable: false`.
- `input.markdown` (utility): params `{ path?: string, content?: string }` — đúng 1 trong 2 (cả 2/không cái nào → error). `path` nhận `.md`/`.markdown`/`.txt` → out `text:text` = nội dung raw markdown. `cacheable: false` khi dùng path, còn content thì để `cacheable: true`? — KHÔNG chẻ đôi được per-instance → để `cacheable: false` cho nhất quán.

### 1.3 Tests
- `api-upload.test.ts`: upload multipart thành công (fixture nhỏ), path trả về serve được qua /artifacts, quá size → 413, thiếu file → 400, traversal qua uploads → 400.
- `input-docs.test.ts`: input.image happy + sai ext; input.pdf trích text từ fixture PDF nhỏ (tạo fixture bằng unpdf hay chèn sẵn 1 file pdf tí hon trong test/fixtures/), maxPages + info.truncated; input.markdown path + content + lỗi khi cả hai; registry đủ 12 node.

## 2. Frontend

- `api/client.ts`: `uploadFile(file: File)` → POST /api/upload (FormData).
- **ParamsPanel**: với field `path` của 3 node mới (và `input.file` cũ) hiện thêm nút **"📤 Chọn file..."** (`<input type=file>` ẩn, accept theo node: image/* | .pdf | .md,.markdown,.txt) → upload → set `params.path` = path trả về + hiện tên file gốc; ảnh hiện thumbnail nhỏ ngay trong panel. Upload lỗi → message đỏ.
- `input.markdown`: content mode = textarea lớn; nếu user chọn file thì fill path (2 field, hint "chỉ dùng 1 trong 2").
- Sidebar tự hiện 3 node mới (data từ registry — không hardcode; xác nhận testid `palette-input.image` v.v. hoạt động).
- Web tests: params-panel upload button (mock fetch, assert FormData + params.path set), markdown 2-mode.

## 3. E2E (free tier — thêm 1 test, 0 đồng)

- Test mới trong app.spec.ts: tạo file .md tạm → upload qua UI (set input files vào file chooser của node `input.markdown`) → node `input.markdown(path)` → `text.template` → run → tab Kết quả chứa nội dung md. Pass 2 lần liên tiếp.

## 4. DoD

- Server typecheck + test xanh (183+ mới); web typecheck/build/test xanh; e2e free 2 lần xanh. KHÔNG chạy provider node thật.
- `pnpm --filter e2e exec playwright test --list` không lỗi. Agent ✨ describeForAgent chứa 12 node (assert trong test registry).
