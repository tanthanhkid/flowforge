# FlowForge

Node-based AI media workflow builder — kiểu ComfyUI, nhưng mọi model chạy qua
cloud API (không chạy model local), có AI agent (OpenRouter) tự tạo/sửa
workflow từ mô tả tiếng Việt/Anh, và người dùng vẫn chỉnh tay được graph.

![screenshot placeholder](docs/screenshot-placeholder.png)

## Yêu cầu

- Node.js 22+
- pnpm

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

Ba key đầu (trừ `OPENROUTER_DEFAULT_MODEL`) cũng có thể được nhập/sửa sau khi
chạy app, qua trang Settings (nút ⚙ trên toolbar) — lưu server-side, không
bao giờ gửi xuống client.

## Chạy

```bash
pnpm --filter server dev   # API, mặc định :3001
pnpm --filter web dev      # UI, mở http://localhost:5173
```

## Test

```bash
pnpm -r test                # toàn bộ (server + web)
pnpm --filter server test
pnpm --filter web test
```

## Kiến trúc

Workflow là JSON thuần (schema zod, versioned) — UI (React Flow canvas +
panel JSON view) chỉ là một view lên trên JSON đó, đồng bộ hai chiều. Server
chạy execution engine (topo sort, cache theo hash, poll queue API) trên
`apps/server/src/engine`, expose qua Fastify (`apps/server/src/routes`) với
SSE cho trạng thái run realtime. Chi tiết từng bước xây dựng: xem
`docs/SPEC-step1.md` → `docs/SPEC-step6.md`.

## Node types (9)

| Node | Nhóm | Ghi chú |
| --- | --- | --- |
| `llm.generate` | LLM | OpenRouter, prompt (+context) → text |
| `llm.transform` | LLM | biến đổi text theo instruction |
| `fal.image` | fal.ai | model id tự do, prompt (+image) → image |
| `fal.video` | fal.ai | model id tự do, prompt (+image) → video |
| `vbee.tts` | Vbee | text → audio (voice_code, speed, format) |
| `input.text` | Utility | text tĩnh nhập tay |
| `input.file` | Utility | file media nhập tay |
| `text.template` | Utility | ghép text theo `{{slot}}` |
| `output.collect` | Utility | thu output cuối workflow |
