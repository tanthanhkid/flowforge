import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionContext } from './types.js';

export interface PollOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  timeoutMs?: number;
}

const POLL_DEFAULTS: Required<PollOptions> = {
  initialDelayMs: 1000,
  maxDelayMs: 10_000,
  factor: 1.5,
  timeoutMs: 300_000,
};

/** setTimeout wrapper that resolves early (rejecting) on abort. Keeps the process alive
 * (no unref) — a run that is actively polling must not let a standalone script/runner
 * exit early just because the event loop looks empty otherwise. */
function sleepCancelable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Generic async poll loop with exponential backoff.
 * delay(n) = min(initialDelayMs * factor^n, maxDelayMs), n = 0, 1, 2, ...
 */
export async function poll<T>(
  check: () => Promise<{ done: boolean; value?: T }>,
  signal: AbortSignal,
  opts?: PollOptions,
): Promise<T> {
  const { initialDelayMs, maxDelayMs, factor, timeoutMs } = { ...POLL_DEFAULTS, ...opts };
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    if (signal.aborted) throw new Error('aborted');
    if (Date.now() >= deadline) throw new Error(`poll timeout after ${timeoutMs}ms`);

    const result = await check();
    if (result.done) return result.value as T;

    if (signal.aborted) throw new Error('aborted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`poll timeout after ${timeoutMs}ms`);

    // Cap the backoff sleep to whatever timeout budget is left, so a timeout
    // never fires up to a full backoff delay late (previously the sleep
    // ignored the deadline entirely).
    const delay = Math.min(initialDelayMs * factor ** attempt, maxDelayMs, remaining);
    attempt += 1;

    await sleepCancelable(delay, signal);
  }
}

export interface CreateContextOptions {
  runId: string;
  nodeId: string;
  artifactsDir: string;
  signal: AbortSignal;
  onLog?: (message: string) => void;
}

/** Builds the ExecutionContext handed to a NodeDefinition.execute() call. */
export function createContext(opts: CreateContextOptions): ExecutionContext {
  const { runId, nodeId, artifactsDir, signal, onLog } = opts;

  return {
    runId,
    nodeId,
    signal,
    artifactsDir,
    log(message: string): void {
      onLog?.(message);
    },
    async saveArtifact(data: Buffer, ext: string): Promise<string> {
      await mkdir(artifactsDir, { recursive: true });
      const cleanExt = ext.replace(/^\./, '');
      const filename = `${randomUUID()}.${cleanExt}`;
      await writeFile(path.join(artifactsDir, filename), data);
      return filename;
    },
    poll<T>(check: () => Promise<{ done: boolean; value?: T }>, pollOpts?: PollOptions): Promise<T> {
      return poll(check, signal, pollOpts);
    },
  };
}
