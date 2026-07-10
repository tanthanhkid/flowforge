# SPEC — Bước 2: Node thật (OpenRouter, fal.ai, Vbee) + utility nodes

Implementor bám sát spec; KHÔNG đổi public interface/file path/hành vi đã spec. Xây trên engine Bước 1 (KHÔNG sửa engine trừ khi review yêu cầu). ESM NodeNext (import đuôi `.js`). **Unit test KHÔNG được gọi mạng thật** — mock toàn bộ `fetch`.

## 1. Files

```
apps/server/src/config.ts                 # load .env.local ở repo root + getEnv()
apps/server/src/lib/http.ts               # requestJson (retry/timeout), downloadBinary, HttpError
apps/server/src/nodes/providers/openrouter.ts
apps/server/src/nodes/providers/fal.ts
apps/server/src/nodes/providers/vbee.ts
apps/server/src/nodes/input.text.ts       # 1 node = 1 file
apps/server/src/nodes/input.file.ts
apps/server/src/nodes/text.template.ts
apps/server/src/nodes/output.collect.ts
apps/server/src/nodes/llm.generate.ts
apps/server/src/nodes/llm.transform.ts
apps/server/src/nodes/fal.image.ts
apps/server/src/nodes/fal.video.ts
apps/server/src/nodes/vbee.tts.ts
apps/server/src/nodes/index.ts            # registerAllNodes(registry), createDefaultRegistry()
apps/server/scripts/smoke-step2.ts        # smoke THẬT, chạy tay (không thuộc vitest)
apps/server/test/{config,http,openrouter,fal,vbee,utility,nodes-registry,e2e-mocked}.test.ts
```

## 2. config.ts

- `loadEnv()`: tìm repo root bằng cách đi ngược từ thư mục file này lên tới nơi có `pnpm-workspace.yaml`; nạp `.env.local` (dùng package `dotenv`, `override: false` — `process.env` có sẵn thắng file). Idempotent.
- `getEnv(key: 'OPENROUTER_API_KEY' | 'OPENROUTER_DEFAULT_MODEL' | 'FAL_KEY' | 'VBEE_APP_ID' | 'VBEE_TOKEN', opts?: { optional?: boolean }): string` — thiếu key bắt buộc → throw Error message rõ: tên biến + "cấu hình trong .env.local". `OPENROUTER_DEFAULT_MODEL` có fallback `'x-ai/grok-4.5'`.
- KHÔNG bao giờ log giá trị key.

## 3. lib/http.ts

```ts
export class HttpError extends Error { status?: number; url: string; bodySnippet?: string; }
export interface RequestJsonOpts {
  url: string; method?: string; headers?: Record<string, string>; body?: unknown;
  timeoutMs?: number;        // default 60_000
  retries?: number;          // default 2 (tổng tối đa 3 lần)
  retryDelayMs?: number;     // base delay, default 500; delay = base * 2^attempt
  signal?: AbortSignal;
}
export async function requestJson<T = any>(opts: RequestJsonOpts): Promise<{ status: number; json: T }>;
export async function downloadBinary(url: string, opts?: { timeoutMs?: number /* default 120_000 */; headers?; signal? }): Promise<{ data: Buffer; contentType?: string }>;
```

- Retry khi: lỗi mạng, HTTP 408/429/5xx. KHÔNG retry 4xx khác.
- Timeout qua AbortSignal (kết hợp `signal` ngoài nếu có); message chứa chữ `timeout` + url.
- Lỗi HTTP → throw `HttpError` message dạng `"<METHOD> <url> failed: HTTP <status> — <bodySnippet ≤300 chars>"`. **TUYỆT ĐỐI không đưa header Authorization/App-Id value vào message/log.**

## 4. providers/openrouter.ts

```ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export async function chatCompletion(args: { model: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<string>;
```
- `POST https://openrouter.ai/api/v1/chat/completions`, headers `Authorization: Bearer <OPENROUTER_API_KEY>`, `X-Title: FlowForge`.
- Body `{ model, messages, temperature, max_tokens? }`. timeout 120_000, retries 2.
- Trả `choices[0].message.content`; rỗng/thiếu → throw lỗi rõ ("OpenRouter trả về rỗng…" + model).

## 5. providers/fal.ts (queue API)

```ts
export async function runFalQueue(args: { modelId: string; input: Record<string, unknown>; ctx: ExecutionContext; pollTimeoutMs?: number }): Promise<any>;
export function mediaToImageUrl(media: MediaValue, artifactsDir: string): Promise<string>; // url có sẵn → dùng; path → data URI base64 (đọc file, mime theo ext)
```
- Submit: `POST https://queue.fal.run/{modelId}`, header `Authorization: Key <FAL_KEY>`, body = input. Response: `{ request_id, status_url, response_url }` — **ưu tiên dùng `status_url`/`response_url` server trả về** (model id có subpath); fallback tự ghép `https://queue.fal.run/{modelId}/requests/{request_id}[/status]`.
- Poll bằng `ctx.poll` (initialDelayMs 1500, factor 1.4, maxDelayMs 8000, timeoutMs = pollTimeoutMs default 600_000): GET status_url (+`?logs=0`) → `{ status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' }`. `COMPLETED` → done. Status lỗi/4xx-5xx → throw kèm modelId + body snippet.
- Result: GET response_url → JSON trả nguyên.

## 6. providers/vbee.ts (theo skill vbee-tts — endpoint đã xác minh)

```ts
export async function ttsAsync(args: { text: string; voiceCode: string; speed: number; format: 'mp3' | 'wav'; bitrate: number; ctx: ExecutionContext }): Promise<{ data: Buffer; contentType?: string }>;
```
- Submit: `POST https://api.vbee.vn/v1/tts`, headers `Authorization: Bearer <VBEE_TOKEN>`, `App-Id: <VBEE_APP_ID>`, `Content-Type: application/json`.
  Body: `{ text, voiceCode, mode: 'async', webhookUrl: 'https://example.com/vbee-callback', outputFormat: format, bitrate, speed }` (webhookUrl là placeholder bắt buộc; ta dùng poll).
- Response 200/201: `{ requestId }` — thiếu → throw.
- Poll bằng `ctx.poll` (initialDelayMs 2000, factor 1.25, maxDelayMs 8000, timeoutMs 600_000): `GET https://api.vbee.vn/v1/tts/requests/{requestId}` cùng auth headers → JSON `{ status, audioLink }`. Done khi HTTP 200 && status ∈ {`COMPLETED`,`SUCCESS`} && có `audioLink`. status ∈ {`FAILED`,`ERROR`} → throw.
- **`audioLink` chỉ sống ~3 phút → download NGAY trong provider** (downloadBinary) và trả Buffer.

## 7. Node definitions

Mọi node: `category` đúng nhóm, `title`/`description` tiếng Việt ngắn gọn, error message rõ ràng (tên node + nguyên nhân + gợi ý sửa). Output media luôn qua `ctx.saveArtifact(buffer, ext)` → `MediaValue { kind, path, mime, meta }`.

| type | category | params (zod) | inputs | outputs | cacheable |
|---|---|---|---|---|---|
| `input.text` | utility | `{ value: string default '' }` | — | `text:text` | true |
| `input.file` | utility | `{ path: string min(1) }` | — | `file:any` | **false** |
| `text.template` | utility | `{ template: string min(1) }` | `a,b,c,d: text optional` | `text:text` | true |
| `output.collect` | utility | `{}` | `in1..in4: any optional` | `results:json` | **false** |
| `llm.generate` | llm | `{ model: string default '' (rỗng→OPENROUTER_DEFAULT_MODEL), system: string default '', temperature: number 0..2 default 0.7, maxTokens?: int>0 }` | `prompt:text required, context:text optional` | `text:text` | true |
| `llm.transform` | llm | `{ instruction: string min(1), model: string default '', temperature: number default 0.3 }` | `text:text required` | `text:text` | true |
| `fal.image` | image | `{ modelId: string default 'fal-ai/flux/dev', imageSize?: string, seed?: int, extra?: record (merge cuối vào input) }` | `prompt:text required, image:image optional` | `image:image` | true |
| `fal.video` | video | `{ modelId: string min(1) — bắt buộc, ví dụ 'fal-ai/kling-video/v2/master/text-to-video', duration?: string\|number, aspectRatio?: string, extra?: record }` | `prompt:text required, image:image optional` | `video:video` | true |
| `vbee.tts` | audio | `{ voiceCode: string default 'hn_female_ngochuyen_full_48k-fhg', speed: number 0.25..1.9 default 1.0, format: 'mp3'\|'wav' default 'mp3', bitrate: int default 128 }` | `text:text required` | `audio:audio` | true |

Chi tiết hành vi:
- `input.file`: path tuyệt đối hoặc relative với `data/artifacts`. File không tồn tại → error rõ. Kind theo ext: png/jpg/jpeg/webp/gif→image; mp4/mov/webm→video; mp3/wav/m4a/ogg→audio; ext khác → error liệt kê ext hỗ trợ.
- `text.template`: thay `{{a}}`/`{{ a }}` (tolerant whitespace) bằng input tương ứng; input không nối → `''`; slot lạ giữ nguyên.
- `llm.generate`: messages = [system nếu có] + user = prompt (+ `"\n\nContext:\n" + context` nếu có).
- `llm.transform`: system cố định "Bạn là công cụ biến đổi văn bản. Chỉ trả về văn bản kết quả, không giải thích."; user = `Instruction: {instruction}\n\nText:\n{text}`.
- `fal.image` input body: `{ prompt, image_size?, seed?, image_url? (từ mediaToImageUrl khi có input image), ...extra }`. Kết quả: `json.images[0].url` (fallback `json.image.url`) → download → artifact. meta lưu `{ modelId, seed: json.seed, sourceUrl }`.
- `fal.video` input body: `{ prompt, duration?, aspect_ratio?, image_url?, ...extra }`. Kết quả: `json.video.url` (fallback `json.videos[0].url`). pollTimeoutMs 900_000.
- `nodes/index.ts`: `registerAllNodes(registry)` đăng ký đủ 9 node; `createDefaultRegistry()` = new NodeRegistry + registerAllNodes.

## 8. scripts/smoke-step2.ts (chạy tay, KHÔNG thuộc vitest)

Script `tsx` chạy engine thật với key thật từ `.env.local`, in path artifact + text. 3 workflow nhỏ RẺ:
1. `input.text("Trả lời đúng 1 từ: OK") → llm.generate` (model default)
2. `input.text("Xin chào, đây là FlowForge.") → vbee.tts` (voice default, ~30 ký tự)
3. `input.text("a cute robot mascot, simple flat illustration") → fal.image` với `modelId: 'fal-ai/flux/schnell'` (model rẻ)
Thêm script `"smoke": "tsx scripts/smoke-step2.ts"` vào apps/server package.json. In kết quả từng node (state, path). KHÔNG in key.

## 9. Tests (vitest, fetch mock 100%)

- `test/setup.ts` (+ `vitest.config.ts` setupFiles): stub `globalThis.fetch` mặc định = throw `'unmocked fetch: ' + url` — chống gọi mạng thật; từng test override bằng mock riêng.
- `config.test.ts`: thiếu key → error nêu tên biến; OPENROUTER_DEFAULT_MODEL fallback; parse .env.local từ fixture tmp dir; process.env thắng file.
- `http.test.ts`: retry 429→429→200 thành công (retryDelayMs 1 cho nhanh); 400 KHÔNG retry; timeout → message chứa 'timeout' + url; HttpError chứa status + bodySnippet; message KHÔNG chứa giá trị Authorization.
- `openrouter.test.ts`: assert fetch nhận đúng url/headers/body (model, messages, Bearer); trả content đúng; content rỗng → throw.
- `fal.test.ts`: full queue flow (submit → IN_QUEUE → IN_PROGRESS → COMPLETED → response → download binary) với `status_url`/`response_url` do server trả (khác url tự ghép — assert dùng đúng); FAILED → error chứa modelId; mediaToImageUrl: url giữ nguyên, path → data URI đúng mime; fal.image node end-to-end mocked qua engine (artifact file thật trong tmp artifactsDir, MediaValue đúng).
- `vbee.test.ts`: submit body đúng (mode async, webhookUrl placeholder, voiceCode/speed/outputFormat/bitrate), headers Bearer + App-Id; poll PROCESSING→SUCCESS+audioLink→download ngay; FAILED → error; thiếu requestId → error.
- `utility.test.ts`: input.text; text.template (slot có/thiếu/lạ, whitespace); input.file (kind theo ext, file không tồn tại → error, ext lạ → error); output.collect gom inputs.
- `nodes-registry.test.ts`: createDefaultRegistry đủ 9 type; describeForAgent có paramsJsonSchema từng node.
- `e2e-mocked.test.ts`: workflow `input.text → llm.transform → vbee.tts` chạy qua Engine (fetch mock chuỗi OpenRouter + Vbee), run success, artifact audio tồn tại, node states/cache đúng (chạy lần 2 → cache hit toàn bộ, fetch không được gọi thêm).

Test bước 1 hiện có (40 test) phải tiếp tục xanh, KHÔNG sửa engine/test cũ trừ khi có lỗi thật.

## 10. Definition of Done

- `pnpm install` sạch (thêm deps: `dotenv`; devDeps giữ nguyên; KHÔNG thêm SDK fal/openai — tự viết client bằng fetch).
- `pnpm --filter server typecheck` 0 lỗi; `pnpm --filter server test` xanh toàn bộ (test cũ + mới).
- Không secret nào xuất hiện trong code/test/fixture/error message.
