# SPEC — Bước 11: Sample workflows dùng node input mới (ảnh stock, PDF, markdown)

Mục tiêu: 4 workflow mẫu demo `input.image`/`input.pdf`/`input.markdown` với **asset thật kèm sẵn** — bấm Run là chạy không cần upload gì. Quy tắc chung (id/name/position/LLM/tiếng Việt/EN-prompt) kế thừa `docs/SPEC-step8.md` mục 2.

## 1. Assets — `samples/assets/`

- **2 ảnh stock** tải từ Lorem Picsum (id cố định để deterministic, ~1200px, mỗi ảnh <400KB):
  - `stock-coffee.jpg` = `https://picsum.photos/id/425/1200/800` (quán cafe/đồ ăn — hợp chủ đề F&B)
  - `stock-landscape.jpg` = `https://picsum.photos/id/1015/1200/800` (phong cảnh núi sông)
  - Nếu id không hợp chủ đề khi xem thật thì chọn id khác gần nghĩa — ghi chú lại. Tải bằng curl khi implement, COMMIT file vào repo.
- **`brief-flowforge.pdf`** — product brief 1 trang TIẾNG ANH (PDF hand-built kiểu test/fixtures, text layer thật, ~15-20 dòng: FlowForge là gì, 3 tính năng, đối tượng dùng) — nội dung EN để tránh vấn đề encoding dấu tiếng Việt trong PDF tự dựng.
- **`brief-content.md`** — brief content marketing TIẾNG VIỆT (~25 dòng markdown: thương hiệu cafe giả định "Cà Phê Nhà", giọng điệu, 3 thông điệp chính, CTA).

## 2. Bốn samples — `samples/*.json`

1. **`sample-stock-restyle`** "🎨 Biến ảnh stock thành ảnh nghệ thuật": `photo(input.image: uploads/sample-stock-coffee.jpg)` → `image(fal.image, modelId 'fal-ai/flux/dev', prompt EN cố định trong input.text node 'watercolor painting style, warm tones, artistic' — dùng node `style(input.text)` → image.prompt, photo → image.image)` → collect(image). Demo img2img.
2. **`sample-stock-motion`** "🌊 Ảnh stock chuyển động (image-to-video)": `photo(input.image: uploads/sample-stock-landscape.jpg)` + `motion(input.text: 'gentle camera pan, clouds drifting, water flowing, cinematic')` → `video(fal.video kling image-to-video, 16:9, duration 5)` → collect(video).
3. **`sample-pdf-to-post`** "📄 PDF → Post Facebook": `doc(input.pdf: uploads/sample-brief-flowforge.pdf)` → `post(llm.generate: system copywriter, đọc brief EN viết post giới thiệu TIẾNG VIỆT hook+emoji+hashtag)`; `post` → `img_prompt(llm.transform → EN illustration prompt)` → `image(fal.image landscape_16_9)`; collect(post, image).
4. **`sample-md-to-voiceover`** "📝 Markdown brief → script + voiceover": `brief(input.markdown: path uploads/sample-brief-content.md)` → `script(llm.generate: từ brief viết script quảng cáo 45-60 từ đúng giọng điệu brand)` → `voice(vbee.tts giọng nữ SG)`; collect(script, voice).

Path trong JSON: node input trỏ `uploads/sample-<tên>` (relative artifactsDir — seed script lo copy, xem mục 3).

## 3. seed-samples.ts mở rộng

- Trước khi upsert: copy mọi file `samples/assets/*` → `<artifactsDir>/uploads/sample-<filename>` (artifactsDir = `FLOWFORGE_ARTIFACTS_DIR` ?? `<repoRoot>/data/artifacts`; tạo dir nếu chưa có; ghi đè ok — idempotent).
- Vẫn validate mọi sample với registry thật; thêm check: mọi params.path dạng `uploads/…` trong sample phải tồn tại sau khi copy — thiếu → exit 1.

## 4. Tests

- `samples.test.ts` mở rộng: 9 sample files hợp lệ (5 cũ + 4 mới); các file assets tồn tại trong `samples/assets/`; PDF asset đọc được text bằng unpdf (≥50 ký tự); md asset đọc được ≥100 ký tự; mỗi sample mới có node input.* tương ứng đúng loại.
- KHÔNG chạy workflow thật (tốn tiền).

## 5. DoD

- Server typecheck + toàn suite xanh (212 + mới). `pnpm --filter server seed` chạy ok: copy assets + seed 9 workflows (orchestrator verify qua API + file tồn tại trong data/artifacts/uploads/).
- Tổng dung lượng assets commit ≤1MB.
