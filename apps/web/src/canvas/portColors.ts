/**
 * Port color map + type-compatibility check (SPEC-step4.md §4). Mirrors the
 * server's `portsCompatible()` in apps/server/src/engine/schema.ts exactly:
 * equal types, or either side is `any`.
 */
import type { PortType } from '../api/types.ts';

export const PORT_COLORS: Record<PortType, string> = {
  text: '#3b82f6',
  image: '#22c55e',
  video: '#a855f7',
  audio: '#f97316',
  json: '#94a3b8',
  number: '#14b8a6',
  any: '#e5e7eb',
};

/** `any` renders with a dashed outline (spec §4) rather than a solid one. */
export const ANY_PORT_DASHED = true;

export function compatible(outType: PortType, inType: PortType): boolean {
  return outType === inType || outType === 'any' || inType === 'any';
}
