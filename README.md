# FlowForge

Node-based AI media workflow builder — kiểu ComfyUI, nhưng mọi model chạy qua
cloud API (không chạy model local), có AI agent (OpenRouter) tự tạo/sửa
workflow từ mô tả tiếng Việt/Anh, và người dùng vẫn chỉnh tay được graph.

**Tính năng chính:**

- 🧩 **Canvas React Flow**: kéo-thả 13 node types, port màu theo kiểu dữ liệu,
  edge validation, nút 🪄 auto-layout, preview thu gọn trên node
- ✨ **AI agent**: mô tả tiếng Việt → workflow hoàn chỉnh (system prompt tự
  sinh từ NodeRegistry + model catalog, validate + tự sửa lỗi tối đa 2 retry);
  mỗi node có nút ✨ sửa bằng lệnh tự nhiên (JSON patch)
- 💰 **Cost estimate**: badge `~$` trên toolbar + breakdown từng node trước khi
  chạy; catalog 48 model (24 video / 12 ảnh / 12 LLM) phân hạng 💎 xịn /
  ✅ khá / 💸 rẻ với giá tham khảo (LLM lấy giá thật từ API OpenRouter)
- 🎬 **`video.compose`** (ffmpeg local, 0 đồng): ghép video + voiceover, loop
  video theo độ dài audio, xuất mp4 dọc 1080×1920 sẵn đăng TikTok/Reels
- 📄 **Input đa dạng**: text, upload ảnh/PDF (trích text qua unpdf)/markdown
  từ browser (max 50MB)
- 📊 **Tab Kết quả**: xem output cuối full-size, ⬇ tải từng file media,
  📋 copy text; run history đầy đủ (mọi kết quả lưu SQLite + `data/artifacts/`)
- ⚡ **Cache**: hash(node + params + inputs) — re-run không gọi lại API; force
  re-run per node hoặc toàn bộ
- 🛡️ Guard chống đốt tiền oan: model text-to-video + ảnh nối vào → chặn trước
  khi submit kèm gợi ý bản image-to-video cùng họ

## Yêu cầu

- Node.js 22+
- pnpm
- ffmpeg (cho node `video.compose`): `brew install ffmpeg`

## Setup

```bash
pnpm install
```

Tạo `.env.local` ở repo root (đã gitignored) với 5 biến — **giá trị mẫu bên
dưới là giá trị GIẢ**, thay bằng key thật của bạn:

```bash
OPENROUTER_API_KEY=sk-or-fake-0000000000000000
OPENROUTER_DEFAULT_MODEL=x-ai/grok-4.5
FAL_KEY=fake_key_id:fake_key_secret
VBEE_APP_ID=fake-app-id-0000
VBEE_TOKEN=fake-vbee-token-0000
```

Các key (trừ `OPENROUTER_DEFAULT_MODEL`) cũng nhập/sửa được sau khi chạy app
qua trang Settings (nút ⚙ trên toolbar) — lưu server-side, response chỉ trả
bản mask `••••xxxx`, không bao giờ gửi key xuống client.

## Chạy

```bash
pnpm --filter server dev    # API, mặc định :3001
pnpm --filter web dev       # UI, mở http://localhost:5173
pnpm --filter server seed   # nạp 11 workflow mẫu (kèm asset stock) vào app
```

Vào UI → nút **Workflows** → chọn 1 trong 11 samples → xem badge 💰 → **▶ Run**.
Hoặc bấm **✨ Describe** và gõ, ví dụ: *"tạo video TikTok review sản phẩm X,
giọng nữ miền Nam, có ghép voiceover"*.

## Test

```bash
pnpm -r test                 # unit: 263 server + 115 web
pnpm run e2e                 # Playwright free tier (13 test, 0 chi phí API)
pnpm run e2e:real            # 3 test gọi API thật (~$0.01–0.05/lần) — chạy chủ động
pnpm --filter server smoke   # smoke 3 provider thật (LLM + TTS + ảnh rẻ)
```

## Samples (11)

Ảnh: quote card, post bán hàng, 5-tips listicle, restyle ảnh stock (img2img).
Video: Reels hoàn chỉnh (script→voice→video→ghép), ảnh stock → video, ảnh →
video. Tài liệu: PDF → post FB, markdown brief → voiceover. Đặc biệt:
💎 **premium** (Claude Sonnet 4.5 + Veo 3, ~$3.25/run) và ⚡ **best-value**
(grok + Kling 2.5 Turbo Pro, ~$0.38/run). Asset stock kèm sẵn trong
`samples/assets/`, seed script tự copy vào `data/artifacts/uploads/`.

## Kiến trúc

Workflow là JSON thuần (schema zod, versioned) — UI (React Flow canvas +
panel JSON view) chỉ là view lên JSON đó, đồng bộ hai chiều. Server chạy
execution engine (topo sort + chạy song song, cache theo hash, `ctx.poll`
cho queue API fal/Vbee) tại `apps/server/src/engine`, expose qua Fastify
(`apps/server/src/routes`) với SSE cho trạng thái run realtime. Node đăng ký
qua NodeRegistry (`apps/server/src/nodes` — thêm node = thêm 1 file); agent
layer (`apps/server/src/agent`) sinh system prompt từ chính registry + model
catalog (`apps/server/src/catalog`). Chi tiết từng bước: `docs/SPEC-step1.md`
→ `docs/SPEC-step16.md`.

```
apps/server/src/{engine,nodes,agent,catalog,routes,db}
apps/web/src/{canvas,panels,preview,store,api}
e2e/                # Playwright (free tier + real tier gated)
samples/            # 11 workflow mẫu + assets
data/artifacts/     # media outputs + uploads (gitignored)
```

## Node types (13)

| Node | Nhóm | Ghi chú |
| --- | --- | --- |
| `llm.generate` | LLM | OpenRouter, prompt (+context) → text; model chọn từ catalog hoặc tự nhập |
| `llm.transform` | LLM | biến đổi text theo instruction |
| `fal.image` | fal.ai | model id tự do/catalog, prompt (+image) → image |
| `fal.video` | fal.ai | prompt (+image) → video; guard t2v-vs-i2v khi có ảnh |
| `vbee.tts` | Vbee | text → audio (voice_code, speed, format) |
| `video.compose` | ffmpeg | ghép ≤3 video + audio → mp4 hoàn chỉnh (local, free) |
| `input.text` | Utility | text tĩnh nhập tay |
| `input.file` | Utility | file media theo path |
| `input.image` | Utility | upload ảnh từ browser → image |
| `input.pdf` | Utility | upload PDF → trích text (unpdf, maxPages) |
| `input.markdown` | Utility | dán content hoặc upload .md/.txt → text |
| `text.template` | Utility | ghép text theo `{{slot}}` |
| `output.collect` | Utility | thu output cuối workflow |
