/**
 * SPEC-step19.md §1.2/§1.3/§4 — catalog-live-price-parser.test.ts.
 * `parseFalPrice` against the exact "mẫu thật" strings quoted in §0
 * (verbatim, including the markdown bold markers and the "…" ellipsis), plus
 * a couple of synthetic cases that round out §1.2's rule coverage (the
 * "$X per second" wording variant of rule 1, and rule 5's per-megapixel /
 * single-unlabeled-price edge of rule 4b). Also covers `tierForPrice`'s
 * fixed threshold table and the §1.3 sanity checks.
 */
import { describe, expect, it } from 'vitest';
import { parseFalPrice } from '../src/catalog/live/priceParser.js';
import { TIER_THRESHOLDS, tierForPrice } from '../src/catalog/live/tier.js';

describe('parseFalPrice', () => {
  // SPEC-step19.md §0 sample 1 (verbatim) — rule 1, slash form.
  it('parses "$X/second" (video) -> X*5', () => {
    const result = parseFalPrice('you will be charged **$0.2419/second**', 'video-t2v');
    expect(result.estUsd).toBeCloseTo(1.2095, 6);
    expect(result.estBasis).toContain('per 5s clip');
  });

  // Synthetic — rule 1's other quoted wording ("$X per second"), not present
  // verbatim in §0 but explicitly named by the rule text.
  it('parses "$X per second" (video) -> X*5', () => {
    const result = parseFalPrice('$0.05 per second billing', 'video-t2v');
    expect(result.estUsd).toBeCloseTo(0.25, 6);
  });

  // SPEC-step19.md §0 sample 2 (verbatim) — rule 2; also the §1.3 sanity
  // check ("Kling 2.1 standard $0.28/5s -> ✅ kha").
  it('parses "For Ns video ... cost $X" -> normalizes to per-5s-clip, ignoring the additional-second rate', () => {
    const result = parseFalPrice(
      'For **5s** video your request will cost **$0.28**. For every additional second … **$0.056**',
      'video-t2v',
    );
    expect(result.estUsd).toBeCloseTo(0.28, 6);
    expect(tierForPrice('video', result.estUsd)).toBe('kha');
  });

  // SPEC-step19.md §0 sample 3 (verbatim) — rule 3.
  it('parses "$X without audio ... $Y with audio" -> takes X (no-audio price)', () => {
    const result = parseFalPrice('**$0.20** without audio or **$0.40** with audio', 'video-t2v');
    expect(result.estUsd).toBeCloseTo(0.2, 6);
  });

  // Post-review fix: rule 3 must run BEFORE rule 1's generic "$X/second"
  // regex, because that regex has no "with"/"without audio" awareness and
  // matches whichever "$.../second" occurs FIRST in the string. The spec's
  // own §0 sample 3 happens to be phrased without-audio-first, which is why
  // this ordering bug wasn't caught by that sample alone — this test uses
  // the reverse order (with-audio price mentioned first) to prove rule 3
  // still wins.
  it('parses "$Y with audio ... $X without audio" (with-audio price mentioned FIRST) -> still takes X (no-audio price), not Y', () => {
    const result = parseFalPrice('**$0.40**/second with audio, or **$0.20**/second without audio', 'video-t2v');
    expect(result.estUsd).toBeCloseTo(1.0, 6); // 0.20 * 5, NOT 0.40 * 5
  });

  // Real fal.ai pricingInfoOverride for fal-ai/veo3.1/image-to-video (caught
  // by orchestrator's live-API acceptance pass). The no-audio price ($0.20)
  // is NOT immediately followed by "/second" — the per-second basis is
  // stated earlier in the sentence ("For every second of video you
  // generate ... charged $0.20 without audio") — so rule 3 must recognize
  // that context and still normalize to per-5s-clip (x*5), not take $0.20
  // as a flat per-clip price.
  it('parses veo3.1/image-to-video "For every second ... charged $X without audio or $Y with audio" -> X*5 (per-second, not flat)', () => {
    const result = parseFalPrice(
      'For every second of video you generate you will be charged **$0.20** without audio or **$0.40** with audio for generations with audio.',
      'video-i2v',
    );
    expect(result.estUsd).toBeCloseTo(1.0, 6); // 0.20 * 5
    expect(tierForPrice('video', result.estUsd)).toBe('xin');
  });

  // Real fal.ai pricingInfoOverride for fal-ai/kling-video/v3/pro/text-to-video.
  // Uses "(audio off)/(audio on)" instead of "without audio"/"with audio" —
  // rule 3 must recognize this phrasing variant too, and (as with the
  // veo3.1 case above) the per-second basis is stated earlier in the
  // sentence rather than right next to the price.
  it('parses kling v3 pro t2v "For every second ... charged $X (audio off) or $Y (audio on)" -> X*5', () => {
    const result = parseFalPrice(
      'For every second of video you generated, you will be charged **$0.112** (audio off) or **$0.168** (audio on), with a minimum charge for 3 seconds.',
      'video-t2v',
    );
    expect(result.estUsd).toBeCloseTo(0.56, 6); // 0.112 * 5
    expect(tierForPrice('video', result.estUsd)).toBe('kha');
  });

  // SPEC-step19.md §0 sample 4 (verbatim) — rule 4a.
  it('parses "$X per image" -> X', () => {
    const result = parseFalPrice('**$0.08** per image', 'image');
    expect(result.estUsd).toBeCloseTo(0.08, 6);
    expect(result.estBasis).toBe('per image');
  });

  // SPEC-step19.md §0 sample 5 (verbatim) — rule 5: "per compute second"
  // must NOT be mistaken for rule 1's "per second", even for kind: 'image'
  // (rule 4b's single-$-amount fallback must not fire either).
  it('parses "$X per compute second" -> null (never guessed)', () => {
    const videoResult = parseFalPrice('**$0.00111** per compute second', 'video-t2v');
    expect(videoResult.estUsd).toBeNull();

    const imageResult = parseFalPrice('**$0.00111** per compute second', 'image');
    expect(imageResult.estUsd).toBeNull();
  });

  // SPEC-step19.md §0 sample 6 (verbatim) — rule 5: token-based, no $ at all.
  it('parses token-based pricing text -> null', () => {
    const result = parseFalPrice('charged based on the number of input and output tokens', 'image');
    expect(result.estUsd).toBeNull();
  });

  // SPEC-step19.md §0: "~50% model" have an empty pricingInfoOverride.
  it('parses an empty string -> null', () => {
    expect(parseFalPrice('', 'image').estUsd).toBeNull();
    expect(parseFalPrice(undefined, 'video-t2v').estUsd).toBeNull();
  });

  // Synthetic — rule 5's other named unit ("per megapixel"), same
  // "ambiguous unit disqualifies rule 4b" guard as the compute-second case.
  it('parses "$X per megapixel" (image) -> null, not a guessed per-image price', () => {
    const result = parseFalPrice('**$0.025** per megapixel', 'image');
    expect(result.estUsd).toBeNull();
  });

  // Synthetic — rule 4b: kind === image, single unqualified "$X", no
  // ambiguous unit word anywhere -> treated as the per-image price.
  it('parses a single unlabeled "$X" for kind image -> X (last-resort fallback)', () => {
    const result = parseFalPrice('Starting at **$0.03** per generation', 'image');
    expect(result.estUsd).toBeCloseTo(0.03, 6);
  });

  // Rule 4b must not fire for video kind (only defined for image).
  it('does not apply the single-$ fallback to video kind -> null', () => {
    const result = parseFalPrice('Starting at **$0.03** per generation', 'video-t2v');
    expect(result.estUsd).toBeNull();
  });
});

describe('tierForPrice', () => {
  it('uses the fixed threshold table per SPEC-step19.md §1.3', () => {
    expect(TIER_THRESHOLDS.video).toEqual({ xin: 0.75, kha: 0.2 });
    expect(TIER_THRESHOLDS.image).toEqual({ xin: 0.05, kha: 0.01 });
    expect(TIER_THRESHOLDS.llm).toEqual({ xin: 0.004, kha: 0.0006 });
  });

  it('estUsd === null -> unknown', () => {
    expect(tierForPrice('video', null)).toBe('unknown');
  });

  // SPEC-step19.md §1.3 sanity checks.
  it('Veo3 ~$2/5s -> xin', () => {
    expect(tierForPrice('video', 2.0)).toBe('xin');
  });

  it('Kling 2.1 standard $0.28/5s -> kha', () => {
    expect(tierForPrice('video', 0.28)).toBe('kha');
  });

  it('Claude Sonnet 4.5 $0.0099/call -> xin', () => {
    expect(tierForPrice('llm', 0.0099)).toBe('xin');
  });

  it('a free ($0) model -> re, in every bucket', () => {
    expect(tierForPrice('video', 0)).toBe('re');
    expect(tierForPrice('image', 0)).toBe('re');
    expect(tierForPrice('llm', 0)).toBe('re');
  });

  it('boundary values are inclusive on the lower edge of each band', () => {
    expect(tierForPrice('image', 0.05)).toBe('xin');
    expect(tierForPrice('image', 0.01)).toBe('kha');
    expect(tierForPrice('image', 0.0099999)).toBe('re');
  });
});
