# FlowForge — Node-based AI Media Workflow Builder (MVP)

Ứng dụng web kiểu ComfyUI nhưng: toàn bộ model chạy qua cloud API (không chạy model local), có AI agent (OpenRouter) tự tạo/sửa workflow từ mô tả tiếng Việt/Anh, và người dùng vẫn chỉnh tay được graph.

## LUẬT ORCHESTRATION (BẮT BUỘC — áp dụng cho MỌI session trong dự án này)

1. **Fable (claude-fable-5) CHỈ làm orchestrator**: lập kế hoạch, viết spec/interface, chia task, review code, verify kết quả, chạy test, tổng hợp báo cáo. Fable **KHÔNG trực tiếp viết code implementation** (source, test, config, scaffold).
2. **Mọi việc viết code phải delegate cho subagent chạy Sonnet 5**:
   - Agent tool: `model: "sonnet"`
   - Workflow `agent()`: `opts.model: 'sonnet'`
3. Review agent chạy model mặc định (Fable) — đó là công việc orchestration/quality-control, không phải implementation.
4. **Bước verify (adversarial verification của findings) dùng Sonnet** (`model: 'sonnet'`) — user đổi từ Opus sang Sonnet 2026-07-10 (Opus hay kẹt session limit). Tóm lại: mọi subagent delegate đều là Sonnet, trừ review panel chạy model mặc định (Fable).
5. Spec, tài liệu thiết kế, CLAUDE.md, memory: Fable viết trực tiếp được (đây là artifact orchestration).

## Tech stack (bắt buộc)

- Monorepo pnpm workspaces: `apps/web` (frontend) + `apps/server` (backend)
- Frontend: Vite + React + TypeScript, React Flow (`@xyflow/react`), Zustand, TailwindCSS
- Backend: Node.js + Fastify + TypeScript (ESM, strict)
- Storage: SQLite (`better-sqlite3`) — workflows, runs, node outputs. File media lưu `./data/artifacts/`, DB chỉ lưu path + metadata
- Không auth ở MVP (local, single user)

## Nguyên tắc thiết kế (ưu tiên số 1: engine logic, không phải UI đẹp)

1. **Workflow là JSON thuần** — schema rõ ràng (zod), versioned. UI chỉ là view; có panel JSON view sửa raw JSON, graph tự cập nhật.
2. **Node = pure function có schema**: `inputs`/`outputs` (typed ports), `params` (zod), `execute(inputs, params, ctx) => outputs`. Đăng ký qua NodeRegistry — thêm node type mới = thêm 1 file.
3. **Port type system**: `text | image | video | audio | json | number | any`. Engine validate kết nối (không cho `text → video`; `any` nối được mọi thứ).
4. **Execution engine**: topological sort trên DAG, detect cycle, chạy node độc lập song song, node lỗi → fail branch đó (downstream skipped) nhưng branch khác chạy tiếp. Mỗi run lưu trạng thái từng node (`pending/running/success/error/skipped`) + output + logs vào DB.
5. **Caching**: `hash(nodeType + params + inputs)` → re-run không gọi lại API nếu không đổi gì. Có "force re-run" per node.
6. **Async polling generic**: fal.ai/Vbee dùng queue API (submit → poll → result). Engine hỗ trợ qua `ctx.poll()` với exponential backoff + timeout.

## Node types MVP

- **LLM (OpenRouter)**: `llm.generate` (model, system prompt, temperature; in: `prompt:text` + optional `context:text`; out: `text`), `llm.transform` (biến đổi text theo instruction)
- **fal.ai**: `fal.image` (model id tự do vd `fal-ai/flux/dev`, size, seed; in: `prompt:text` + optional `image`; out: `image`), `fal.video` (model id tự do, duration, aspect ratio; in: `prompt:text` + optional `image`; out: `video`). Queue API: `https://queue.fal.run/{model_id}` submit → poll → fetch → download về `./data/artifacts/`
- **Vbee TTS**: `vbee.tts` (voice_code, speed, format; in: `text:text`; out: `audio`). Async: POST → poll → download. **Chi tiết API lấy từ skill `vbee-tts` có sẵn trong session — dùng skill này thay vì đoán endpoint.**
- **ffmpeg local**: `video.compose` (ghép ≤3 video + audio, loop theo audio, mp4 1080×1920 mặc định — free, spawn ffmpeg)
- **Utility**: `input.text`, `input.file`, `input.image`, `input.pdf` (unpdf), `input.markdown`, `text.template` (ghép text theo `{{slot}}`), `output.collect`

Lưu ý chủ đích: model id của fal.ai/OpenRouter là string tự do (dropdown catalog chỉ là gợi ý — `apps/server/src/catalog/`, 48 preset phân hạng xin/kha/re kèm `estUsd` cho cost estimate; luôn giữ option "Tự nhập"). Node fal.video có guard: ảnh nối vào + model t2v trong catalog → chặn trước khi submit.

## AI Agent layer (điểm khác biệt chính)

- `POST /api/agent/generate-workflow`: mô tả tự nhiên → agent gọi OpenRouter (default lấy từ `OPENROUTER_DEFAULT_MODEL`, hiện là `x-ai/grok-4.5`, configurable) với system prompt chứa NodeRegistry schema **tự generate từ code** + JSON schema workflow + few-shot. Output validate bằng zod; invalid → gửi lỗi lại cho LLM sửa (tối đa 2 retry).
- `POST /api/agent/edit-node`: workflow + node id + instruction → trả về **JSON patch** (add/remove/update node, add/remove edge) — apply patch rồi validate.
- UI: mỗi node có nút ✨ chat edit node; toolbar có ô "Describe workflow".

## Frontend (tối giản)

Canvas React Flow (drag từ sidebar theo category, params panel bên phải), edge validation theo port type (màu port theo type), nút Run + trạng thái realtime qua SSE + preview inline (thumbnail/audio/video player), panel JSON view, danh sách workflows + lịch sử runs, Settings page nhập 3 API key (OpenRouter, fal.ai, Vbee app_id + token) — **lưu server-side, KHÔNG bao giờ gửi key xuống client**.

## Cấu trúc

```
apps/server/src/{engine,nodes,agent,catalog,routes,db}
apps/web/src/{canvas,panels,preview,store,api}
e2e/             # Playwright: free tier (mặc định, 0 đồng) + real tier (E2E_REAL=1)
samples/         # 11 workflow mẫu + assets (seed: pnpm --filter server seed)
data/artifacts/  # media outputs + uploads/ (gitignored)
docs/            # spec từng bước (orchestrator viết): SPEC-step1..16
```

## Thứ tự thực hiện & checkpoint

1. ✅ Workflow JSON schema (zod) + NodeRegistry + execution engine + unit test với mock nodes (topo sort, cycle, parallel, cache, error branch) — spec: `docs/SPEC-step1.md`
2. ✅ 3 nhóm node thật (OpenRouter, fal, Vbee) — retry + timeout + error message rõ — spec: `docs/SPEC-step2.md`
3. ✅ API routes + SSE run status — spec: `docs/SPEC-step3.md`
4. ✅ Frontend canvas + run + preview — spec: `docs/SPEC-step4.md`
5. ✅ Agent layer (generate + edit-node) — spec: `docs/SPEC-step5.md`
6. ✅ Polish: JSON view, cache indicator, settings page — spec: `docs/SPEC-step6.md`

**MVP HOÀN TẤT 2026-07-10.** Các bước bổ sung đã ship (2026-07-11, mỗi bước có spec riêng trong docs/):

7. ✅ Playwright E2E — free tier (13 test, 0 đồng) + real tier gated `E2E_REAL=1`
8. ✅ 5 sample workflows content Facebook + seed script
9. ✅ Results UX — canvas gọn, tab Kết quả (download/copy), preview toggle
10. ✅ Upload từ browser + node `input.image`/`input.pdf`/`input.markdown`
11. ✅ 4 samples dùng node input mới + stock assets kèm repo
12. ✅ Node `video.compose` (ffmpeg) — video + voiceover → mp4 hoàn chỉnh
13. ✅ Model catalog fal phân hạng 💎/✅/💸 + UI picker (giữ tự nhập)
14. ✅ Mở rộng catalog: 24 video + 12 ảnh + 12 LLM OpenRouter (giá thật từ API)
15. ✅ Cost estimate (`POST /api/estimate` + badge 💰 toolbar) + samples premium/value
16. ✅ Fix layout: node cố định 300px + nút 🪄 auto-layout theo kích thước thật
17. ✅ Guard fal.video: ảnh + model text-to-video → chặn trước khi tốn tiền

Hiện trạng: **13 node types, 48 model presets, 11 samples, 263 server + 115 web + 13 e2e tests.** Việc sau này: tính năng mới theo yêu cầu user, vẫn theo luật orchestration ở trên.

**Sau mỗi bước chạy được: dừng lại, tóm tắt, hỏi user trước khi sang bước tiếp theo.**

## API keys & config

Secrets nằm trong `.env.local` ở root (gitignored, đã có sẵn giá trị thật — KHÔNG log ra console, KHÔNG gửi xuống client, KHÔNG paste vào prompt của subagent). Server đọc các biến:

- `OPENROUTER_API_KEY`, `OPENROUTER_DEFAULT_MODEL` (hiện: `x-ai/grok-4.5`)
- `FAL_KEY` (format `key_id:key_secret`)
- `VBEE_APP_ID`, `VBEE_TOKEN`

Settings page (bước 6) ghi đè/ cập nhật các giá trị này server-side.

## Lệnh thường dùng

```bash
pnpm install                 # root
pnpm -r test                 # toàn bộ unit test (vitest)
pnpm --filter server test    # / typecheck / dev / seed / smoke
pnpm --filter web test       # / typecheck / build / dev
pnpm run e2e                 # Playwright free tier (0 đồng) — chạy từ ROOT
pnpm run e2e:real            # tier tốn phí (~$0.01-0.05) — chỉ orchestrator chạy khi nghiệm thu
```

Quy trình nghiệm thu chuẩn mỗi bước: unit suites + e2e free xanh → (nếu liên quan) smoke thật tối thiểu → commit main + push (check `.env.local`/`*.db`/artifacts không bị commit) → noti ntfy.sh/loi-thanhtt4 → restart dev server :3001 nếu server code đổi.
