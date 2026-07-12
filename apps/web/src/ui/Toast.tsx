/**
 * SPEC-step27.md §6 — a minimal toast primitive: bottom-right stack, paper
 * surface + 2px ink border + hard shadow (matches every other `ui/`
 * primitive's neo-brutalist chrome), auto-dismiss after 4s, `info|error`
 * variant. Callable from anywhere (store modules included — `manualLog.ts`
 * calls `toast()` outside of any React render) via a tiny module-level
 * Zustand store rather than a React context, since there's no natural
 * provider to hang a context off of at the call sites that need it.
 */
import { create } from 'zustand';

export type ToastVariant = 'info' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastState {
  toasts: ToastItem[];
  push(message: string, variant: ToastVariant): void;
  dismiss(id: number): void;
}

/** How long a toast stays up before auto-dismissing (spec §6: "tự ẩn 4s"). */
const TOAST_DURATION_MS = 4000;

let nextToastId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push(message, variant) {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts, { id, message, variant }] }));
    setTimeout(() => get().dismiss(id), TOAST_DURATION_MS);
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Module-level helper (spec §6) — the one function non-component code (store modules) calls; components could equally call `useToastStore.getState().push(...)` but this reads better at call sites. */
export function toast(message: string, variant: ToastVariant = 'info'): void {
  useToastStore.getState().push(message, variant);
}

/** Mounted once, globally (App.tsx) — renders whatever `toast()` has queued regardless of which pane/tab is currently active. */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div data-testid="toast-host" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          data-variant={t.variant}
          role="status"
          className={`pointer-events-auto border-2 border-ink px-3 py-2 text-xs font-bold shadow-hard-3 ${
            t.variant === 'error' ? 'bg-status-error text-paper' : 'bg-paper text-ink'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Đóng thông báo"
              className="shrink-0 font-bold leading-none"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
