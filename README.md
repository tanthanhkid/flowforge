# FlowForge

Node-based AI media workflow builder — kiểu ComfyUI, nhưng mọi model chạy qua
cloud API (không chạy model local), và từ 2026-07-13 là ứng dụng **AI-native
"Copilot Song Song"**: trang chủ là khung chat, AI dựng/sửa workflow liên tục
ngay trong lúc trò chuyện (node "vật chất hoá" dần trên canvas qua SSE),
chat + canvas luôn cùng khung nhìn, và mọi thay đổi chỉnh tay đều được log
để AI nắm được ở lượt sau. Thiết kế đầy đủ: `docs/DESIGN-ai-native.md`.

**Tính năng chính:**

- 💬 **Chat-first**: mở app là landing hero — gõ mô tả tiếng Việt/Anh, Enter
  là có ngay conversation + workflow; AI trả lời bằng cách stream từng
  patch-op (`thinking → patch-op × N → message → done`), node/cạnh hiện dần
  trên canvas kèm animation; nút ■ Dừng hủy lượt giữa chừng
- 🪟 **Chat | Chia đôi | Canvas**: toggle 3 chế độ trên toolbar (hoặc ⌘\ /
  Ctrl+\), kéo divider chỉnh tỉ lệ tự do (lưu localStorage); canvas luôn
  mounted nên không mất trạng thái khi đổi chế độ
- 📜 **Change log 2 chiều**: mọi thao tác tay trên canvas (thêm/xoá node,
  sửa param, nối cạnh, kéo vị trí) tự động thành PatchOp persist lên server —
  lượt chat sau AI đọc được qua "change digest" (`[tay]`/`[AI]`); tab
  **Lịch sử** xem toàn bộ (🤖/✋) + nút **↺ Khôi phục** về trước một thay đổi
- 🧩 **Canvas React Flow**: kéo-thả 13 node types, port màu theo kiểu dữ liệu,
  edge validation, 🪄 auto-layout, preview thu gọn trên node; mỗi node có nút
  ✨ sửa nhanh bằng lệnh tự nhiên
- 💰 **Cost estimate + catalog động**: badge `~$` breakdown từng node trước
  khi chạy; catalog ~1.240 model lấy trực tiếp từ API fal.ai + OpenRouter
  (giá thật, tier 💎/✅/💸/❓ theo ngưỡng giá, cache SQLite 24h), 48 preset ⭐
  featured, luôn giữ option "Tự nhập"
- 🎬 **`video.compose`** (ffmpeg local, 0 đồng): ghép video + voiceover, loop
  video theo độ dài audio, xuất mp4 dọc 1080×1920 sẵn đăng TikTok/Reels
- 📄 **Input đa dạng**: text, upload ảnh/PDF (trích text qua unpdf)/markdown
  từ browser (max 50MB)
- 📊 **Tab Kết quả**: xem output full-size, ⬇ tải media, 📋 copy text; run
  history đầy đủ (SQLite + `data/artifacts/`)
- ⚡ **Cache**: hash(node + params + inputs) — re-run không gọi lại API;
  force re-run per node hoặc toàn bộ
- 🤖 **AI thấy kết quả run**: tóm tắt run gần nhất (trạng thái từng node,
  cache, model, lỗi) được đưa vào context mỗi lượt chat — hỏi "vì sao node
  lỗi?" là AI trả lời đúng chi tiết run của workflow đang mở
- 🛡️ Guard chống đốt tiền oan (cả video lẫn ảnh): model text-to-video/
  text-to-image mà có ảnh nối vào → chặn trước khi submit kèm gợi ý model
  image-to-video / image-to-image cùng họ; agent cũng được dạy quy tắc chọn
  model theo dữ liệu vào (tag `[i2i]`/`[t2i]` trong catalog)

## Yêu cầu

- Node.js 22+
- pnpm
- ffmpeg (cho node `video.compose`): `brew install ffmpeg`

## Setup

```bash
pnpm install
```

Tạo `.env.local` ở repo root (đã gitignored) — **giá trị mẫu bên dưới là giá
trị GIẢ**, thay bằng key thật của bạn:

```bash
OPENROUTER_API_KEY=sk-or-fake-0000000000000000
OPENROUTER_DEFAULT_MODEL=x-ai/grok-4.5
FAL_KEY=fake_key_id:fake_key_secret
VBEE_APP_ID=fake-app-id-0000
VBEE_TOKEN=fake-vbee-token-0000
```

Các key (trừ `OPENROUTER_DEFAULT_MODEL`) cũng nhập/sửa được sau khi chạy app
qua trang Settings (nút ⚙ trên toolbar) — lưu server-side, response chỉ trả
bản mask `••••xxxx`, không bao giờ gửi key xuống client. (Biến
`OPENROUTER_BASE_URL` chỉ dành cho e2e mock nội bộ, không cần set.)

## Chạy

```bash
pnpm --filter server dev    # API, mặc định :3001
pnpm --filter web dev       # UI, mở http://localhost:5173
pnpm --filter server seed   # nạp 11 workflow mẫu (kèm asset stock) — mỗi sample tự có conversation
```

## Dùng thử

Mở UI → gõ vào ô chat, ví dụ *"tạo video TikTok review sản phẩm X, giọng nữ
miền Nam, có ghép voiceover"* → xem AI dựng node dần trên canvas → chỉnh tay
node nào tuỳ ý (AI sẽ biết) → xem badge 💰 → **▶ Run**. Các workflow mẫu nằm
sẵn trong rail trái (mỗi cái là một cuộc trò chuyện — mở ra chat tiếp để AI
sửa). Tab **Lịch sử** (panel phải) xem ai đổi gì, bấm ↺ để khôi phục.

## Test

```bash
pnpm -r test                 # unit: 441 server + 20 shared + 320 web
pnpm run e2e                 # Playwright free tier: 27 test, 0 chi phí API
                             #   (5 test luồng chat chạy qua mock OpenRouter nội bộ)
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

Workflow là JSON thuần (schema zod, versioned — cột `workflows.version` cho
optimistic concurrency giữa AI và tay). Server chạy execution engine (topo
sort + chạy song song, cache theo hash, `ctx.poll` cho queue API fal/Vbee)
tại `apps/server/src/engine`, expose qua Fastify với SSE cho cả trạng thái
run lẫn turn chat. Vòng lặp AI nằm ở `apps/server/src/agent`: `chatTurn.ts`
(1 lượt chat = build prompt từ registry + workflow + change digest → LLM trả
`{reply, ops}` → applyPatch + validate, retry 3 lần, version-conflict thì
rebuild prompt 1 lần) + `changeDigest.ts` (nén change log vào context).
3 bảng SQLite mới: `conversations` (1-1 workflow), `messages`,
`workflow_changes` (kèm `snapshot_after` cho revert). Domain PatchOp
(`applyPatch`, `PatchOpSchema`) nằm ở `packages/shared`, dùng chung
server/web (web apply optimistic từng op để animate). Node đăng ký qua
NodeRegistry (`apps/server/src/nodes` — thêm node = thêm 1 file). Chi tiết:
`docs/DESIGN-ai-native.md` + `docs/SPEC-step1.md` → `docs/SPEC-step30.md`.

```
apps/server/src/{engine,nodes,agent,catalog,routes,db}
apps/web/src/{api,canvas,panels,preview,store,ui}
packages/shared/    # domain PatchOp dùng chung FE/BE (export TS source, không cần build)
e2e/                # Playwright free tier (mock OpenRouter) + real tier gated
samples/            # 11 workflow mẫu + assets
data/artifacts/     # media outputs + uploads (gitignored)
docs/               # DESIGN-ai-native.md + SPEC-step1..30
```

## Node types (13)

| Node | Nhóm | Ghi chú |
| --- | --- | --- |
| `llm.generate` | LLM | OpenRouter, prompt (+context) → text; model chọn từ catalog hoặc tự nhập |
| `llm.transform` | LLM | biến đổi text theo instruction |
| `fal.image` | fal.ai | model id tự do/catalog, prompt (+image) → image; guard t2i-vs-i2i khi có ảnh |
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
