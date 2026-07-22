/**
 * `GateRegistry` (SPEC-step33.md §33c) — the in-process "parking lot" that
 * lets a node's `execute()` suspend at `ctx.awaitApproval(payload)` until a
 * human resolves it via `POST /api/runs/:id/resume` (routed through
 * `RunManager.resolveGate` → here), the run is aborted (`RunOptions.signal`),
 * or a timeout elapses. Deliberately NOT persisted to the DB — a server
 * restart while a run sits `awaiting` orphans it (documented nợ in
 * SPEC-step33.md §33c: "server restart khi đang awaiting → run mồ côi ở
 * running, resume trả 409"). One `GateRegistry` instance is shared by the
 * `Engine` (registers/parks) and `RunManager` (resolves/rejects from the
 * HTTP layer) — see `server.ts` for the wiring.
 */

interface PendingGate {
  resolve(value: unknown): void;
  reject(err: Error): void;
  cleanup(): void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 phút

function gateKey(runId: string, nodeId: string): string {
  return `${runId}::${nodeId}`;
}

export class GateRegistry {
  private readonly pending = new Map<string, PendingGate>();

  /**
   * Parks until `resolve()`/`reject()` is called for this (runId, nodeId),
   * the run's `signal` aborts, or `timeoutMs` elapses (default 30 min).
   * `payload` isn't used here — it's what the caller (executor.ts) already
   * persisted/emitted as `pendingApproval` before calling this; kept as a
   * parameter anyway so the registry's own call site self-documents what's
   * being awaited, and to allow a future consumer to read it back off the
   * registry rather than the run store.
   */
  register(
    runId: string,
    nodeId: string,
    payload: unknown,
    signal: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    void payload;
    const key = gateKey(runId, nodeId);
    if (this.pending.has(key)) {
      throw new Error(`GateRegistry: đã có gate đang chờ cho ${key}`);
    }

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      let settled = false;

      const onAbort = (): void => {
        settle(() => rejectPromise(new Error('aborted')));
      };

      const timer = setTimeout(() => {
        settle(() => rejectPromise(new Error(`GateRegistry: hết thời gian chờ duyệt (${timeoutMs}ms)`)));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(key);
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      if (signal.aborted) {
        settle(() => rejectPromise(new Error('aborted')));
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(key, {
        resolve: (value) => settle(() => resolvePromise(value)),
        reject: (err) => settle(() => rejectPromise(err)),
        cleanup,
      });
    });
  }

  /** Resolves a pending gate with (possibly edited) `value`. Returns false if there was no pending gate. */
  resolve(runId: string, nodeId: string, value: unknown): boolean {
    const key = gateKey(runId, nodeId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    entry.resolve(value);
    return true;
  }

  /** Rejects a pending gate with `err`. Returns false if there was no pending gate. */
  reject(runId: string, nodeId: string, err: Error): boolean {
    const key = gateKey(runId, nodeId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    entry.reject(err);
    return true;
  }

  hasPending(runId: string, nodeId: string): boolean {
    return this.pending.has(gateKey(runId, nodeId));
  }
}
