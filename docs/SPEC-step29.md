# SPEC step 29 — Guard i2i cho `fal.image` + dạy agent chọn model theo dữ liệu vào

Nguồn gốc: session thật 2026-07-13 (conversation "tôi đưa ảnh cho bạn để bạn xoá…") — AI chọn `fal-ai/flux/dev` (text-to-image) cho 4 node có ảnh nối vào, run "success" nhưng vứt ảnh gốc, user tốn 1 run vô nghĩa. `fal.video` đã có guard t2v/i2v từ step 17; `fal.image` chưa có, và catalog không phân biệt t2i/i2i. Bước này chặn ở CẢ 2 tầng: runtime guard (lưới cuối) + system prompt (ngăn từ gốc).

## §1 Phạm vi file

- `apps/server/src/catalog/falModels.ts`: field mới `imageKind?: 't2i' | 'i2i'` + annotate 12 preset image.
- `apps/server/src/catalog/live/fetchFal.ts` (+ `merge.ts`, types liên quan): mapping category giữ thông tin t2i/i2i.
- `apps/server/src/nodes/fal.image.ts`: guard mirror `fal.video`.
- `apps/server/src/agent/promptBuilder.ts`: luật chọn model theo input + tag [i2i]/[t2i] trong catalog gợi ý.
- `apps/web/src/api/types.ts`: field optional tương ứng (KHÔNG UI mới — badge picker là backlog).
- Tests server + cập nhật test prompt (thêm assertion, không phá cũ).

## §2 Catalog — phân loại image t2i/i2i

- `FalModel` thêm `imageKind?: 't2i' | 'i2i'` (optional, additive — KHÔNG đổi `kind` để không phá tier bucket/merge/picker hiện có).
- 12 preset image trong `falModels.ts`: annotate tay theo bản chất model (họ FLUX dev/pro/schnell text-to-image → `t2i`; kontext/img2img/editing → `i2i`; model nào không chắc → BỎ TRỐNG, guard sẽ bỏ qua). Ghi comment nguồn phân loại.
- `fetchFal.ts`: TRƯỚC KHI code, xem giá trị `category` thật trong payload đã cache (bảng `catalog_cache`, provider fal) để biết đủ các category image (`text-to-image`, `image-to-image`, có thể `image-editing`…). Mở rộng mapping: category t2i → `{ kind: 'image', imageKind: 't2i' }`, category i2i/editing → `{ kind: 'image', imageKind: 'i2i' }`; category không nhận diện được vẫn drop như cũ.
- `merge.ts` + `UnifiedCatalog` types (server + web): truyền `imageKind` xuyên suốt (optional).

## §3 Guard trong `fal.image.ts` (mirror `fal.video.ts`)

- Snapshot live: thêm setter kiểu `setLiveImageCatalog(entries)` — đăng ký tại cùng chỗ `setLiveVideoCatalog` đang được gọi (tìm caller trong catalog live/refresh).
- `findImageKind(modelId)`: preset tĩnh trước, live sau; `undefined` = không biết.
- Trong `execute`, khi `inputs.image` có giá trị: nếu `findImageKind(params.modelId) === 't2i'` → **throw TRƯỚC khi gọi fal** (không đốt credit):
  `Model "<id>" là text-to-image nên sẽ bỏ qua ảnh đầu vào. Chọn model image-to-image (vd <gợi ý>) hoặc ngắt kết nối ảnh.`
  Gợi ý: KHÔNG dùng heuristic same-prefix của video (họ image không đặt tên theo cặp) — liệt kê tối đa 2 model `imageKind === 'i2i'`: ưu tiên preset ⭐/tier cao, fallback live. Không có → bỏ phần gợi ý.
- `imageKind` undefined (model tự nhập/không rõ) hoặc i2i → hành vi như hiện tại. t2i KHÔNG có ảnh nối → chạy bình thường.

## §4 Prompt priming (`promptBuilder.ts`)

- Thêm khối luật (dùng chung cho generate + chat; edit-node cũng hưởng nếu dùng chung section):
  **"QUY TẮC CHỌN MODEL THEO DỮ LIỆU VÀO"**: nếu node `fal.image` có edge ảnh nối vào port `image` → BẮT BUỘC chọn model đánh dấu `[i2i]`; tương tự `fal.video` có ảnh → model image-to-video; model `[t2i]` sẽ bỏ qua ảnh đầu vào. Kèm 1 ví dụ ngắn 2 dòng (sai → đúng).
- Danh sách model image trong catalog section của prompt: thêm tag `[i2i]`/`[t2i]` cạnh model có `imageKind` (không tag nếu thiếu).
- Đây là thay đổi CÓ CHỦ ĐÍCH output của các builder (khác ràng buộc byte-identical của step 21/25 — ràng buộc đó chỉ áp cho các refactor thuần): test `agent-prompt.test.ts` cũ dùng `toContain` nên vẫn xanh; THÊM assertion mới cho luật + tag.

## §5 Tests

1. `fal.image` guard: t2i + ảnh → throw đúng message + có gợi ý i2i; i2i + ảnh → chạy (mock queue); model lạ + ảnh → chạy; t2i không ảnh → chạy; live-only model (không preset) t2i + ảnh → throw (qua snapshot setter).
2. `fetchFal`: category t2i/i2i map đúng `imageKind`, category lạ vẫn drop; `merge` giữ `imageKind`.
3. Prompt: chứa khối quy tắc + tag `[i2i]`/`[t2i]`; assertions cũ nguyên trạng.
4. Regression đúng ca thật: workflow giống session user (input.image → 4 × fal.image flux/dev) → cả 4 node fail với message guard (test qua engine mock provider hoặc unit trực tiếp execute).

## §6 Nghiệm thu

`pnpm -r test` + typecheck ×3 + `pnpm run e2e` xanh (guard chỉ chạy lúc execute fal thật nên e2e free không ảnh hưởng); không dependency mới; backlog ghi nhận (KHÔNG làm ở bước này): badge i2i/t2i trong ModelPicker UI.

## §7 Fix sau review — sample bị guard mới chặn (phát hiện review)

Review phát hiện guard mới (§3) làm `samples/sample-stock-restyle.json` (demo img2img có sẵn từ SPEC-step11.md §1) fail khi chạy thật: node `image` (`fal.image`) nối ảnh `photo` vào port `image` nhưng dùng `modelId: "fal-ai/flux/dev"` — preset này vừa được annotate `imageKind: 't2i'` ở §2, nên guard throw trước khi gọi fal.

Fix: đổi `modelId` của node `image` trong `sample-stock-restyle.json` sang `fal-ai/flux-pro/kontext` (model image-editing thật của fal.ai — nhận `image_url` + `prompt` và trả ảnh đã chỉnh theo phong cách yêu cầu, đúng bản chất img2img/restyle của sample này, kể cả trước khi có guard model `flux/dev` đã sai bản chất). Model này không nằm trong 12 preset tĩnh của §2 (phạm vi §2 không mở rộng) nên `findImageKind()` trả về `undefined` ("không rõ") — guard không chặn, giữ đúng hành vi "model tự nhập/không rõ → chạy như cũ" đã định nghĩa ở §3.

Regression test mới trong `apps/server/test/samples.test.ts`: quét mọi `samples/*.json`, với mọi edge nối vào port `image` của node `fal.image`/`fal.video`, tra `modelId` đích trong `FAL_IMAGE_MODELS`/`FAL_VIDEO_MODELS` — nếu preset tĩnh khớp và bị đánh dấu `t2i`/`video-t2v` thì fail test. Test này không gọi mạng (chỉ tra cứu preset tĩnh), chạy trong `pnpm -r test` bình thường, và sẽ tự động bắt lại đúng lớp lỗi này (sample dùng model t2i khi có ảnh nối vào) cho cả 11 sample hiện tại lẫn sample mới thêm sau này hoặc khi annotate thêm preset mới ở §2.
