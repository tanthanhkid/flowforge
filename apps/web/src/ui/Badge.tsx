/**
 * SPEC-step18.md §3 — small mono chip with a 2px black border (status
 * badges, type tags, model-tier markers…). Background color is a prop
 * rather than a variant enum because callers need arbitrary hex (category
 * colors from portColors.ts, status colors from statusColors.ts) — same
 * "hex thô" pattern those two modules already use for React Flow's inline
 * `style`.
 */
import type { ReactNode } from 'react';

export interface BadgeProps {
  children: ReactNode;
  /** Background color — CSS color string (hex, `var(--color-*)`…). Defaults to paper (white). */
  color?: string;
  /** Text color — defaults to ink (black); pass e.g. `#FFFFFF` for a dark background. */
  textColor?: string;
  className?: string;
}

export function Badge({ children, color = '#FFFFFF', textColor = '#0D0D0D', className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 border-2 border-ink px-1.5 py-0.5 font-mono-data text-[11px] font-bold leading-none ${className}`}
      style={{ backgroundColor: color, color: textColor }}
    >
      {children}
    </span>
  );
}
