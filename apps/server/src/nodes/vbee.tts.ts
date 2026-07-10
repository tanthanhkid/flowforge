/**
 * `vbee.tts` (SPEC-step2.md §7): Vietnamese text-to-speech via Vbee AIVoice
 * (async submit -> poll -> download, per the `vbee-tts` skill). The
 * provider client already downloads the result immediately since Vbee's
 * `audioLink` expires ~3 minutes after being issued.
 */
import { z } from 'zod';
import type { MediaValue, NodeDefinition } from '../engine/types.js';
import { ttsAsync } from './providers/vbee.js';

const ParamsSchema = z.object({
  voiceCode: z.string().default('hn_female_ngochuyen_full_48k-fhg'),
  speed: z.number().min(0.25).max(1.9).default(1.0),
  format: z.enum(['mp3', 'wav']).default('mp3'),
  bitrate: z.number().int().default(128),
});
type Params = z.infer<typeof ParamsSchema>;

const MIME_BY_FORMAT: Record<Params['format'], string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export const vbeeTtsNode: NodeDefinition<Params> = {
  type: 'vbee.tts',
  category: 'audio',
  title: 'Vbee: Chuyển văn bản thành giọng nói',
  description: 'Tổng hợp giọng nói tiếng Việt từ văn bản qua Vbee AIVoice.',
  inputs: {
    text: { type: 'text', required: true },
  },
  outputs: { audio: { type: 'audio' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params, ctx }) => {
    const text = String(inputs.text ?? '');

    const { data, contentType } = await ttsAsync({
      text,
      voiceCode: params.voiceCode,
      speed: params.speed,
      format: params.format,
      bitrate: params.bitrate,
      ctx,
    });

    const savedPath = await ctx.saveArtifact(data, params.format);

    const media: MediaValue = {
      kind: 'audio',
      path: savedPath,
      mime: contentType ?? MIME_BY_FORMAT[params.format],
      meta: { voiceCode: params.voiceCode, speed: params.speed, format: params.format },
    };
    return { audio: media };
  },
};
