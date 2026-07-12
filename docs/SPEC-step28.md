# SPEC step 28 — AI-native "Copilot Song Song": E2E free-tier luồng chat + revert + version-conflict (mock OpenRouter)

Bước 9/9 — chốt lộ trình. Mục tiêu: các luồng AI-native được e2e THẬT (browser + server thật + SQLite thật) với chi phí 0 đồng nhờ mock OpenRouter ở tầng HTTP. Đây là lưới an toàn cho mọi thay đổi sau này.

## §1 Phạm vi file

- Sửa `apps/server/src/config.ts` + `nodes/providers/openrouter.ts`: base URL override qua env.
- Mới `e2e/mock-openrouter.ts`: mock server nhỏ (chạy bằng tsx).
- Sửa `e2e/playwright.config.ts`: thêm webServer entry cho mock + env trỏ server vào mock.
- Mới `e2e/tests/chat.spec.ts`: các test luồng chat (free tier).
- KHÔNG đổi logic nào khác của server/web.

## §2 `OPENROUTER_BASE_URL` (server, additive)

- `config.ts`: thêm key `OPENROUTER_BASE_URL`, default `https://openrouter.ai/api/v1`.
- `openrouter.ts`: URL completions = `${getEnv('OPENROUTER_BASE_URL')}/chat/completions` — tính tại thời điểm gọi (không cache module-load). Hành vi mặc định KHÔNG đổi (unit test hiện có phải xanh nguyên trạng).

## §3 `e2e/mock-openrouter.ts`

HTTP server thuần Node (`node:http`, không dependency mới), port cố định (vd 3979):

- `POST /chat/completions`: đọc body (messages OpenAI format), chọn kịch bản theo **nội dung message user CUỐI** (match substring, deterministic):
  - chứa `"tạo văn bản"` → completion JSON `{ reply: 'Đã thêm node văn bản.', ops: [add-node input.text id 'mock-text-1' params.text 'xin chào', update... ] }` (ops hợp lệ với registry thật — validate được).
  - chứa `"chậm"` → delay 1500ms rồi trả như trên (phục vụ test stop + version-conflict).
  - chứa `"chỉ trả lời"` → `{ reply: 'Đây là câu trả lời.', ops: [] }`.
  - mặc định → `{ reply: 'OK.', ops: [] }`.
  - Response bọc đúng shape OpenRouter/OpenAI: `{ choices: [{ message: { content: '<json trên, stringify>' } }] }` (đúng cách `chatCompletion` hiện tại parse — đọc code thật để khớp).
- **Ghi lại mọi request body** vào mảng in-memory; expose `GET /requests` (trả JSON mảng) + `POST /reset` — test dùng để assert digest.
- Chạy được standalone: `tsx e2e/mock-openrouter.ts` (đọc PORT từ env, default 3979).

## §4 `playwright.config.ts`

- Thêm webServer entry: `pnpm --filter server exec tsx ../../e2e/mock-openrouter.ts` (hoặc `node --import tsx` — miễn chạy; cân nhắc cwd) port 3979.
- Server webServer entry (free tier): thêm env `OPENROUTER_BASE_URL: 'http://127.0.0.1:3979'` + `OPENROUTER_API_KEY: 'e2e-dummy'` (env thắng `.env.local` — không đụng key thật, không tốn tiền).
- Real tier (`E2E_REAL=1`): KHÔNG set 2 env trên (giữ hành vi thật); test file mới skip khi real tier.

## §5 `e2e/tests/chat.spec.ts` (free tier; `test.skip` khi `E2E_REAL`)

1. **Chat tạo workflow end-to-end**: landing hero → gõ 'tạo văn bản giúp tôi' → Enter → đợi bubble assistant 'Đã thêm node văn bản.' → tự chuyển split mode → canvas có node `mock-text-1` → tab Lịch sử có row 🤖.
2. **Digest thay đổi tay tới AI**: sau test-1-flow (hoặc tự dựng), mở Canvas mode, kéo thêm 1 node từ palette (auto-log bước 27) → quay lại chat gửi 'chỉ trả lời đi' → `GET /requests` của mock: request CUỐI có system prompt chứa `[tay]` (digest đã vào context).
3. **Revert hiện trong digest**: tab Lịch sử → ↺ Khôi phục row đầu (confirm) → gửi 'chỉ trả lời tiếp' → request cuối của mock chứa `Khôi phục về trước thay đổi`.
4. **Stop**: gửi 'làm gì đó chậm nhé' → trong lúc chờ bấm ■ Dừng → bubble assistant lỗi 'Đã dừng theo yêu cầu', turn kết thúc, composer gửi lại được.
5. **Version-conflict rebuild**: gửi 'làm gì đó chậm nhé' → TRONG lúc chờ (≤1.5s) kéo 1 node vào canvas (bump version qua auto-log) → đợi turn xong: mock nhận ≥2 request (rebuild) VÀ turn kết thúc thành công (bubble reply xuất hiện, không kẹt pending) — assert qua `GET /requests` + UI.
6. **Reset mock giữa các test** (`POST /reset` trong beforeEach) + mỗi test dùng conversation mới để độc lập.

Lưu ý ổn định: các test này phụ thuộc timing SSE — dùng `expect.poll`/locator auto-wait, KHÔNG sleep cứng; nếu 1 test flaky chạy 3 lần liên tiếp phải xanh cả 3 mới được kết luận.

## §6 Nghiệm thu

`pnpm run e2e` xanh toàn bộ (20 cũ + ~5 mới) chạy 2 lần liên tiếp; `pnpm -r test` + typecheck 3 package xanh; unit test openrouter cũ không đổi; xác nhận mock KHÔNG bao giờ được bật ở real tier; không dependency mới.
