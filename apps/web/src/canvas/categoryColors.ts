/**
 * SPEC-step18.md §1/§5.2/§5.3/§5.4 — node-category color map (neo-brutalist
 * palette), mirrored 1:1 from index.css's `--color-cat-*` tokens. Shared by
 * NodeCard (header strip), Sidebar (category bar) and FlowCanvas (MiniMap
 * `nodeColor`) — all three need the same category->color mapping, and (for
 * NodeCard/Sidebar's inline `style`, and MiniMap's canvas-painted colors)
 * raw hex rather than a Tailwind class: MiniMap paints pixels directly and
 * can't consume a className, and a Tailwind class built from a *runtime*
 * category string (`bg-cat-${category}`) wouldn't survive Tailwind's static
 * source scan anyway — same "hex thô" pattern portColors.ts/statusColors.ts
 * already use for this exact reason.
 *
 * Not in SPEC-step18.md's file list verbatim (§0.3/agent brief only names
 * portColors.ts/statusColors.ts as pre-existing) — added here because three
 * *canvas* surfaces (all owned by this agent) independently needed the same
 * category->color mapping and hand-duplicating it three times was worse than
 * one small shared module living next to portColors.ts/statusColors.ts.
 */
export type NodeCategory = 'llm' | 'image' | 'video' | 'audio' | 'utility';

export const CATEGORY_HEX: Record<string, string> = {
  llm: '#3B5FFF',
  image: '#B6FF3B',
  video: '#FF4FA3',
  audio: '#FF6B1A',
  utility: '#FFDE21',
};

/** Unknown/future categories fall back to accent yellow (black text is always safe on it). */
const FALLBACK_HEX = '#FFDE21';

export function categoryHex(category: string): string {
  return CATEGORY_HEX[category] ?? FALLBACK_HEX;
}

/**
 * SPEC-step18.md §6.3 (giám khảo, bắt buộc): "chữ trên nền bão hoà: đen trên
 * hồng/lime/vàng/cam; trắng chỉ trên cat-llm xanh (4.58:1 AA large) và nền
 * đen/đỏ". `llm`'s blue is the only category dark enough to need white text.
 */
const LIGHT_TEXT_CATEGORIES = new Set(['llm']);

export function categoryTextClass(category: string): string {
  return LIGHT_TEXT_CATEGORIES.has(category) ? 'text-white' : 'text-ink';
}
