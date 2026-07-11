/**
 * SPEC-step18.md §3 — shared neo-brutalist button. Thin wrapper around a
 * native `<button>` (spreads the rest of `ButtonHTMLAttributes` straight
 * through, so existing call sites keep `data-testid`, `title`,
 * `aria-pressed`, `disabled`, `onClick`, `type`, etc. unchanged when they
 * migrate to this component).
 *
 * Variants (spec §3):
 *  - `primary`   — nền accent vàng, chữ đen.
 *  - `secondary` — nền trắng, chữ đen. Default (matches most existing
 *    hand-rolled toolbar buttons today).
 *  - `ghost`     — viền nét đứt, nền cream.
 *  - `ai`        — nền hồng (cat-video), chữ ĐEN — spec explicitly calls out
 *    that white-on-pink fails AA contrast, unlike the mockup's white text.
 *  - `danger`    — nền trắng chữ đỏ; hover đảo thành nền đỏ chữ trắng
 *    (white-on-red passes AA per spec §6.3).
 *
 * Shared interaction language: 2px black border, 0 border-radius, hard
 * (non-blurred) drop shadow that grows on hover as the button "lifts" and
 * disappears on active as it "presses down"; disabled buttons get neither.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'ai' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-ink',
  secondary: 'bg-paper text-ink',
  ghost: 'border-dashed bg-bg text-ink',
  ai: 'bg-cat-video text-ink',
  danger: 'bg-paper text-status-error hover:bg-status-error hover:text-paper',
};

const BASE_CLASSES =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-2 border-ink px-3 py-1.5 ' +
  'text-xs font-bold uppercase tracking-wide rounded-none shadow-hard-3 transition-transform duration-100 ' +
  // SPEC-step18.md §6.4: hover/active translate is a decorative micro-
  // interaction that must be OFF (not just instant) under
  // prefers-reduced-motion — `motion-safe:` scopes it to
  // `(prefers-reduced-motion: no-preference)` so a reduced-motion user's
  // button never moves at all, rather than just moving without a transition.
  'motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5 hover:shadow-hard-5 ' +
  'motion-safe:active:translate-x-0.5 motion-safe:active:translate-y-0.5 active:shadow-none ' +
  'disabled:pointer-events-none disabled:opacity-50';

export function Button({ variant = 'secondary', className = '', type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={`${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${className}`} {...rest} />
  );
}
