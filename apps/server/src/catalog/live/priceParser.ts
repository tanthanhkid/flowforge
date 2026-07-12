/**
 * `parseFalPrice` (SPEC-step19.md §1.2): normalizes fal.ai's free-text
 * `pricingInfoOverride` markdown into a machine-readable `estUsd`, matching
 * the same normalization basis as the static catalog (`../falModels.ts`):
 * video = per 5-second clip, image = per 1 image.
 *
 * All 5 rules run against the string with markdown bold markers (`**`)
 * stripped first — every sample price string wraps its numbers in `**...**`,
 * and stripping them up front turns "you will be charged **$0.2419/second**"
 * into a plain "you will be charged $0.2419/second", which every regex below
 * can match without needing to know about markdown at all.
 *
 * Evaluation order is rule 3 ("without audio ... with audio", also matching
 * the "(audio off)/(audio on)" phrasing variant), THEN rules 1 and 2
 * (SPEC-step19.md §1.2 lists 1/2 before 3, but ties break in favor of
 * whichever price is textually FIRST in the string, not by rule-priority —
 * rule 1's `$X/second` regex matches the first `$.../second` occurrence
 * anywhere, with no awareness of "with"/"without audio" at all. A model
 * description phrased with-audio-first, e.g. "$0.40/second with audio, or
 * $0.20/second without audio" (the spec's own §0 sample happens to be phrased
 * without-audio-first, which is why this ordering bug wasn't caught by that
 * sample alone), would make rule 1 grab the WITH-audio price instead of the
 * without-audio one rule 3 exists specifically to select). Checking rule 3
 * first avoids that regardless of which price appears first textually — it
 * only ever matches strings that actually mention "without audio"/"(audio
 * off)", so it never fires on (and never changes the result for) rule 1/2's
 * own cases.
 *
 * Rule 3's own per-second detection is a separate, narrower problem: the
 * "$X/second"-adjacent check alone misses phrasing where the per-second
 * basis is stated earlier in the sentence rather than right next to the
 * no-audio price, e.g. fal.ai's real veo3.1/image-to-video text "For every
 * second of video you generate you will be charged $0.20 without audio or
 * $0.40 with audio" — the "$0.20" isn't immediately followed by "/second",
 * so rule 3 must also recognize "for every second"/"per second" appearing
 * anywhere in the string as proof the matched no-audio price is per-second
 * (not a flat per-clip price), on top of the adjacent-`/second` case.
 *
 * Rule 5 (per compute second / per megapixel / token-based / empty /
 * no match) deliberately returns `estUsd: null` rather than guessing — an
 * `unknown` tier is far less harmful than a fabricated price.
 */
import type { FalKind } from './types.js';

export interface ParsedFalPrice {
  estUsd: number | null;
  estBasis: string;
}

const UNKNOWN_BASIS = 'không xác định được đơn giá chuẩn hoá (per compute second/megapixel/token hoặc không rõ)';
const EMPTY_BASIS = 'không có thông tin giá từ fal.ai';

function stripMarkdownBold(s: string): string {
  return s.replace(/\*\*/g, '');
}

/** Words that mean "the price basis needs more than the raw string to compute" — disqualifies the last-resort single-`$` fallback (rule 4b) even when kind === 'image'. */
const AMBIGUOUS_UNIT_RE = /second|megapixel|token/i;

export function parseFalPrice(priceRaw: string | undefined | null, kind: FalKind): ParsedFalPrice {
  const raw = (priceRaw ?? '').trim();
  if (!raw) {
    return { estUsd: null, estBasis: EMPTY_BASIS };
  }

  const clean = stripMarkdownBold(raw);

  // Rule 3 (checked FIRST — see file header's "evaluation order" note):
  // "$X without audio ... $Y with audio" -> take X (no-audio price).
  // Also matches the "(audio off)/(audio on)" phrasing some fal.ai models use
  // instead of "without audio"/"with audio" (e.g. Kling v3 pro t2v).
  // Deliberately runs ahead of rules 1/2 so it wins regardless of whether
  // the without-audio or with-audio price appears first textually in the
  // string — rule 1/2's own regexes have no "audio" awareness at all.
  const noAudioMatch = /\$([\d.]+)\s*(?:\/second)?\s*(?:without\s+audio|\(audio\s+off\))/i.exec(clean);
  if (noAudioMatch) {
    const x = Number.parseFloat(noAudioMatch[1] ?? '');
    if (Number.isFinite(x)) {
      // Per-second billing basis can be signalled either right next to the
      // matched price ("$X/second without audio") or earlier in the same
      // sentence ("For every second of video ... you will be charged $X
      // without audio" / "... $X (audio off)") — check both, so a truly
      // flat "$X without audio" price (no "second" wording anywhere in the
      // string) still stays flat instead of getting a bogus x*5.
      const isPerSecond =
        /\$[\d.]+\s*\/second\s*(?:without\s+audio|\(audio\s+off\))/i.test(clean) ||
        /for\s+every\s+second\b/i.test(clean) ||
        /\bper\s+second\b/i.test(clean);
      return isPerSecond
        ? { estUsd: x * 5, estBasis: `per 5s clip (không âm thanh, quy đổi từ $${x}/second)` }
        : { estUsd: x, estBasis: 'per 5s clip (giá không kèm âm thanh; giá có âm thanh cao hơn)' };
    }
  }

  // Rule 1: "$X/second" or "$X per second" (video, per-second billing) -> X*5.
  const perSecondMatch = /\$([\d.]+)\s*(?:\/\s*second\b|per\s+second\b)/i.exec(clean);
  if (perSecondMatch) {
    const perSec = Number.parseFloat(perSecondMatch[1] ?? '');
    if (Number.isFinite(perSec)) {
      return { estUsd: perSec * 5, estBasis: `per 5s clip (quy đổi từ $${perSec}/second)` };
    }
  }

  // Rule 2: "For Ns video ... cost $X" (ignores a trailing "additional second $Y").
  const perClipMatch = /for\s+(\d+(?:\.\d+)?)s\s+video[^$]*?\$([\d.]+)/i.exec(clean);
  if (perClipMatch) {
    const seconds = Number.parseFloat(perClipMatch[1] ?? '');
    const cost = Number.parseFloat(perClipMatch[2] ?? '');
    if (Number.isFinite(seconds) && seconds > 0 && Number.isFinite(cost)) {
      const normalized = (cost / seconds) * 5;
      return { estUsd: normalized, estBasis: `per 5s clip (quy đổi từ $${cost}/${seconds}s)` };
    }
  }

  // Rule 4a: "$X per image".
  const perImageMatch = /\$([\d.]+)\s*per\s+image\b/i.exec(clean);
  if (perImageMatch) {
    const x = Number.parseFloat(perImageMatch[1] ?? '');
    if (Number.isFinite(x)) {
      return { estUsd: x, estBasis: 'per image' };
    }
  }

  // Rule 4b: kind === image and exactly one unqualified "$X" in the whole
  // string (no "second"/"megapixel"/"token" ambiguity) -> treat it as the
  // per-image price.
  if (kind === 'image' && !AMBIGUOUS_UNIT_RE.test(clean)) {
    const dollarMatches = [...clean.matchAll(/\$([\d.]+)/g)];
    if (dollarMatches.length === 1) {
      const x = Number.parseFloat(dollarMatches[0]?.[1] ?? '');
      if (Number.isFinite(x)) {
        return { estUsd: x, estBasis: 'per image (giá duy nhất tìm thấy trong mô tả)' };
      }
    }
  }

  // Rule 5: per compute second / per megapixel / token-based / empty / no match.
  return { estUsd: null, estBasis: UNKNOWN_BASIS };
}
