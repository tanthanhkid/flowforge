/**
 * Small fetch wrapper shared by every provider client (SPEC-step2.md §3):
 * JSON requests with timeout + retry, binary downloads, and a uniform
 * HttpError shape. NEVER include header values (Authorization, App-Id, ...)
 * in thrown error messages or logs — only the request method/url and a
 * short response-body snippet.
 */

export class HttpError extends Error {
  readonly status?: number;
  readonly url: string;
  readonly bodySnippet?: string;

  constructor(message: string, opts: { status?: number; url: string; bodySnippet?: string }) {
    super(message);
    this.name = 'HttpError';
    this.status = opts.status;
    this.url = opts.url;
    this.bodySnippet = opts.bodySnippet;
  }
}

export interface RequestJsonOpts {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** default 60_000 */
  timeoutMs?: number;
  /** default 2 (up to 3 attempts total) */
  retries?: number;
  /** base delay in ms; delay(attempt) = retryDelayMs * 2 ** attempt; default 500 */
  retryDelayMs?: number;
  signal?: AbortSignal;
  /**
   * Whether a plain network error / timeout (i.e. NOT an HttpError with a
   * retryable status) should be retried. Default true. Set to false for
   * non-idempotent requests (e.g. a queue-job submit) where the request may
   * have reached the server and been enqueued even though the client never
   * saw the response — retrying in that case risks creating (and billing)
   * duplicate jobs. HttpError with a retryable status (408/429/5xx) is
   * unaffected by this flag: that status means the server itself rejected
   * the request, so no job was created.
   */
  retryOnNetworkError?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const BODY_SNIPPET_MAX_LEN = 300;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function makeAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// Intentionally NOT unref()'d: unlike ctx.poll()'s potentially multi-minute
// backoff (which shouldn't block a long-running server's shutdown), this is
// a short (sub-few-second) delay for an in-flight request the caller is
// actively awaiting. Unref'ing it let the process exit early — silently
// abandoning the retry — whenever nothing else happened to be keeping the
// event loop alive (verified: a bare-script retry-delay this way never
// fires and Node reports "Detected unsettled top-level await").
//
// `signal` (when given) makes the wait abort-aware: a caller cancellation
// (e.g. run cancel) rejects immediately instead of waiting out the full
// backoff delay, so cancellation isn't needlessly delayed by up to
// `retryDelayMs * 2 ** attempt` per in-flight retry.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Generic retry loop.
 *
 * Retryable: HttpError with a retryable status (408/429/5xx); any other
 * error (network failure, timeout) only when `retryOnNetworkError` isn't
 * `false`.
 *
 * NOT retryable, regardless of the above: the caller's own AbortSignal
 * (`opts.signal`) having fired — a deliberate cancellation should fail fast,
 * not be retried. Detected both via `opts.signal.aborted` and via the
 * error's `name === 'AbortError'` (fetchWithTimeout only produces the latter
 * for an *external*-signal abort; its own internal timeout abort is always
 * converted to a plain timeout Error before it gets here).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; retryDelayMs: number; signal?: AbortSignal; retryOnNetworkError?: boolean },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const callerAborted = opts.signal?.aborted === true || isAbortError(err);
      const retryable =
        !callerAborted &&
        (err instanceof HttpError ? isRetryableStatus(err.status ?? 0) : opts.retryOnNetworkError !== false);
      if (!retryable || attempt >= opts.retries) throw err;
      await sleep(opts.retryDelayMs * 2 ** attempt, opts.signal);
    }
  }
  // Unreachable (loop always returns or throws), but keeps TS happy.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function readBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, BODY_SNIPPET_MAX_LEN);
  } catch {
    return '';
  }
}

/**
 * fetch() with a timeout (AbortSignal-based), optionally combined with a
 * caller-supplied signal. The timeout stays armed for the *entire* call,
 * including `consume(res)` (reading the response body) — not just until
 * headers arrive — so a request whose headers land instantly but whose body
 * then stalls (e.g. a huge fal.ai video download interrupted mid-transfer)
 * is still aborted at `timeoutMs` instead of hanging forever. Aborting the
 * shared signal while a body read (json()/arrayBuffer()) is in flight
 * rejects that read, which is caught here and turned into the same "timeout
 * ... url" error as a headers-phase timeout.
 */
async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (res: Response) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutController.signal]) : timeoutController.signal;

  try {
    const res = await fetch(url, { ...init, signal });
    return await consume(res);
  } catch (err) {
    if (timeoutController.signal.aborted) {
      const method = init.method ?? 'GET';
      throw new Error(`Request timeout after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function httpErrorFor(method: string, url: string, status: number, bodySnippet: string): HttpError {
  return new HttpError(`${method} ${url} failed: HTTP ${status} — ${bodySnippet}`, { status, url, bodySnippet });
}

export async function requestJson<T = any>(opts: RequestJsonOpts): Promise<{ status: number; json: T }> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const init: RequestInit = {
    method,
    headers: opts.headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };

  return withRetry(
    () =>
      fetchWithTimeout(
        opts.url,
        init,
        timeoutMs,
        async (res) => {
          if (!res.ok) {
            const bodySnippet = await readBodySnippet(res);
            throw httpErrorFor(method, opts.url, res.status, bodySnippet);
          }
          const json = (await res.json()) as T;
          return { status: res.status, json };
        },
        opts.signal,
      ),
    { retries, retryDelayMs, signal: opts.signal, retryOnNetworkError: opts.retryOnNetworkError },
  );
}

export async function downloadBinary(
  url: string,
  opts?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    retryOnNetworkError?: boolean;
  },
): Promise<{ data: Buffer; contentType?: string }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  return withRetry(
    () =>
      fetchWithTimeout(
        url,
        { method: 'GET', headers: opts?.headers },
        timeoutMs,
        async (res) => {
          if (!res.ok) {
            const bodySnippet = await readBodySnippet(res);
            throw httpErrorFor('GET', url, res.status, bodySnippet);
          }
          const arrayBuffer = await res.arrayBuffer();
          const contentType = res.headers.get('content-type') ?? undefined;
          return { data: Buffer.from(arrayBuffer), contentType };
        },
        opts?.signal,
      ),
    {
      retries: DEFAULT_RETRIES,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      signal: opts?.signal,
      retryOnNetworkError: opts?.retryOnNetworkError,
    },
  );
}
