/**
 * Curated fal.ai model catalog for `fal.image` / `fal.video` (SPEC-step13.md
 * §1). One file, easy to hand-edit — trending models change often, this is
 * a *ranked suggestion list* on top of the free-form `modelId` string param
 * (SPEC-step2.md §7 keeps that free-form input; this catalog never removes
 * it, it only makes the "good defaults" discoverable in the UI/agent).
 *
 * Every `id` below was verified live against `https://fal.ai/models/<id>`
 * (HTTP 200, no redirect to a search/not-found page) — see SPEC-step13.md
 * implementation report for the full verification log. `cost` is a rough,
 * user-facing reference string, not billing-accurate: pulled from the
 * model's page where pricing was legible, otherwise a "~" estimate.
 */

export interface FalModelPreset {
  /** Full fal.ai model id, e.g. "fal-ai/flux/dev". */
  id: string;
  /** Short display name. */
  label: string;
  /** 💎 xịn (best) / ✅ khá (good) / 💸 rẻ (cheap, lower quality). */
  tier: 'xin' | 'kha' | 're';
  /** Reference cost string, e.g. "~$3/8s — đắt nhất, đẹp nhất". */
  cost: string;
  /** One-line Vietnamese note: strengths/weaknesses. */
  note?: string;
  kind: 'video-t2v' | 'video-i2v' | 'image';
}

export const FAL_VIDEO_MODELS: FalModelPreset[] = [
  // 💎 xịn
  {
    id: 'fal-ai/veo3',
    label: 'Veo 3',
    tier: 'xin',
    cost: '~$3.2/8s (có âm thanh) — đắt nhất, đẹp nhất',
    note: 'Chất lượng điện ảnh, có âm thanh đồng bộ, chuyển động tự nhiên nhất hiện có',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/veo3/fast',
    label: 'Veo 3 Fast',
    tier: 'xin',
    cost: '~$1.2/8s — rẻ hơn Veo 3 gốc nhưng vẫn rất đẹp',
    note: 'Bản nhanh/rẻ hơn của Veo 3, đánh đổi chút chi tiết để giảm giá',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    label: 'Kling 2.5 Turbo Pro (text-to-video)',
    tier: 'xin',
    cost: '~$0.35/5s',
    note: 'Chuyển động mượt, bám prompt tốt, một trong những model video xịn nhất fal.ai',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    label: 'Kling 2.5 Turbo Pro (image-to-video)',
    tier: 'xin',
    cost: '~$0.35/5s',
    note: 'Bản image-to-video cùng dòng Kling 2.5 Turbo Pro — dùng khi có ảnh đầu vào',
    kind: 'video-i2v',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/pro/text-to-video',
    label: 'MiniMax Hailuo-02 Pro',
    tier: 'xin',
    cost: '~$0.045/s',
    note: 'Chất lượng cao, giá hợp lý hơn Veo3/Kling pro, giỏi chuyển động phức tạp',
    kind: 'video-t2v',
  },

  // ✅ khá
  {
    id: 'fal-ai/kling-video/v1.6/standard/text-to-video',
    label: 'Kling 1.6 Standard (text-to-video)',
    tier: 'kha',
    cost: '~$0.10-0.20/5s (ước lượng)',
    note: 'Đời cũ hơn Kling 2.5, vẫn ổn cho việc dùng hàng ngày, rẻ hơn bản pro',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/kling-video/v1.6/standard/image-to-video',
    label: 'Kling 1.6 Standard (image-to-video)',
    tier: 'kha',
    cost: '~$0.10-0.20/5s (ước lượng)',
    note: 'Bản image-to-video cùng dòng Kling 1.6 Standard',
    kind: 'video-i2v',
  },
  {
    id: 'fal-ai/luma-dream-machine/ray-2',
    label: 'Luma Ray 2',
    tier: 'kha',
    cost: '~$0.50/5s',
    note: 'Chất lượng khá, chuyển động camera đẹp, giá tầm trung',
    kind: 'video-t2v',
  },

  // 💸 rẻ
  {
    id: 'fal-ai/ltx-video',
    label: 'LTX Video',
    tier: 're',
    cost: '~$0.02-0.05/s (ước lượng)',
    note: 'Rẻ nhất, chất lượng thấp, hay ra ngang — chỉ để test',
    kind: 'video-t2v',
  },
];

export const FAL_IMAGE_MODELS: FalModelPreset[] = [
  // 💎 xịn
  {
    id: 'fal-ai/flux-pro/v1.1-ultra',
    label: 'FLUX 1.1 [pro] ultra',
    tier: 'xin',
    cost: '~$0.05/ảnh',
    note: 'Độ chi tiết cao nhất dòng FLUX, ảnh chân thực, giá cao nhất nhóm image',
    kind: 'image',
  },
  {
    id: 'fal-ai/recraft/v3/text-to-image',
    label: 'Recraft V3',
    tier: 'xin',
    cost: '~$0.04-0.08/ảnh',
    note: 'Giỏi chữ trong ảnh, tốt cho poster/logo/thiết kế có text',
    kind: 'image',
  },

  // ✅ khá
  {
    id: 'fal-ai/flux/dev',
    label: 'FLUX.1 [dev]',
    tier: 'kha',
    cost: '~$0.025/megapixel',
    note: 'Chất lượng tốt, giá vừa phải, lựa chọn mặc định hợp lý',
    kind: 'image',
  },

  // 💸 rẻ
  {
    id: 'fal-ai/flux/schnell',
    label: 'FLUX.1 [schnell]',
    tier: 're',
    cost: '~$0.003/megapixel — rẻ nhất',
    note: 'Test/nháp — sinh rất nhanh và rẻ nhưng chi tiết kém hơn bản dev/pro',
    kind: 'image',
  },
];
