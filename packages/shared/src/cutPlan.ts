/**
 * `CutPlan` + transcript-segment contract (SPEC-step33.md §2), shared
 * FE/BE (this node's json output flows through the engine into the panel
 * that will render it in a later sub-step) — defined once here, exactly
 * like `patch.ts`'s `PatchOpSchema`, so both apps validate against the same
 * zod schema instead of two hand-maintained mirrors drifting apart.
 */
import { z } from 'zod';

/** One selected moment inside the source video (SPEC-step33.md §2). `id` is
 * stable so the review UI (33e) can key off it across edits/resume. */
export const CutMomentSchema = z
  .object({
    id: z.string(),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    title: z.string(),
    reason: z.string().optional(),
    /** Empty/omitted = no b-roll inserted for this moment. */
    brollPrompt: z.string().optional(),
    brollDurationSec: z.number().positive().optional(),
    /** Filled in later by `broll.generate` (SPEC-step33.md §33d) — absent
     * until then. */
    brollImage: z
      .object({
        path: z.string(),
        mime: z.string().optional(),
      })
      .optional(),
  })
  // SPEC-step33.md §2: "end > start" — a zero-length or reversed moment
  // isn't a cuttable clip. (Note: `TranscriptSegmentSchema` below is a
  // separate, looser schema — `video.transcribe`'s clamped trailing segment
  // can legitimately have `start === end`.)
  .refine((m) => m.end > m.start, { message: 'CutMoment: "end" phải lớn hơn "start".' });
export type CutMoment = z.infer<typeof CutMomentSchema>;

export const CutPlanSchema = z.object({
  moments: z.array(CutMomentSchema),
});
export type CutPlan = z.infer<typeof CutPlanSchema>;

/** One transcript chunk with its time range (SPEC-step33.md §2 — the
 * `video.transcribe` output shape). */
export const TranscriptSegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  segments: z.array(TranscriptSegmentSchema),
  text: z.string(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
