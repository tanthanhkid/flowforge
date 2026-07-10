# SPEC — Bước 8: Sample workflows cho content Facebook (ảnh + video)

Mục tiêu: 5 workflow mẫu (JSON schema v1) cho các dạng post Facebook phổ biến ở VN, hợp lệ 100% với registry thật, seed được vào app để hiện trong WorkflowList. Content tiếng Việt; prompt sinh ảnh/video bằng tiếng Anh (model ảnh hiểu EN tốt hơn) — dùng `llm.transform` để chuyển ý sang EN prompt thay vì hardcode prompt EN dài.

## 1. Files

```
samples/sample-quote-card.json
samples/sample-product-post.json
samples/sample-tips-listicle.json
samples/sample-reels-voiceover.json
samples/sample-image-to-video.json
apps/server/scripts/seed-samples.ts     # validate + upsert vào DB (script "seed" trong apps/server package.json)
apps/server/test/samples.test.ts        # mọi file samples/*.json pass WorkflowSchema + validateWorkflow với createDefaultRegistry()
```

## 2. Quy tắc chung cho mọi sample

- `version: 1`, `id` = tên file không đuôi (vd `sample-quote-card`), `name` tiếng Việt mô tả rõ (vd "📸 Ảnh quote động lực (FB post)").
- Node id ngắn gọn có nghĩa (`topic`, `caption`, `img_prompt`, `image`, `voice`, `video`, `result`...). Mọi node có `position` layout trái→phải theo depth (x = depth*300, y cách 170), không chồng nhau.
- `input.text` đầu vào có `value` mẫu sẵn (chạy được ngay không cần sửa).
- Mọi workflow kết thúc bằng `output.collect` gom đủ text + media.
- LLM: `model: ""` (dùng default), `temperature` hợp ngữ cảnh (copywriting 0.8-0.9, transform prompt 0.4), `system` bằng tiếng Việt định vai "copywriter Facebook chuyên nghiệp" và LUÔN yêu cầu chỉ trả kết quả không giải thích. Caption phải có hook + emoji + 3-5 hashtag.
- Ảnh: `fal.image` modelId `fal-ai/flux/dev`; post vuông dùng `imageSize: "square_hd"`, cover/landscape `"landscape_16_9"`.
- Video: text-to-video dùng modelId `fal-ai/ltx-video` (rẻ); image-to-video dùng `fal-ai/kling-video/v2/master/image-to-video`; reels dọc `aspectRatio: "9:16"`.
- TTS: `vbee.tts` voiceCode `sg_female_thaotrinh_full_48k-fhg`, speed 1.0, mp3.

## 3. Năm samples

1. **quote-card** — Ảnh quote động lực: `topic(input.text: "thành công và kỷ luật bản thân")` → `quote(llm.generate: viết 1 câu quote ≤20 từ + caption FB kèm hashtag, xuống dòng phân cách)`; `quote.text` → `img_prompt(llm.transform: "Từ quote này viết 1 image prompt tiếng Anh ≤40 từ tả ảnh nền phong cách minimal, ánh sáng đẹp, KHÔNG chứa chữ trong ảnh")` → `image(fal.image square_hd)`; collect(quote.text → in1, image → in2).
2. **product-post** — Post bán hàng: `product(input.text: mô tả ngắn 1 sản phẩm mẫu, vd bình giữ nhiệt)` → `caption(llm.generate: caption bán hàng AIDA + CTA + hashtag)`; `product` → `img_prompt(llm.transform → English product photography prompt, studio light)` → `image(fal.image square_hd)`; collect(caption, image).
3. **tips-listicle** — Post 5 tips: `topic(input.text)` → `tips(llm.generate: đúng 5 tips, mỗi tip 1 dòng bắt đầu "✔")` → `post(text.template: template "🔥 5 mẹo {{a}} mà 90% mọi người bỏ qua:\n\n{{b}}\n\n👉 Lưu lại kẻo quên! #tips #meohay", a=topic, b=tips)`; `topic` → `img_prompt(llm.transform → EN illustration prompt)` → `image(fal.image landscape_16_9)`; collect(post, image).
4. **reels-voiceover** — Video Reels có thuyết minh: `topic(input.text)` → `script(llm.generate: script video 60-80 từ, giọng kể gần gũi, câu ngắn)` → `voice(vbee.tts)`; `script` → `vid_prompt(llm.transform → EN cinematic b-roll prompt ≤40 từ)` → `video(fal.video ltx-video, aspectRatio "9:16", duration 5)`; collect(script, voice, video).
5. **image-to-video** — Ảnh → video động: `scene(input.text: mô tả cảnh EN sẵn, vd "cozy Vietnamese coffee shop at sunrise, steam rising from cup")` → `image(fal.image landscape_16_9)` → `video(fal.video kling image-to-video: prompt = scene, image input từ image node, duration 5, aspectRatio "16:9")`; collect(image, video).

Kiểm tra kỹ tên port thật của từng node (đọc `apps/server/src/nodes/*.ts`) — vd `text.template` inputs `a..d`, `fal.video` inputs `prompt` + `image`, `output.collect` inputs `in1..in4`.

## 4. seed-samples.ts

- Đọc mọi `samples/*.json` (repo root), validate bằng `validateWorkflow` + `createDefaultRegistry()` — fail → exit 1 in lỗi rõ.
- Upsert vào DB qua `WorkflowsRepo` (DB path: `FLOWFORGE_DB_PATH` ?? `<repoRoot>/data/flowforge.db`), giữ id — chạy nhiều lần idempotent.
- In danh sách đã seed. KHÔNG gọi API ngoài, KHÔNG cần server chạy.
- apps/server package.json: `"seed": "tsx scripts/seed-samples.ts"`.

## 5. DoD

- `samples.test.ts` pass (5 sample hợp lệ) trong suite server; mọi test cũ xanh; typecheck sạch.
- `pnpm --filter server seed` chạy ok, GET /api/workflows thấy đủ 5 (orchestrator verify).
- KHÔNG chạy workflow thật (tốn tiền) — orchestrator quyết định chạy sample nào khi nghiệm thu.
