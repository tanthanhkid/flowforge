# SPEC — Bước 14: Mở rộng model catalog (fal video/image đầy đủ hơn) + catalog OpenRouter LLM

Kế thừa Bước 13. Ba việc: (1) mở rộng danh sách fal; (2) thêm catalog LLM OpenRouter với giá THẬT từ API công khai; (3) UI picker áp dụng luôn cho param `model` của `llm.generate`/`llm.transform`.

## 1. Mở rộng fal catalog (`catalog/falModels.ts`)

Thêm entries — MỌI id phải verify sống bằng `curl -sI https://fal.ai/models/<id>` (200, không redirect). Ứng viên (kiểm tra và điều chỉnh id theo trang thật; id nào chết thì tìm bản đúng hoặc bỏ, ghi log):

- **Video thêm** (~mục tiêu tổng 18-24 entries, đủ cặp t2v/i2v khi có):
  - 💎: `fal-ai/kling-video/v2.1-master/*`, `fal-ai/bytedance/seedance/v1/pro/*`, `fal-ai/sora-2/text-to-video` (nếu có trên fal), `fal-ai/pika/v2.2/*`
  - ✅: `fal-ai/minimax/hailuo-02/standard/*`, `fal-ai/wan/v2.2-a14b/text-to-video` (họ wan 2.x), `fal-ai/pixverse/v4.5/*`, `fal-ai/hunyuan-video`, `fal-ai/vidu/q1/*`
  - 💸: `fal-ai/mochi-v1`, wan bản nhỏ/turbo nếu có
- **Image thêm** (~mục tiêu tổng 10-14): 💎 `fal-ai/imagen4/preview`, `fal-ai/bytedance/seedream/v3/text-to-image` (hoặc v4), `fal-ai/ideogram/v3` (chữ đẹp); ✅ `fal-ai/stable-diffusion-v35-large`, `fal-ai/qwen-image`, `fal-ai/hidream-i1-full`; 💸 `fal-ai/sana`, sdxl-lightning nếu còn.
- Giá: lấy từ trang model khi đọc được, không thì "(ước lượng)". Note tiếng Việt 1 dòng nêu điểm mạnh (vd "chữ trong ảnh đẹp", "chuyển động mượt", "nhanh").

## 2. Catalog OpenRouter — `catalog/openrouterModels.ts`

- Cùng interface `ModelPreset` (thêm `kind: 'llm'`; cost dạng "$X in / $Y out per 1M tokens").
- Danh sách curated (~12-16 model), verify + LẤY GIÁ THẬT từ API công khai `https://openrouter.ai/api/v1/models` (không cần key — curl 1 lần, match id, đọc `pricing.prompt`/`pricing.completion` — nhân 1e6 để ra $/1M): 
  - 💎 xịn: `anthropic/claude-sonnet-4.5`, `openai/gpt-5.2` (id thật theo API), `google/gemini-2.5-pro`, `x-ai/grok-4.5` (note: "default hệ thống hiện tại")
  - ✅ khá: `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash`, `deepseek/deepseek-chat-v3-0324` (bản mới nhất theo API), `meta-llama/llama-4-maverick`, `openai/gpt-5-mini` (nếu tồn tại)
  - 💸 rẻ: `google/gemini-2.0-flash-lite-001`, `qwen/qwen-2.5-72b-instruct` hay tương đương giá bèo, `meta-llama/llama-3.3-70b-instruct`
  - Id nào không có trong API response → thay bằng bản gần nhất đang tồn tại (ghi log). Giá điền từ API, làm tròn 2 số.
- `GET /api/model-catalog` → thêm key `llm`.

## 3. UI + agent

- `ModelIdField` dùng luôn cho param `model` của `llm.generate`/`llm.transform` (group 'llm'), với option ĐẦU TIÊN: "🔧 Mặc định hệ thống (grok-4.5)" → value `""` (giữ hành vi model rỗng = env default). Custom free-text vẫn có.
- promptBuilder: thêm section LLM catalog ngắn (id + tier + cost) với luật: "params.model để '' (default) trừ khi user yêu cầu model/chi phí cụ thể".

## 4. Tests

- api-catalog.test.ts: response có `llm`; video ≥ 18, image ≥ 10, llm ≥ 12; không trùng id; mọi cost non-empty; llm cost match pattern "$... / $...".
- agent-prompt: chứa section LLM catalog + luật default ''.
- params-panel: field `model` của llm.generate render select có option "Mặc định hệ thống" (value ''), chọn preset → set đúng, custom vẫn hoạt động.
- E2E free 12/12 chạy lại 1 lần.

## 5. DoD

- Server + web typecheck/test/build xanh; e2e 12/12; verify log đầy đủ (id nào giữ/đổi/bỏ, nguồn giá).
- KHÔNG chạy model nào thật (curl trang fal + API models của OpenRouter là đủ, không dùng key).
