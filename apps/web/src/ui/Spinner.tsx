/**
 * SPEC-step18.md §3 — shared "◐" spinner, replacing the 3 duplicated
 * hand-rolled `animate-spin` half-circles (Toolbar Save/Run/Describe
 * buttons). Uses the `ff-spin` keyframe declared in index.css, which is
 * neutralized by the global `prefers-reduced-motion: reduce` rule there.
 */
export interface SpinnerProps {
  className?: string;
  /** Accessible label for the `role="status"` element. */
  label?: string;
}

export function Spinner({ className = '', label = 'Đang xử lý' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-block leading-none ${className}`}
      style={{ animation: 'ff-spin 0.9s linear infinite' }}
    >
      ◐
    </span>
  );
}
