# SPEC step 19 — Catalog model động từ API fal.ai + OpenRouter, chia tier theo giá

Yêu cầu user (11-07-2026): catalog model fal.ai/OpenRouter hiện liệt kê thiếu, không có model mới nhất. Đổi sang: **liệt kê đầy đủ từ API của họ, chia tier theo giá**. Làm SAU khi step 18 (redesign) đã commit — picker UI phải theo phong cách neo-brutalist mới.

## 0. Khảo sát đã xác nhận (orchestrator đã curl thật 11-07-2026)

- **OpenRouter**: `GET https://openrouter.ai/api/v1/models` — công khai, KHÔNG cần key, trả `{data: [345 model]}`. Field quan trọng: `id`, `name`, `pricing.prompt`/`pricing.completion` (USD/token, dạng string), `context_length`, `created` (unix), `architecture` (modality). Có đủ model mới nhất.
- **fal.ai**: `GET https://fal.ai/api/models?page=N` — công khai, không cần key, phân trang `{items, page, pages(35), size(40), total(1399)}`. Query param `category` KHÔNG hoạt động (trả toàn bộ) → phải fetch hết ~35 trang rồi tự lọc. Field quan trọng: `id`, `title`, `category` (`text-to-image`/`image-to-image`/`text-to-video`/`image-to-video`/…), `date`+`publishedAt` (ISO), `deprecated`, `removed`, `status`, `hidePricing`, `shortDescription`, `pricingInfoOverride` (chuỗi **markdown**, KHÔNG structured), `modelFamily`, `tags`, `thumbnailUrl`.
- Format giá fal đa dạng (mẫu thật): `"you will be charged **$0.2419/second**"`, `"For **5s** video your request will cost **$0.28**. For every additional second … **$0.056**"`, `"**$0.20** without audio or **$0.40** with audio"`, `"**$0.08** per image"`, `"**$0.00111** per compute second"`, `"charged based on the number of input and output tokens"`, và **chuỗi rỗng (~50% model)**.

## 1. Server — module catalog live

Tạo `apps/server/src/catalog/live.ts` (hoặc thư mục `live/`) — TÁCH RIÊNG phần fetch/parse/tier khỏi preset tĩnh hiện có:

### 1.1 Fetch
- `fetchOpenRouterCatalog()`: 1 request, lọc model output text (loại embedding/moderation; dùng `architecture`), map → `{ id, label: name, per1MIn, per1MOut, contextLength, createdAt: created*1000 }`. `estUsd = 0.0008*per1MIn + 0.0005*per1MOut` (đúng công thức step 15, per call ~800 in/500 out).
- `fetchFalCatalog()`: loop page 1→`pages` (song song tối đa 5 request một lúc, timeout 10s/req), gom items; lọc: `!deprecated && !removed`, category ∈ {`text-to-image`, `image-to-image`} → kind `image`; `text-to-video` → `video-t2v`; `image-to-video` → `video-i2v`; bỏ các category khác. Map → `{ id, label: title, kind, createdAt: Date.parse(date||publishedAt), note: shortDescription (cắt 120 ký tự), priceRaw: pricingInfoOverride }`.

### 1.2 Parse giá fal → `estUsd` (chuẩn hoá GIỐNG step 15: video = per 5s clip, image = per 1 ảnh)
Regex heuristics theo thứ tự ưu tiên (viết unit test bằng đúng các chuỗi mẫu ở mục 0):
1. `$X/second` hoặc `$X per second` (của video) → `X*5`.
2. `For **Ns** video … cost **$X**` → chuẩn hoá `X/N*5`; nếu có "additional second **$Y**" thì vẫn dùng công thức trên (đơn giản, nhất quán).
3. Có 2 giá "without audio **$X** … with audio **$Y**" → lấy X (không audio) theo pattern 1/2.
4. `$X per image` hoặc kind image + duy nhất 1 giá `**$X**` → `X`.
5. `per compute second` / `per megapixel` / token-based / chuỗi rỗng / không match → `estUsd = null` (KHÔNG đoán bừa).
Lưu thêm `estBasis` string mô tả cách quy đổi (tiếng Việt) như catalog tĩnh đang có.

### 1.3 Tier THEO GIÁ (yêu cầu user) — ngưỡng cố định, đặt làm constant có comment để chỉnh tay:
| kind | 💎 xin | ✅ kha | 💸 re |
|---|---|---|---|
| video (per 5s) | ≥ $0.75 | $0.20–0.75 | < $0.20 |
| image (per ảnh) | ≥ $0.05 | $0.01–0.05 | < $0.01 |
| llm (per call) | ≥ $0.004 | $0.0006–0.004 | < $0.0006 |

`estUsd === null` → tier `unknown` (UI hiển thị ❓ "chưa rõ giá", xếp cuối). Sanity check (đã tính tay): Veo3 ≈$2/5s → 💎; Kling 2.1 standard $0.28/5s → ✅; Claude Sonnet 4.5 $0.0099 → 💎; model free $0 → 💸.

### 1.4 Cache + fallback (bắt buộc để test/e2e không phụ thuộc mạng)
- Bảng SQLite mới `catalog_cache(provider TEXT PRIMARY KEY, fetched_at INTEGER, payload TEXT)` (theo pattern migration/schema hiện có trong `db/`).
- TTL 24h. **KHÔNG fetch lúc server startup.** Fetch lazy ở request `/api/catalog` đầu tiên: cache hit còn hạn → dùng; hết hạn → trả cache cũ ngay + refetch nền; miss → fetch (timeout tổng 25s), fail → fallback preset tĩnh hiện có, `meta.source='static'`.
- Env `CATALOG_LIVE=0` → tắt hẳn live, luôn dùng preset tĩnh (set trong e2e webServer env + unit test). Fetcher phải inject được (param/DI) để unit test mock.
- `POST /api/catalog/refresh` → force refetch cả 2 provider, trả counts + fetchedAt.

### 1.5 Merge preset tĩnh (giữ giá trị tay đã viết)
Preset trong `falModels.ts`/`openrouterModels.ts` match theo `id` với live → gắn `featured: true`, giữ `note`/`label`/`estUsd` tay (đáng tin hơn parse). Preset không còn trên live vẫn giữ (source static). Model live không phải preset → `featured: false`.

### 1.6 Consumer phải cập nhật đồng bộ
- `routes/modelCatalog.ts`: trả catalog hợp nhất `{ falVideo, falImage, openrouter, meta: {source, fetchedAt, counts} }` — được phép đổi shape, đổi đồng bộ với web store + test.
- `engine/costEstimate.ts`: lookup estUsd live-merge trước, preset tĩnh sau, không có → behavior "không rõ giá" hiện tại.
- `nodes/fal.video.ts` guard t2v (step 17): tra `kind` từ catalog hợp nhất (live biết nhiều model hơn → guard tốt hơn); model không có trong catalog → giữ behavior hiện tại (không chặn).
- `agent/promptBuilder.ts`: KHÔNG nhét 1700 model vào prompt — dùng danh sách featured + top ~8 mỗi tier mỗi kind (cap ~30 id), ghi chú trong prompt rằng model id là free-form.

## 2. Web — picker model mới (theo design neo-brutalist step 18)

`ParamsPanel` param `model`/`modelId` (llm.generate/llm.transform/fal.image/fal.video):
- Combobox tìm kiếm thay dropdown thuần: ô search viền đen 2px (focus hồng), list nhóm theo tier `💎 XỊN / ✅ KHÁ / 💸 RẺ / ❓ CHƯA RÕ GIÁ` (header nhóm nền màu category style neo-brutal), mỗi dòng: label đậm + id mono nhỏ + giá mono phải (`$0.28/5s`, `$3 + $15 /1M`) + badge `⭐` nếu featured + badge `MỚI` (nền lime) nếu `createdAt` ≤ 60 ngày.
- fal.video: lọc theo kind t2v/i2v đúng logic guard hiện có; fal.image: kind image; llm: openrouter list.
- Hiệu năng: render tối đa 60 dòng, dưới cùng hiện "…còn N model — gõ để lọc thêm". Sort trong tier: featured trước, rồi mới nhất trước.
- **Luôn giữ option "✏️ Tự nhập model id"** (ràng buộc gốc CLAUDE.md) — search không thấy vẫn nhập tay được.
- Toolbar/Settings không đổi. Nút "↻ Cập nhật danh sách model" nhỏ trong picker gọi `/api/catalog/refresh`.

## 3. Ràng buộc

- KHÔNG cần API key cho cả 2 endpoint (đã xác nhận) — tuyệt đối không đụng `.env.local`.
- Unit test + e2e KHÔNG gọi mạng thật (mock fetcher / `CATALOG_LIVE=0`).
- Giữ mọi `data-testid` hiện có; testid mới: `model-picker-search`, `model-picker-refresh`, `model-picker-custom`.
- Server test (263) + web test + e2e free xanh; typecheck 2 workspace sạch.
- Không đổi engine execution / node schema (chỉ phần catalog lookup).

## 4. Nghiệm thu

1. Unit: parser giá (≥8 case thật mục 0), tier per kind, merge featured, cache TTL + fallback static, route shape, guard t2v với model live.
2. Live thật (orchestrator chạy tay): `curl /api/catalog` → counts hợp lý (openrouter ~300+, fal image+video ~600+), có mặt model mới (`fal-ai/nano-banana-2/edit`, `fal-ai/kling-video/v3/pro/text-to-video`, `bytedance/seedance-2.0/*`, `openai/gpt-5.6-luna-pro`…), spot-check 3 giá parse đối chiếu chuỗi gốc.
3. UI: picker search + tier + MỚI badge + tự nhập hoạt động; cost estimate 💰 vẫn chạy với model ngoài preset.
4. Commit + push + noti + cập nhật CLAUDE.md (step 19).
