/**
 * SPEC-step18.md §1 — node run-status color map (neo-brutalist palette),
 * mirrored 1:1 from index.css's `--color-status-*` tokens. React Flow node
 * badges/borders need raw hex (inline `style`, not Tailwind classes), so
 * this stays a plain TS map rather than a set of utility classes.
 *
 * Six states: the 5 `NodeState` values (api/types.ts) plus `cached` — a
 * `NodeRunUiState.cached` boolean flag layered on top of `success`, not a
 * `NodeState` itself, but still one of the "6 trạng thái" badges the spec
 * calls for (⚡ cached stamp, spec §5.3).
 */
export type StatusColorKey = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'cached';

export const STATUS_COLORS: Record<StatusColorKey, string> = {
  pending: '#C9C4B4',
  running: '#FFDE21',
  success: '#B6FF3B',
  error: '#FF3B3B',
  skipped: '#C9C4B4',
  cached: '#3B5FFF',
};
