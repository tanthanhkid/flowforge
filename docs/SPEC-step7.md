# SPEC — Bước 7: Playwright E2E (happy path, chi phí API tối thiểu)

Mục tiêu: E2E thật (browser + server + web dev thật) chứng minh happy case "tạo được": dựng workflow → run → thấy kết quả trên UI. Chia 2 tầng:
- **Tầng FREE (mặc định)**: chỉ utility node (`input.text`, `text.template`, `output.collect`) — 0 chi phí API, chạy được mọi lúc/CI.
- **Tầng REAL (gated `E2E_REAL=1`)**: gọi API thật với cấu hình rẻ nhất — LLM prompt tí hon (`maxTokens` nhỏ), Vbee text ≤40 ký tự, fal `fal-ai/flux/schnell` 1 ảnh. **KHÔNG test `fal.video`** (đắt, chủ đích bỏ). Tổng chi phí mỗi lần chạy ~vài cent.

## 1. Files & cấu trúc

```
e2e/package.json              # workspace package "e2e", devDep @playwright/test; scripts: "test" (chromium, free tier), "test:real" (E2E_REAL=1 …)
e2e/playwright.config.ts
e2e/tests/app.spec.ts         # tầng FREE
e2e/tests/real-media.spec.ts  # tầng REAL (test.skip khi !process.env.E2E_REAL)
pnpm-workspace.yaml           # thêm "e2e" vào packages
```

Sửa nhỏ được phép (tối thiểu, backward-compatible):
- `apps/server/src/index.ts`: đọc thêm env `FLOWFORGE_DB_PATH`, `FLOWFORGE_ARTIFACTS_DIR` (optional, default như cũ) → e2e dùng DB/artifacts riêng trong thư mục tmp, không đụng data dev.
- `apps/web/vite.config.ts`: proxy target port đọc `process.env.FLOWFORGE_SERVER_PORT ?? '3001'`.
- Thêm `data-testid` vào UI (không đổi behavior): `palette-<type>`, `node-card` (+ attr `data-node-id`, `data-state`), `node-state-badge`, `node-preview`, `run-btn`, `run-force-btn`, `save-btn`, `validate-btn`, `json-view-btn`, `json-view-textarea`, `json-view-apply`, `json-view-error`, `describe-btn`, `describe-input`, `describe-generate`, `settings-btn`, `settings-field-<KEY>`, `runs-tab`, `run-history-item`.

## 2. playwright.config.ts

- `webServer` array khởi động cả 2 (reuseExistingServer: false):
  1. server: `pnpm --filter server exec tsx src/index.ts` với env `PORT=3777`, `FLOWFORGE_DB_PATH=<tmp>/e2e.db`, `FLOWFORGE_ARTIFACTS_DIR=<tmp>/artifacts` (tmp tạo trong config bằng `mkdtemp` hoặc thư mục `e2e/.tmp` được gitignore + dọn khi start); url health `http://127.0.0.1:3777/api/health`.
  2. web: `pnpm --filter web exec vite --port 5273 --strictPort` với env `FLOWFORGE_SERVER_PORT=3777`; url `http://127.0.0.1:5273`.
- `use.baseURL = 'http://127.0.0.1:5273'`, project duy nhất chromium, `retries: 1`, trace on-first-retry. Timeout test mặc định 30s; real tier tự set 240s/test.
- LƯU Ý: server đọc `.env.local` thật (cần key thật cho tầng REAL) — điều này OK vì e2e chạy local; tầng FREE không gọi provider nào.

## 3. app.spec.ts — tầng FREE (bắt buộc pass 100%)

Helper `applyWorkflowViaJsonView(page, wf)`: mở JSON view → điền textarea → Apply → đóng. Dùng làm cách dựng graph ổn định (đây cũng là tính năng thật). Workflow mẫu: `input.text(value="xin chào") → text.template(template="Lời chào: {{a}}") → output.collect`.

1. **App load**: sidebar hiện đủ 9 `palette-<type>`; toolbar đủ nút.
2. **Thêm node từ palette**: click `palette-input.text` → 1 `node-card` xuất hiện trên canvas.
3. **Params edit**: chọn node vừa thêm, sửa value trong ParamsPanel → JSON view chứa value mới.
4. **Happy run**: applyWorkflowViaJsonView(mẫu) → Save → Run → chờ mọi `node-card[data-state="success"]` (3 node) → `node-preview` của template chứa "Lời chào: xin chào"; toolbar hiện status success.
5. **Cache**: Run lần 2 → badge ⚡cache xuất hiện trên ≥1 node. Run ⚡ bỏ cache → badge cache biến mất (node chạy lại thật).
6. **JSON view lỗi**: nhập JSON hỏng → `json-view-error` hiện, store không đổi (canvas giữ nguyên số node).
7. **Validate lỗi**: apply workflow có edge type-mismatch (vd `text.template.text → output.collect` ok... dùng mismatch thật: nối text vào port không tồn tại sẽ bị validate — dùng workflow thiếu required input của `text.template`? required=false hết → dùng `llm.generate` thiếu prompt) → Validate → issue list hiện, click issue → node được select.
8. **Persistence**: Save → reload page → mở WorkflowList → workflow còn đó, mở lại đủ node.
9. **Runs history**: tab Runs có ≥2 run, click run cũ → states hiển thị.
10. **Settings mask**: mở ⚙ → 5 field; các field secret không chứa value dài hơn preview `••••xxxx` ở bất kỳ đâu trong DOM (`page.content()` không chứa chuỗi 20+ ký tự của key — assert bằng regex kiểm tra input value/placeholder chỉ dạng mask).

## 4. real-media.spec.ts — tầng REAL (`E2E_REAL=1`, serial, timeout 240s/test)

`test.describe.serial` + `test.skip(!process.env.E2E_REAL, 'set E2E_REAL=1 để chạy tier tốn phí')`.

1. **Agent generate (✨)**: mở Describe → nhập "Viết đúng 1 câu chào ngắn gọn rồi chuyển thành giọng nói nữ" → Generate → chờ ≤120s → canvas có ≥3 node, trong đó có `llm.generate` và `vbee.tts` (kiểm tra qua JSON view text).
2. **LLM + TTS chain run**: applyWorkflowViaJsonView: `input.text("Trả lời đúng 1 từ: OK") → llm.generate(maxTokens: 16) → vbee.tts` (text từ LLM ~2 từ, rẻ) → Save → Run → chờ success ≤240s → node vbee có `node-preview` chứa thẻ `<audio>`.
3. **fal.image**: `input.text("tiny cute robot icon, flat") → fal.image(modelId: "fal-ai/flux/schnell")` → Run → chờ success ≤240s → `node-preview` có `<img>` với src `/artifacts/…` load được (naturalWidth > 0).

KHÔNG có test `fal.video`. Ghi chú chi phí ước tính ngay đầu file (~$0.01–0.05/lần chạy).

## 5. Scripts & DoD

- Root package.json: `"e2e": "pnpm --filter e2e test"`, `"e2e:real": "pnpm --filter e2e test:real"`.
- Implementor: `pnpm --filter e2e exec playwright install chromium` trước khi chạy.
- DoD: (1) tầng FREE pass 100% ổn định (chạy 2 lần liên tiếp không flake); (2) mọi unit suite cũ (177 server + 68 web) vẫn xanh; (3) typecheck/build sạch; (4) tầng REAL KHÔNG được implementor/reviewer chạy — orchestrator chạy khi nghiệm thu.
- `.gitignore`: thêm `e2e/.tmp`, `e2e/test-results`, `e2e/playwright-report`.
