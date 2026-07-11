# SPEC — Bước 12: Node `video.compose` (ffmpeg) — ghép video + voiceover thành video hoàn chỉnh

Vấn đề user: chạy sample reels ra video câm 5s + audio 26s rời nhau, "không ra gì". Fix: node ghép local bằng ffmpeg (máy có sẵn `/opt/homebrew/bin/ffmpeg` v8, PATH resolve bình thường) — không tốn API. Registry 12 → 13.

## 1. Node `video.compose` (category `video`, 1 file `apps/server/src/nodes/video.compose.ts`)

- **Inputs**: `video: video` (required), `video2: video` (optional), `video3: video` (optional — nối tiếp theo thứ tự), `audio: audio` (optional).
- **Params** (zod):
  - `width: int > 0 default 1080`, `height: int > 0 default 1920` (TikTok dọc mặc định)
  - `fit: 'cover' | 'contain' default 'cover'` — cover: scale + center-crop đầy khung; contain: scale vừa + pad đen
  - `loopVideo: boolean default true` — khi có audio dài hơn video: loop video cho tới hết audio; false → video giữ độ dài gốc, audio bị cắt theo (-shortest)
  - `fps: int default 30`
- **Outputs**: `video: video` (mp4 h264 + aac, `ctx.saveArtifact`).
- **Hành vi** (spawn `ffmpeg` qua `node:child_process`, KHÔNG thêm npm dep):
  1. Resolve path các MediaValue (relative → artifactsDir; url-only chưa có path → error rõ "cần file local").
  2. Nhiều video → normalize từng cái (scale/crop theo fit, fps, WxH — filter `scale` + `crop` hoặc `pad`) rồi `concat` (re-encode, an toàn khác codec/size).
  3. Có audio: nếu `loopVideo` → `-stream_loop -1` trên (chuỗi) video + `-shortest` theo audio; không loop → `-shortest`. Audio map từ file audio, bỏ audio gốc của video. Không audio → chỉ normalize/concat.
  4. Timeout 120s; ffmpeg exit ≠ 0 → error kèm 300 ký tự cuối stderr. ffmpeg không có trong PATH → error "Cần cài ffmpeg (brew install ffmpeg)".
  5. `ctx.log` command đã chạy (che path tuyệt đối dài → basename).
- `cacheable: true` (artifact path là uuid bất biến — cache key ổn định).

## 2. Cập nhật sample

- **`sample-reels-voiceover`**: thêm node `final(video.compose)`: video → final.video, voice → final.audio, params mặc định (1080×1920, cover, loop); đổi `fal.video` modelId → `fal-ai/kling-video/v1.6/standard/text-to-video` (chất lượng khá hơn ltx, nhận 9:16 tử tế); collect đổi thành (script → in1, final.video → in2). Tên đổi: "🎬 Video Reels hoàn chỉnh (script + voice + ghép)".
- **`sample-md-to-voiceover`** giữ nguyên (không video).
- Seed lại được (idempotent).

## 3. Tests (`apps/server/test/video-compose.test.ts` — dùng ffmpeg thật, local, free)

- Helper beforeAll: tự sinh fixture bằng ffmpeg vào tmp dir: clip màu 2s 320×240 (`-f lavfi color=red`), clip xanh 1s, audio sine 5s (`-f lavfi sine`).
- Test qua `node.execute` với ctx thật (artifactsDir tmp):
  1. video 2s + audio 5s, loopVideo=true → output tồn tại, ffprobe duration ≈5s (±0.5), kích thước đúng 1080×1920 (hoặc param nhỏ hơn 320×568 cho nhanh), có cả stream video + audio.
  2. loopVideo=false → duration ≈2s.
  3. concat video+video2 (2s+1s, không audio) → duration ≈3s, 1 stream video.
  4. fit contain vs cover → đúng WxH cả hai.
  5. Thiếu file video → error rõ; (skip toàn file nếu `ffmpeg` không có trong PATH — describe.skipIf).
- samples.test.ts: cập nhật structure check cho sample-reels-voiceover (có node video.compose); registry test 12→13.
- KHÔNG chạy fal/vbee thật.

## 4. DoD

- Server typecheck + toàn suite xanh (219 + mới). Web/e2e không đổi (node mới tự hiện sidebar; e2e free 12 test vẫn xanh — chạy xác nhận 1 lần).
- Orchestrator nghiệm thu THẬT: chạy lại sample-reels-voiceover (tốn ~chục cent Kling) → output cuối là 1 file mp4 dọc CÓ TIẾNG dài bằng voiceover.
