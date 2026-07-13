# FlowForge — Node-based AI Media Workflow Builder (MVP)

Ứng dụng web kiểu ComfyUI nhưng: toàn bộ model chạy qua cloud API (không chạy model local), có AI agent (OpenRouter) tự tạo/sửa workflow từ mô tả tiếng Việt/Anh, và người dùng vẫn chỉnh tay được graph. Từ 2026-07-13 là app **AI-native "Copilot Song Song"**: trang chủ là chat, AI edit workflow liên tục qua SSE (node vật chất hoá dần trên canvas), chat + canvas luôn cùng khung nhìn, mọi thay đổi tay được log để AI nắm — thiết kế đầy đủ: `docs/DESIGN-ai-native.md`.

## LUẬT ORCHESTRATION (BẮT BUỘC — áp dụng cho MỌI session trong dự án này)

1. **Fable (claude-fable-5) CHỈ làm orchestrator**: lập kế hoạch, viết spec/interface, chia task, review code, verify kết quả, chạy test, tổng hợp báo cáo. Fable **KHÔNG trực tiếp viết code implementation** (source, test, config, scaffold).
2. **Mọi việc viết code phải delegate cho subagent chạy Sonnet 5**:
   - Agent tool: `model: "sonnet"`
   - Workflow `agent()`: `opts.model: 'sonnet'`
3. **Review agent chạy Opus** (`model: 'opus'`) — user đổi từ Fable (model mặc định) sang Opus 2026-07-12.
4. **Bước verify (adversarial verification của findings) dùng Sonnet** (`model: 'sonnet'`) — user đổi từ Opus sang Sonnet 2026-07-10 (Opus hay kẹt session limit). Tóm lại: mọi subagent delegate đều là Sonnet, trừ review panel chạy Opus.
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

Lưu ý chủ đích: model id của fal.ai/OpenRouter là string tự do (dropdown catalog chỉ là gợi ý — `apps/server/src/catalog/`, 48 preset phân hạng xịn/khá/rẻ kèm `estUsd` cho cost estimate; luôn giữ option "Tự nhập"). Node fal.video có guard: ảnh nối vào + model t2v trong catalog → chặn trước khi submit.

## AI Agent layer (điểm khác biệt chính)

- `POST /api/agent/generate-workflow`: mô tả tự nhiên → agent gọi OpenRouter (default lấy từ `OPENROUTER_DEFAULT_MODEL`, hiện là `x-ai/grok-4.5`, configurable) với system prompt chứa NodeRegistry schema **tự generate từ code** + JSON schema workflow + few-shot. Output validate bằng zod; invalid → gửi lỗi lại cho LLM sửa (tối đa 2 retry).
- `POST /api/agent/edit-node`: workflow + node id + instruction → trả về **JSON patch** (add/remove/update node, add/remove edge) — apply patch rồi validate.
- UI: **chat pane là kênh AI chính** — mỗi conversation 1-1 workflow, `POST /api/conversations/:id/messages` + SSE turn events (`thinking/patch-op/message/error/done`), digest change log nén thay đổi tay vào context AI (`agent/chatTurn.ts` + `changeDigest.ts`). Mỗi node vẫn có nút ✨ edit node; ô "Describe workflow" trên toolbar đã gỡ ở bước 24 (chat thay thế).

## Frontend (tối giản)

Layout AI-native: `ConversationRail | ChatPane | SplitDivider | CanvasPane` — Mode Toggle `Chat|Chia đôi|Canvas` (+ ⌘\, splitRatio persist localStorage), canvas LUÔN mounted (React Flow instance sống qua mọi mode). CanvasPane = Sidebar node palette + React Flow (edge validation theo port type, màu port theo type) + panel phải 4 tab `Params/Runs/Kết quả/Lịch sử`. Nút Run + trạng thái realtime qua SSE + preview inline, JSON view. Mọi thao tác tay trên canvas auto-log thành PatchOp (`store/manualLog.ts` — queue + debounce + 409 rebase) để AI nắm; AI sửa tới đâu node/edge vật chất hoá tới đó (`ff-node-pop`/`ff-edge-draw`). Settings page nhập 3 API key (OpenRouter, fal.ai, Vbee app_id + token) — **lưu server-side, KHÔNG bao giờ gửi key xuống client**.

## Cấu trúc

```
apps/server/src/{engine,nodes,agent,catalog,routes,db}
apps/web/src/{api,canvas,panels,preview,store,ui}
packages/shared/  # domain PatchOp (applyPatch, PatchOpSchema...) dùng chung FE/BE — export TS source trực tiếp
e2e/             # Playwright: free tier (mặc định, 0 đồng) + real tier (E2E_REAL=1)
samples/         # 11 workflow mẫu + assets (seed: pnpm --filter server seed)
data/artifacts/  # media outputs + uploads/ (gitignored)
docs/            # spec từng bước (orchestrator viết): SPEC-step1..30 + DESIGN-ai-native.md (PHẦN 0 = sai lệch ship-vs-design + nợ đã biết)
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
18. ✅ Redesign toàn bộ web "Thô Mộc Nổi Loạn" (neo-brutalist, user chọn từ 4 đề xuất) — design tokens @theme, `ui/` primitives, font Archivo subset tiếng Việt self-host, + 8 fix UX (onboarding canvas trống, minimap hiện node — root cause React Flow v12 cần `initialWidth/Height` trên user-node, fit-view sau Sắp xếp, popover portal thoát overflow, bug tab Kết quả, panOnScroll 2 ngón touchpad…) — spec: `docs/SPEC-step18.md`
19. ✅ Catalog model ĐỘNG từ API fal.ai (~1.400 model, 35 trang keyless) + OpenRouter (345) — parser giá từ chuỗi markdown fal, tier THEO GIÁ (💎/✅/💸/❓ ngưỡng trong `catalog/live/`), cache SQLite 24h + stale-while-revalidate, `CATALOG_LIVE=0` cho test/e2e (không network), 48 preset cũ thành ⭐ featured, picker combobox search + badge MỚI + ARIA/keyboard + luôn giữ "Tự nhập" — spec: `docs/SPEC-step19.md`

**Redesign AI-native "Copilot Song Song"** (2026-07-12, user chọn từ 2 đề xuất qua judge panel — thiết kế đầy đủ: `docs/DESIGN-ai-native.md`, Phần I authoritative): chat pane + canvas luôn cùng màn hình, AI stream từng patch-op qua SSE, mọi thay đổi (AI + tay) là PatchOp ghi vào change log. Lộ trình 9 bước = steps 20–28:

20. ✅ Nền dữ liệu: 3 bảng mới (`conversations` 1-1 workflow, `messages`, `workflow_changes` kèm `snapshot_after` cho revert), cột `workflows.version` + `ensureColumn` migration, 3 repo mới + `saveVersioned`/`VersionConflictError` (optimistic concurrency), backfill idempotent cho workflow mồ côi (server startup + seed) — spec: `docs/SPEC-step20.md`
21. ✅ Vòng lặp AI: `agent/chatTurn.ts` (runChatTurn — retry 3 attempt, optimistic concurrency rebuild-1-lần-rồi-fail-safe, AbortSignal xuyên suốt, events cho SSE) + `changeDigest.ts` (dedupe (nodeId,paramKey), cap 40 dòng/6000 ký tự, prefix [tay]/[AI]) + op `move-node` (scope cosmetic) + `buildChatSystemPrompt` (2 builder cũ giữ nguyên output byte-identical) + `emptyWorkflow()` — spec: `docs/SPEC-step21.md`
22. ✅ Tầng HTTP: `chatTurnManager.ts` (buffer/replay/pacing patch-op, stop, LRU 200, TurnInProgressError→409) + routes `conversations.ts` (8 endpoint, SSE turn events + fallback DB, title auto từ tin đầu) + `changes.ts` (GET/POST log tay shape-validate + 409 version-conflict, revert theo snapshot ghi change mới) + digest hiện dòng revert — spec: `docs/SPEC-step22.md`
23. ✅ ConversationRail (w-64, search, ⚠ badge, collapse) + ChatPane (bubbles, composer Enter/Shift+Enter, ■ Dừng, empty states + chip gợi ý) thay modal WorkflowList; api client + `store/chat.ts` (SSE turn events, guard isDisplayed chống race đổi conversation); `adoptWorkflow` refactor; fix latent bug Content-Type DELETE; e2e viewport 1920 + 3 test rail — spec: `docs/SPEC-step23.md`
24. ✅ Split-pane thật: `splitRatio` (persist localStorage, snap min-width 320/420, animate 300ms) + ModeToggle Chat|Chia đôi|Canvas (badge đỏ khi turn chạy mà chat ẩn) + SplitDivider (drag + double-click) + CanvasPane luôn mounted (visibility hidden, fitView ×2 khi hiện lại) + landing hero chat-first (gõ là tự tạo conversation) + gỡ ✨ Describe (giữ ✨ edit-node) + phím tắt ⌘\ — spec: `docs/SPEC-step24.md`
25. ✅ `packages/shared` — tách `applyPatch` + `PatchOpSchema` + `PatchError` + `opScope`/`changeScope` dùng chung FE/BE (đôn lên trước vì 26/27 đều cần applyPatch client). Source-export trực tiếp (`exports` → `./src/index.ts`) — tsx/vitest/vite/tsc đều resolve, KHÔNG cần build tay; `applyPatch<W extends WorkflowShape>` generic nên 2 kiểu Workflow của server/web dùng thẳng không cast; `agent/patch.ts` thành thin re-export (caller cũ giữ nguyên import path) — spec: `docs/SPEC-step25.md`
26. ✅ Canvas sống theo từng patch-op: `applyOptimisticOp` (applyPatch shared, không set dirty, PatchError bỏ qua), op đầu tự mở split từ chat mode, highlight map + keyframes `ff-node-pop`/`ff-node-flash`/`ff-edge-draw` (re-trigger theo nonce, tôn trọng reduced-motion), reconcile onMessage server luôn thắng; bỏ nút "Bỏ qua animation" (server đã cap 1.5s — lệch design có chủ đích) — spec: `docs/SPEC-step26.md`
27. ✅ Auto-log thay đổi tay: `manualLog.ts` (queue tuần tự, debounce param 800ms/move 500ms, version chain, 409→rebase 1 lần với mergeLocalOnly, 422 drop im lặng, network fail→dirty+toast, flush trước run/save/đổi conversation) + entry gắn workflowId chống ghi nhầm khi switch (critical fix từ review) + tab Lịch sử thứ 4 (🤖/✋, toggle cosmetic, ↺ Khôi phục) + `ui/Toast` + dirty semantics mới (log thành công = đã persist) — spec: `docs/SPEC-step27.md`
28. ✅ E2E free-tier luồng chat qua mock OpenRouter (`e2e/mock-openrouter.ts` node:http thuần + env `OPENROUTER_BASE_URL` additive, mock CHỈ bật free tier): 5 kịch bản — chat tạo workflow + auto-split + row 🤖, digest `[tay]` tới AI, digest revert, nút ■ Dừng, version-conflict rebuild (≥2 request) — spec: `docs/SPEC-step28.md`

**LỘ TRÌNH AI-NATIVE HOÀN TẤT 2026-07-13** (9 bước, mỗi bước: Sonnet implement → 2 reviewer Opus → Sonnet verify → fix → orchestrator nghiệm thu; smoke thật cuối: 1 turn chat grok-4.5 chạy sống đủ thinking→patch-op→message→done).

29. ✅ Guard i2i cho `fal.image` + dạy agent chọn model theo dữ liệu vào (từ bug thật session user 2026-07-13: AI chọn flux/dev t2i cho node có ảnh → đốt tiền vô ích): catalog thêm `imageKind` t2i/i2i (fal API chỉ có đúng 2 category ảnh; 12 preset đều t2i), guard chặn trước khi tốn credit + gợi ý model i2i từ live, khối "QUY TẮC CHỌN MODEL THEO DỮ LIỆU VÀO" + tag `[i2i]`/`[t2i]` trong system prompt, fix sample-stock-restyle (flux/dev → flux-pro/kontext) + regression test quét mọi sample — spec: `docs/SPEC-step29.md`
30. ✅ AI nhìn thấy kết quả run: `buildRunSummary` (header + từng node state/cache/model/error cắt 200/output basename, cap 1500 ký tự reserve-error-first) vào system prompt chat qua dep optional `getLatestRun` (`SqliteRunStore.latestRunForWorkflow`), rebuild version-conflict cũng refresh; smoke thật: AI trả lời đúng chi tiết run của conversation ly cà phê — spec: `docs/SPEC-step30.md`

Hiện trạng: **13 node types, catalog live ~1.240 model (576 ảnh + 319 video fal + 345 LLM) + 48 preset ⭐, 11 samples, 441 server + 20 shared + 320 web + 27 e2e tests.** Việc sau này: tính năng mới theo yêu cầu user, vẫn theo luật orchestration ở trên. Backlog UX từ session 2026-07-13: đính kèm ảnh trong composer, CTA/diff chip trên bubble, summary change giàu thông tin, AI đặt tên workflow, badge i2i/t2i trong ModelPicker.

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
