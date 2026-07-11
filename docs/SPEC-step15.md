# SPEC — Bước 15: Cost estimate cho pipeline + sample "max chất lượng"

## 1. Dữ liệu giá máy-tính-được (mở rộng catalog, KHÔNG phá field cũ)

- `ModelPreset` thêm: `estUsd: number` (chi phí ước tính 1 lần chạy điển hình) + `estBasis: string` (vd "per 5s clip", "per image", "per call ~800in/500out tokens").
  - Video: estUsd cho clip 5s (Veo3 tính theo 8s gốc → quy về; ghi basis rõ). fal.video có params.duration số → **scale tuyến tính** duration/5.
  - Image: per image. LLM: tính từ giá thật $/1M: `(0.0008*in + 0.0005*out)` (≈800 in/500 out tokens/call).
- Node không thuộc catalog: bảng tĩnh `NODE_BASE_COST` trong estimator: `vbee.tts` ≈ $0.02 (basis "per ~500 ký tự, ước lượng"), `llm.*` model rỗng → dùng giá default model (grok-4.5 trong catalog llm), utility/`video.compose`/`input.*`/`output.collect` = 0.

## 2. Server — `src/engine/costEstimate.ts` + route

```ts
export interface NodeCostEstimate { nodeId: string; type: string; usd: number | null; basis: string; note?: string } // null = không ước tính được (custom model id)
export interface CostEstimate { totalUsd: number; unknownCount: number; nodes: NodeCostEstimate[]; disclaimer: string }
export function estimateWorkflowCost(wf: Workflow, catalog): CostEstimate;
```
- Lookup theo `params.modelId` (fal) / `params.model` (llm, rỗng → default model). Custom id ngoài catalog → usd null, unknownCount++, note "model ngoài catalog".
- fal.video: scale theo duration nếu là number (kling duration "5"/"10" string → parse). totalUsd = tổng usd non-null.
- disclaimer cố định: "Ước tính tham khảo theo catalog, chưa tính cache hit/retry."
- `POST /api/estimate` body = workflow JSON (shape-parse) → CostEstimate. Đăng ký buildServer.

## 3. UI

- Toolbar: cạnh nút Run hiện `💰 ~$X.XX` (testid `cost-estimate`) — gọi /api/estimate mỗi khi workflow đổi (debounce 800ms, silent fail). unknownCount>0 → hiện `+?`. Click → popover breakdown: từng node (id, usd hoặc "?", basis) + disclaimer.
- Store: `costEstimate` state + `refreshEstimate()`.

## 4. Sample max chất lượng — `samples/sample-premium-video.json`

"💎 Video quảng cáo cao cấp (max quality)": `topic(input.text: sản phẩm mẫu — 'nước hoa Việt cao cấp Miss Sài Gòn')` → `script(llm.generate, model 'anthropic/claude-sonnet-4.5', script 60-80 từ sang trọng)` → `voice(vbee.tts nữ SG)`; `script` → `vid_prompt(llm.transform, model 'anthropic/claude-sonnet-4.5', EN cinematic luxury prompt)` → `video(fal.video, modelId 'fal-ai/veo3', duration 8, aspectRatio '9:16')` → `final(video.compose 1080×1920)`; `caption(llm.generate model claude: caption FB sang trọng)` từ script → collect(script→in1, caption→in2, final.video→in3). Positions gọn. Cập nhật samples.test.ts (10 files) + seed.

## 5. Tests

- `cost-estimate.test.ts`: từng loại node đúng giá catalog; duration scale (10s = 2× 5s); model rỗng → giá default; custom id → null + unknownCount; total đúng tổng; sample-premium-video estimate > $3 (Veo3).
- `api-estimate` (thêm vào api-catalog hoặc file riêng): 200 shape đúng, body sai shape → 400.
- Web: toolbar hiện `~$`, popover breakdown render, unknown hiện `+?` (mock fetch).
- E2E free: thêm assert nhẹ trong test hiện có — workflow utility-only hiện `~$0.00`. Chạy e2e 1 lần.

## 6. DoD

Server + web typecheck/test/build xanh; e2e xanh; seed ra 10 samples. KHÔNG chạy model thật (kể cả sample premium — chỉ estimate).
