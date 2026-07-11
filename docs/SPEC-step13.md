# SPEC — Bước 13: Model catalog cho fal.image / fal.video — đánh hạng xịn/dỏm + chọn trong UI

Vấn đề user: không biết model nào xịn/dỏm (ltx ra video "gớm"). Fix: catalog curated server-side, UI dropdown phân hạng, agent ✨ biết catalog. **Giữ nguyên** khả năng nhập model id tự do (chủ đích của dự án).

## 1. Catalog — `apps/server/src/catalog/falModels.ts` (1 file, dễ sửa tay)

```ts
export interface FalModelPreset {
  id: string;                 // fal model id đầy đủ
  label: string;              // tên ngắn gọn
  tier: 'xin' | 'kha' | 're'; // 💎 xịn / ✅ khá / 💸 rẻ (chất lượng thấp)
  cost: string;               // giá THAM KHẢO, vd "~$3/8s — đắt nhất, đẹp nhất"
  note?: string;              // 1 dòng: điểm mạnh/yếu tiếng Việt
  kind: 'video-t2v' | 'video-i2v' | 'image';
}
export const FAL_VIDEO_MODELS: FalModelPreset[];
export const FAL_IMAGE_MODELS: FalModelPreset[];
```

Danh sách đề xuất (implementor PHẢI verify từng id còn tồn tại bằng `curl -sI https://fal.ai/models/<id>` — HTTP 200; id nào 404 thì tìm id đúng trên fal.ai hoặc bỏ, ghi chú lại; giá lấy từ trang model nếu thấy, không thì ước lượng ghi "~"):

**Video** — t2v và i2v tách entry (id khác nhau):
- 💎 xịn: `fal-ai/veo3` (+ `fal-ai/veo3/fast` rẻ hơn chút), `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` + `/image-to-video`, `fal-ai/minimax/hailuo-02/pro/text-to-video`
- ✅ khá: `fal-ai/kling-video/v1.6/standard/text-to-video` + `/image-to-video`, `fal-ai/luma-dream-machine/ray-2`
- 💸 rẻ: `fal-ai/ltx-video` (note: "rẻ nhất, chất lượng thấp, hay ra ngang — chỉ để test")

**Image:**
- 💎 xịn: `fal-ai/flux-pro/v1.1-ultra`, `fal-ai/recraft/v3/text-to-image` (note: giỏi chữ trong ảnh)
- ✅ khá: `fal-ai/flux/dev`
- 💸 rẻ: `fal-ai/flux/schnell` (note: "test/nháp")

## 2. API + agent

- `GET /api/model-catalog` → `{ video: FalModelPreset[], image: FalModelPreset[] }` (route mới, đăng ký buildServer).
- `promptBuilder.buildGenerateSystemPrompt` (+ edit prompt): chèn thêm section "MODEL CATALOG (fal)" render từ catalog — id + tier + cost + note, kèm luật: "mặc định chọn tier 'kha'; user nói 'đẹp/xịn/chất lượng cao' → tier 'xin'; 'rẻ/test' → tier 're'".

## 3. UI — ParamsPanel

- Field `modelId` của node `fal.image`/`fal.video` → **select** thay text input:
  - Options group theo tier: "💎 Xịn", "✅ Khá", "💸 Rẻ" — mỗi option hiện `label — cost` (title tooltip = note + id). Value = id.
  - fal.video: lọc theo ngữ cảnh — node có edge vào port `image` thì ưu tiên hiện i2v trước, vẫn hiện hết.
  - Option cuối "✏️ Tự nhập model id..." → hiện text input tự do bên dưới (giữ tính năng cũ). Nếu value hiện tại không nằm trong catalog → select tự ở chế độ custom, text input hiện value đó.
- Dưới select hiện dòng nhỏ: cost + note của model đang chọn.
- Catalog fetch 1 lần vào store (`loadCatalog()` cùng lúc loadRegistry).

## 4. Tests

- Server: `api-catalog.test.ts` (shape + mọi id non-empty + tier hợp lệ); `agent-prompt.test.ts` bổ sung: prompt chứa section catalog + 1 id tier xịn; catalog file: không trùng id.
- Web: `params-panel.test.tsx` bổ sung: select hiện đủ 3 nhóm; chọn preset → updateNodeParams đúng id; giá trị lạ → chế độ custom với text input; đổi sang "Tự nhập" giữ được value.
- E2E free không đổi (chạy xác nhận 1 lần).

## 5. DoD

- Server typecheck + suite xanh (226 + mới); web typecheck/build/test xanh; e2e free 12/12.
- Verify log: danh sách id đã check 200/404 và điều chỉnh gì.
- KHÔNG chạy model video/image thật.
