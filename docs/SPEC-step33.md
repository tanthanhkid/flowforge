# SPEC-step33 — Video dài → Short tự động + B-roll (Video Repurposing Pipeline)

> Orchestrator: Fable · Implement: Sonnet · Review: Opus · Verify: Sonnet
> Ngày: 2026-07-22 · Yêu cầu user: "đưa vào 1 video dài → transcribe → chọn khoảnh khắc → **xem bản cắt** → cắt short → fal.ai tạo b-roll image chèn vào các đoạn cut."

## 0. Quyết định sản phẩm (user chốt 2026-07-22)

| Quyết định | Lựa chọn |
|---|---|
| Luồng duyệt bản cắt | **Gate/approval tạm dừng** — engine dừng ở node duyệt, chờ user OK/sửa rồi chạy tiếp |
| Kiểu b-roll | **Cutaway toàn màn hình** — ảnh full khung N giây, chèn xen giữa các đoạn nói |
| Đầu ra | **1 short ghép các khoảnh khắc, 9:16 1080×1920** |
| Prompt b-roll | **LLM tự sinh** theo transcript từng đoạn |

## 1. Luồng graph

```
input.video → video.transcribe → llm.selectMoments → flow.approveGate → broll.generate → video.assembleShort → output.collect
              (fal wizper)        (OpenRouter)         ⏸ chờ duyệt        (fal.image ×N)   (ffmpeg cắt+ghép)
```

Gate đặt **ngay trước** `broll.generate`: user duyệt/sửa bản cắt **trước khi** phát sinh chi phí gen ảnh + cắt.

**Dynamic-N:** số khoảnh khắc do LLM quyết lúc chạy; graph DAG tĩnh không fan-out N node `fal.image` được → vòng lặp N **nằm trong** `broll.generate` và `video.assembleShort`.

## 2. Contract dùng chung — CutPlan (port `json`)

Định nghĩa 1 lần trong `packages/shared` (zod `CutPlanSchema`), FE/BE dùng chung.

```ts
interface CutPlan {
  moments: Array<{
    id: string;                 // ổn định, dùng làm key UI + khớp khi resume
    start: number;              // giây trong video nguồn
    end: number;                // giây; end > start
    title: string;              // tiêu đề ngắn khoảnh khắc
    reason?: string;            // vì sao chọn (LLM giải thích)
    brollPrompt?: string;       // prompt sinh ảnh b-roll (LLM viết); rỗng = không chèn b-roll
    brollDurationSec?: number;  // default 2.5
    brollImage?: { path: string; mime?: string }; // broll.generate điền vào
  }>;
}
```

Segment (output transcribe, port `json`): `{ segments: Array<{ start: number; end: number; text: string }>, text: string }`.

## 3. Sub-steps (mỗi bước: Sonnet code → 2 Opus review → Sonnet verify → orchestrator nghiệm thu → commit)

### 33a — `video.transcribe` + fal upload helper + CutPlan/segment schema

**Files:** `apps/server/src/nodes/video.transcribe.ts`, `apps/server/src/nodes/providers/fal.ts` (thêm `uploadToFal`), `packages/shared/src/*` (thêm `CutPlanSchema`, `TranscriptSchema`), `nodes/index.ts` (đăng ký), unit test.

- **`uploadToFal(data: Buffer, filename: string, contentType: string, ctx): Promise<string>`** trong `providers/fal.ts`: dùng fal storage REST (initiate → PUT → trả `file_url`). **Implementer PHẢI đọc skill `fal-ai` để lấy đúng endpoint/flow upload** (KHÔNG đoán). Auth `Authorization: Key ${FAL_KEY}` như `runFalQueue`. Lý do cần upload thật: audio video dài vài MB → base64 data-URI (như `mediaToImageUrl`) quá lớn/không ổn định.
- **`video.transcribe`** node:
  - inputs `{ video: {type:'video', required:true} }`, outputs `{ text: {type:'text'}, segments: {type:'json'} }`.
  - params (zod, JSON-Schema-representable): `model` (string, default `fal-ai/wizper`), `language` (string, default `'auto'`), `task` (`'transcribe'|'translate'`, default transcribe).
  - execute: resolve local path (như `video.compose.resolveMediaPath` — bắt buộc file thật) → **ffmpeg tách audio** ra mp3/m4a mono 16kHz (`ffmpeg -i in -vn -ac 1 -ar 16000 out.mp3`, spawn giống video.compose, ENOENT → báo cài ffmpeg) → `uploadToFal` → `runFalQueue({modelId: model, input: { audio_url, task, ...(language!=='auto'?{language}:{}) }})` → parse kết quả (wizper trả `text` + `chunks:[{timestamp:[start,end], text}]`) → map sang `segments`. Log số segment. cacheable mặc định (key gồm input video path + params).
- **Test (mock `runFalQueue`/`uploadToFal` + fake ffmpeg hoặc mock spawn):** parse chunks→segments đúng; language auto bỏ field; lỗi fal → thông báo rõ; abort.
- **Catalog (OPTIONAL, không chặn):** có thể thêm 2 preset STT (`fal-ai/wizper`, `fal-ai/whisper`) — nhưng model id là string tự do nên KHÔNG bắt buộc động vào `catalog/live` (tránh phá switch theo `kind`). Nếu làm: thêm kind `'audio-stt'` additive, không đổi hành vi kind cũ.

### 33b — `llm.selectMoments`

**Files:** `apps/server/src/nodes/llm.selectMoments.ts`, `nodes/index.ts`, test.

- inputs `{ segments: {type:'json', required:true}, instruction: {type:'text', required:false} }`, outputs `{ plan: {type:'json'} }`.
- params: `model` (default lấy từ `OPENROUTER_DEFAULT_MODEL`), `maxMoments` (default 5), `targetDurationSec` (default 45), `temperature` (default 0.4), `generateBrollPrompts` (bool, default true).
- execute: dùng provider `providers/openrouter.ts` (theo pattern `llm.generate.ts`), system prompt yêu cầu trả **JSON đúng CutPlan** (moments sắp theo thời gian, mỗi moment có title/reason, và `brollPrompt` mô tả cảnh minh hoạ nếu `generateBrollPrompts`). Validate bằng `CutPlanSchema`; invalid → gửi lỗi lại cho LLM sửa (tối đa 2 retry, như agent layer). Gán `id` ổn định nếu LLM thiếu. Clamp `end<=` duration cuối segment.
- **Test:** parse plan hợp lệ; retry khi JSON sai; instruction rỗng vẫn chạy; sort theo start.

### 33c — Engine approval-gate (RỦI RO NHẤT)

**Files:** `apps/server/src/engine/types.ts` (NodeState + ctx), `engine/executor.ts`, `engine/gateRegistry.ts` (mới), `runManager.ts`, `routes/runs.ts`, `nodes/flow.approveGate.ts` (mới), `nodes/index.ts`, `apps/web` store + panel (đẩy sang 33e — chỉ phần BE ở đây), test.

**Cơ chế (KHÔNG persist/resume-from-DB):** node gate `await` một promise ngoài. Engine chạy node async nên branch gate "đậu" lại trong khi run vẫn `running` (activeRuns giữ, SSE vẫn stream). Resume = resolve promise với plan (đã sửa).

1. **`NodeState`** thêm `'awaiting'` (`engine/types.ts:52`). Kiểm mọi nơi switch trên NodeState (FE badge, không có exhaustive switch nào vỡ ở BE vì lưu string).
2. **`ExecutionContext`** thêm optional `awaitApproval?(payload: unknown): Promise<unknown>`. KHÔNG có handler (unit test/headless) → node gate pass-through (xem dưới) — giữ engine test không cần gate.
3. **`GateRegistry`** (`engine/gateRegistry.ts`): map `${runId}::${nodeId}` → deferred. `register(runId,nodeId,payload,signal,timeoutMs): Promise<unknown>` (reject khi abort hoặc timeout mặc định 30 phút); `resolve(runId,nodeId,value): boolean`; `reject(runId,nodeId,err): boolean`; `hasPending(runId,nodeId)`. Inject vào `Engine` qua constructor (optional) + expose getter cho RunManager.
4. **`executor.ts`**: trong `runNode`, khi build ctx, nếu engine có gate → set `awaitApproval: async (payload) => { upsertNode({nodeId, state:'awaiting', cacheHit:false, startedAt, outputs:{ pendingApproval: payload }}); emitNodeState(nodeId,'awaiting',{}); const v = await gate.register(runId,nodeId,payload,runSignal); return v; }`. Node awaiting KHÔNG thuộc `finished`, vẫn nằm trong `inFlight` → vòng `while(inFlight.size>0)` chờ tự nhiên, các branch song song vẫn chạy. Khi resolve, execute trả outputs thật → `finishNodeSuccess` ghi đè `pendingApproval`.
   - Lưu ý: `emitNodeState` hiện chỉ nhận `{error?,cached?}`. Thêm event riêng KHÔNG bắt buộc — state `'awaiting'` + `getRun` trả `outputs.pendingApproval` là đủ cho FE. (Payload cũng đi kèm qua snapshot SSE khi FE reconnect.)
5. **`flow.approveGate`** node: category `'utility'`, title "Duyệt bản cắt". inputs `{ plan: {type:'json', required:true} }`, outputs `{ plan: {type:'json'} }`. **cacheable: false** (luôn dừng). execute: `if(!ctx.awaitApproval) return { plan: inputs.plan }` (pass-through headless); else `const approved = await ctx.awaitApproval({ plan: inputs.plan }); return { plan: approved ?? inputs.plan }`.
6. **`runManager.ts`**: thêm `resolveGate(runId,nodeId,value)` / `rejectGate` passthrough tới engine gate. `isActive` giữ true suốt lúc chờ (đã đúng).
7. **`routes/runs.ts`**: `POST /api/runs/:id/resume` body `{ nodeId: string; output: unknown }` (output = CutPlan đã duyệt/sửa, shape-validate bằng `CutPlanSchema`) → `runManager.resolveGate`. 200 nếu resolve được; **409** nếu không còn gate pending (vd server restart giữa chừng — nợ đã biết, không persist). SSE: state `awaiting` đến FE qua `node:state` sẵn có; sau resume, downstream chạy tiếp emit bình thường tới `run:state`.
8. **Test:** engine test với gate stub: run dừng ở node awaiting (state='awaiting', outputs.pendingApproval có payload), resolve → downstream chạy, run success với plan đã sửa; abort giữa chờ → node error + run error; timeout reject; headless (không gate) → pass-through.

**Nợ đã biết (ghi vào DESIGN PHẦN 0):** server restart khi đang `awaiting` → run mồ côi ở `running`, resume trả 409, user phải chạy lại. Chấp nhận cho MVP local single-user.

### 33d — `broll.generate` + `video.assembleShort`

**Files:** `apps/server/src/nodes/broll.generate.ts`, `nodes/video.assembleShort.ts`, `nodes/index.ts`, test.

- **`broll.generate`**: inputs `{ plan: {type:'json', required:true} }`, outputs `{ plan: {type:'json'} }`. params: `model` (fal image **t2i**, default rẻ vd `fal-ai/flux/schnell`), `imageSize` (default `portrait_16_9` / 1080×1920 hợp short), `skipEmptyPrompt` (default true). execute: lặp `plan.moments`, mỗi moment có `brollPrompt` → `runFalQueue` (t2i) → `downloadBinary` → `ctx.saveArtifact` → gán `moment.brollImage.path`. Tôn trọng abort (dừng vòng lặp). Log tiến độ `i/N`. Guard t2i/i2i (step 29): model phải t2i, không truyền image input. **cacheable: true** (key theo plan + model).
- **`video.assembleShort`**: inputs `{ video: {type:'video', required:true}, plan: {type:'json', required:true} }`, outputs `{ video: {type:'video'} }`. params: `width`(1080), `height`(1920), `fit`('cover'|'contain', default cover), `fps`(30), `brollDurationSec`(2.5), `defaultBrollDurationSec` fallback. execute (ffmpeg, tái dùng pattern `video.compose`: temp dir, normalize từng clip về `libx264/yuv420p` cùng WxH/fps + audio 1 sample rate, rồi concat):
  - Với mỗi moment (theo thứ tự start): (1) cắt đoạn nói `ffmpeg -ss start -to end -i src` → normalize clip có audio; (2) nếu `brollImage.path` tồn tại → tạo still clip từ ảnh dài `brollDurationSec` (`-loop 1 -t dur -i img`, thêm **audio câm** `anullsrc` để concat đồng nhất luồng audio), normalize cùng thông số. Thứ tự chèn: **[đoạn nói][b-roll]** lặp lại (cutaway toàn màn hình xen giữa).
  - Concat tất cả clip → 1 mp4 → `ctx.saveArtifact('mp4')`. Timeout ~180s, abort-aware, ENOENT ffmpeg báo rõ. Nếu plan rỗng moments → lỗi rõ ràng.
- **Test:** broll.generate loop gọi fal đúng số prompt, bỏ moment rỗng prompt, abort; assembleShort dựng đúng args ffmpeg (mock spawn), thứ tự clip, still-clip khi có/không b-roll.

### 33e — Frontend duyệt bản cắt + sample + e2e

**Files:** `apps/web/src/store/run.ts` (hoặc tương đương), `apps/web/src/panels/CutPlanReview.tsx` (mới), `apps/web/src/api/*`, `samples/sample-video-to-short.*` + seed, `e2e/*`.

- **Store/SSE:** xử lý `node:state` với `state:'awaiting'` → đọc `outputs.pendingApproval.plan` (từ snapshot/getRun) → set `awaitingGate = { runId, nodeId, plan }`.
- **`CutPlanReview` panel:** hiện khi có `awaitingGate`. Liệt kê moments (start–end, title, reason, brollPrompt) — **sửa được** (title/start/end/brollPrompt, thêm/xoá moment). Nút **"Duyệt & cắt"** → `POST /api/runs/:id/resume { nodeId, output: {moments} }`, clear awaitingGate. Nút **"Huỷ"** → stop run (abort hiện có). Đặt panel ở CanvasPane tab phải hoặc overlay ChatPane (chọn nơi ít phá layout nhất; badge nhắc khi ẩn).
- **Kết quả:** short xong hiện ở tab Kết quả có video preview + download (đã có sẵn cho port video).
- **Sample `sample-video-to-short`:** graph 6 node theo §1, kèm asset video ngắn trong `samples/` (dùng asset stock sẵn hoặc video mẫu nhỏ). Seed script thêm sample này.
- **e2e free-tier (0 đồng):** thêm **mock fal** (`e2e/mock-fal.ts`, bật qua env additive giống `mock-openrouter`) trả segments/plan/ảnh cố định + mock openrouter cho selectMoments; ffmpeg chạy thật trên asset nhỏ (transcribe extract audio + assemble). Kịch bản: chạy workflow → dừng ở gate (state awaiting + panel hiện) → resume → short xuất hiện ở Kết quả. Nếu ffmpeg trong CI khó → tối thiểu assert luồng awaiting→resume→downstream chạy (mock cả assemble nếu cần). `CATALOG_LIVE=0`.
- **Dọn nợ INFO từ review 33a** (FE, defer tới đây): `apps/web/src/panels/ParamsPanel.tsx` — thêm nhãn tiếng Việt cho param mới (`language`, `task` của video.transcribe; các param của selectMoments/broll/assemble) vào `PARAM_LABELS`; cập nhật doc-comment "13 node types" → số node mới (33 thêm ~5 node → ~18).

## 4. Chi phí (nhắc user)

transcribe ~$0.01–0.1/video (theo độ dài) · gen ảnh ~$0.01–0.04 × số khoảnh khắc · LLM rẻ. Gate cho duyệt **trước** phần gen ảnh + cắt.

## 5. Nghiệm thu (theo luật dự án)

Mỗi sub-step: `pnpm -r test` xanh + (33e) `pnpm run e2e` xanh → smoke thật khi liên quan (33a transcribe 1 clip ngắn thật, cuối cùng 1 lần chạy full pipeline thật ngắn nếu user đồng ý tốn phí) → commit main + push (check `.env.local`/`*.db`/artifacts không commit) → ntfy → restart dev :3001 nếu server đổi. Dừng lại hỏi user sau mỗi sub-step.
