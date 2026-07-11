/**
 * Port color map + type-compatibility check (SPEC-step4.md §4). Mirrors the
 * server's `portsCompatible()` in apps/server/src/engine/schema.ts exactly:
 * equal types, or either side is `any`.
 */
import type { PortType } from '../api/types.ts';

export const PORT_COLORS: Record<PortType, string> = {
  text: '#3B5FFF',
  image: '#B6FF3B',
  video: '#FF4FA3',
  audio: '#FF6B1A',
  json: '#8B5CF6',
  number: '#00D9C0',
  any: '#0D0D0D',
};

/** `any` renders with a dashed outline (spec §4) rather than a solid one. */
export const ANY_PORT_DASHED = true;

export function compatible(outType: PortType, inType: PortType): boolean {
  return outType === inType || outType === 'any' || inType === 'any';
}
