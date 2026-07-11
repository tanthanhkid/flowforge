/**
 * Curated fal.ai model catalog for `fal.image` / `fal.video` (SPEC-step13.md
 * §1). One file, easy to hand-edit — trending models change often, this is
 * a *ranked suggestion list* on top of the free-form `modelId` string param
 * (SPEC-step2.md §7 keeps that free-form input; this catalog never removes
 * it, it only makes the "good defaults" discoverable in the UI/agent).
 *
 * Every `id` below was verified live against `https://fal.ai/models/<id>`
 * (HTTP 200 + a real `<title>`, no redirect to a search/not-found page) —
 * see SPEC-step13.md / SPEC-step14.md implementation reports for the full
 * verification log. `cost` is a rough, user-facing reference string, not
 * billing-accurate: pulled from the model's page where pricing was legible,
 * otherwise a "~" estimate.
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

  {
    id: 'fal-ai/kling-video/v2.1/master/text-to-video',
    label: 'Kling 2.1 Master (text-to-video)',
    tier: 'xin',
    cost: '$1.40/5s',
    note: 'Bản Master mới nhất dòng Kling, chi tiết và bám prompt tốt hơn 2.5 Turbo Pro nhưng đắt hơn',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/kling-video/v2.1/master/image-to-video',
    label: 'Kling 2.1 Master (image-to-video)',
    tier: 'xin',
    cost: '$1.40/5s + $0.28/s thêm',
    note: 'Bản image-to-video cùng dòng Kling 2.1 Master',
    kind: 'video-i2v',
  },
  {
    id: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    label: 'Seedance 1.0 Pro (text-to-video)',
    tier: 'xin',
    cost: '~$0.62/5s (1080p)',
    note: 'Model của ByteDance, chuyển động mượt và ổn định, cạnh tranh trực tiếp với Kling/Veo',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
    label: 'Seedance 1.0 Pro (image-to-video)',
    tier: 'xin',
    cost: '~$0.74/5s (1080p)',
    note: 'Bản image-to-video cùng dòng Seedance 1.0 Pro',
    kind: 'video-i2v',
  },
  {
    id: 'fal-ai/sora-2/text-to-video',
    label: 'Sora 2',
    tier: 'xin',
    cost: '$0.1/s',
    note: 'Model của OpenAI trên fal, chất lượng điện ảnh, hiểu vật lý/chuyển động phức tạp tốt',
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
  {
    id: 'fal-ai/pika/v2.2/text-to-video',
    label: 'Pika 2.2',
    tier: 'kha',
    cost: '$0.20/5s (720p) — $0.45/5s (1080p)',
    note: 'Hiệu ứng chuyển cảnh/Pikaffects đặc trưng, giá theo độ phân giải',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    label: 'MiniMax Hailuo-02 Standard (text-to-video)',
    tier: 'kha',
    cost: '$0.045/s',
    note: 'Bản Standard rẻ hơn Pro cùng dòng Hailuo, vẫn giỏi chuyển động phức tạp',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    label: 'MiniMax Hailuo-02 Standard (image-to-video)',
    tier: 'kha',
    cost: '$0.045/s',
    note: 'Bản image-to-video cùng dòng Hailuo-02 Standard',
    kind: 'video-i2v',
  },
  {
    id: 'fal-ai/wan/v2.2-a14b/text-to-video',
    label: 'Wan 2.2 A14B (text-to-video)',
    tier: 'kha',
    cost: '~$0.04-0.08/s theo độ phân giải',
    note: 'Model mã nguồn mở của Alibaba, họ Wan 2.x, chất lượng khá và rẻ hơn các model đóng',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/pixverse/v4.5/text-to-video',
    label: 'PixVerse V4.5 (text-to-video)',
    tier: 'kha',
    cost: '~$0.15-0.4/5s theo độ phân giải',
    note: 'Chuyển động khá mượt, nhiều hiệu ứng camera, giá theo độ phân giải',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/pixverse/v4.5/image-to-video',
    label: 'PixVerse V4.5 (image-to-video)',
    tier: 'kha',
    cost: '~$0.15-0.4/5s theo độ phân giải',
    note: 'Bản image-to-video cùng dòng PixVerse V4.5',
    kind: 'video-i2v',
  },
  {
    id: 'fal-ai/hunyuan-video',
    label: 'Hunyuan Video',
    tier: 'kha',
    cost: '~$0.40/video',
    note: 'Model mã nguồn mở của Tencent, chất lượng khá cho một model mở',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/vidu/q1/text-to-video',
    label: 'Vidu Q1 (text-to-video)',
    tier: 'kha',
    cost: '~$0.40/5s',
    note: 'Chất lượng khá, giỏi giữ nhân vật nhất quán giữa các cảnh',
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
  {
    id: 'fal-ai/mochi-v1',
    label: 'Mochi 1',
    tier: 're',
    cost: '~$0.10-0.20/video (ước lượng)',
    note: 'Model mã nguồn mở, chuyển động ổn ở mức cơ bản, phù hợp test nhanh',
    kind: 'video-t2v',
  },
  {
    id: 'fal-ai/wan-t2v',
    label: 'Wan 2.1 (text-to-video)',
    tier: 're',
    cost: '$0.2/video (720p)',
    note: 'Đời cũ hơn Wan 2.2, rẻ, chất lượng vừa phải cho việc nháp/test ý tưởng',
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
  {
    id: 'fal-ai/imagen4/preview',
    label: 'Imagen 4 (preview)',
    tier: 'xin',
    cost: '$0.04-0.06/ảnh theo bản (fast/standard/ultra)',
    note: 'Model của Google, ảnh chân thực và chi tiết cao, đặc biệt tốt cho ảnh người',
    kind: 'image',
  },
  {
    id: 'fal-ai/bytedance/seedream/v4/text-to-image',
    label: 'Seedream V4',
    tier: 'xin',
    cost: '~$0.03-0.05/ảnh (ước lượng)',
    note: 'Model của ByteDance, bản mới nhất dòng Seedream, chi tiết cao và màu sắc đẹp',
    kind: 'image',
  },
  {
    id: 'fal-ai/ideogram/v3',
    label: 'Ideogram V3',
    tier: 'xin',
    cost: '$0.03/ảnh (Turbo) — $0.06 (Balanced) — $0.09 (Quality)',
    note: 'Giỏi chữ trong ảnh nhất hiện có (cùng nhóm với Recraft), nhiều mức chất lượng/giá',
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
  {
    id: 'fal-ai/stable-diffusion-v35-large',
    label: 'Stable Diffusion 3.5 Large',
    tier: 'kha',
    cost: '~$0.03-0.06/ảnh (ước lượng)',
    note: 'Model mã nguồn mở của Stability AI, chất lượng khá, linh hoạt fine-tune',
    kind: 'image',
  },
  {
    id: 'fal-ai/qwen-image',
    label: 'Qwen Image',
    tier: 'kha',
    cost: '~$0.02-0.04/ảnh (ước lượng)',
    note: 'Model mã nguồn mở của Alibaba, chất lượng khá, giỏi chữ tiếng Trung/Anh',
    kind: 'image',
  },
  {
    id: 'fal-ai/hidream-i1-full',
    label: 'HiDream I1 Full',
    tier: 'kha',
    cost: '$0.05/megapixel',
    note: 'Model mã nguồn mở, chi tiết tốt, cạnh tranh với FLUX dev',
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
  {
    id: 'fal-ai/sana',
    label: 'SANA',
    tier: 're',
    cost: '~$0.005-0.01/ảnh (ước lượng)',
    note: 'Rất nhanh và rẻ, chất lượng thấp hơn FLUX/SD nhưng đủ dùng để nháp',
    kind: 'image',
  },
  {
    id: 'fal-ai/fast-sdxl',
    label: 'Fast SDXL',
    tier: 're',
    cost: '~$0.01/ảnh (ước lượng)',
    note: 'SDXL bản tối ưu tốc độ, rẻ và nhanh, hợp cho test hàng loạt',
    kind: 'image',
  },
];
