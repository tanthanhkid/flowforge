/**
 * SPEC-step2.md §9 — http.test.ts. All fetch calls are mocked; nothing here
 * touches the real network or any real secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBinary, HttpError, requestJson } from '../src/lib/http.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

describe('requestJson — retry behavior', () => {
  it('retries on 429 then succeeds on the 3rd attempt', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call <= 2) return jsonResponse(429, { error: 'rate limited' });
      return jsonResponse(200, { ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { status, json } = await requestJson<{ ok: boolean }>({
      url: 'https://example.test/thing',
      retryDelayMs: 1,
    });

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a plain 400', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'bad request' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(requestJson({ url: 'https://example.test/thing', retryDelayMs: 1 })).rejects.toThrow(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries and throws the last error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: 'down' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(requestJson({ url: 'https://example.test/thing', retries: 2, retryDelayMs: 1 })).rejects.toThrow(
      HttpError,
    );
    // 1 initial attempt + 2 retries = 3 total.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('requestJson — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a message containing "timeout" and the url once timeoutMs elapses', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = requestJson({
      url: 'https://example.test/hangs',
      timeoutMs: 50,
      retries: 0,
    });

    let caught: unknown;
    const settle = promise.catch((err) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(60);
    await settle;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timeout/i);
    expect((caught as Error).message).toContain('https://example.test/hangs');
  });
});

describe('requestJson — HttpError shape and secret redaction', () => {
  it('HttpError carries status and a bodySnippet', async () => {
    globalThis.fetch = vi.fn(async () => textResponse(404, 'Not Found: no such resource')) as unknown as typeof fetch;

    try {
      await requestJson({ url: 'https://example.test/missing', retries: 0 });
      throw new Error('expected requestJson to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(404);
      expect(httpErr.bodySnippet).toContain('Not Found');
      expect(httpErr.url).toBe('https://example.test/missing');
    }
  });

  it('never leaks an Authorization header value into the error message', async () => {
    const secret = 'sk-super-secret-token-value-should-not-leak';
    globalThis.fetch = vi.fn(async () => textResponse(401, 'unauthorized')) as unknown as typeof fetch;

    try {
      await requestJson({
        url: 'https://example.test/protected',
        headers: { Authorization: `Bearer ${secret}` },
        retries: 0,
      });
      throw new Error('expected requestJson to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(secret);
    }
  });
});

describe('requestJson / downloadBinary — timeout stays armed across body consumption (not just headers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('downloadBinary rejects with a timeout error instead of hanging when headers arrive instantly but the body stalls', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null } as unknown as Headers,
        text: async () => '',
        // Never resolves on its own — only when the request's (combined)
        // AbortSignal fires, mirroring how a real stalled-body fetch behaves
        // once the shared signal is aborted mid-transfer.
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = downloadBinary('https://example.test/stalled-body', {
      timeoutMs: 50,
      retryOnNetworkError: false, // isolate to a single attempt
    });
    let caught: unknown;
    let settled = false;
    const settle = promise
      .catch((err) => {
        caught = err;
      })
      .finally(() => {
        settled = true;
      });

    // Headers "arrived" (fetch() resolved) well before timeoutMs — prove
    // that alone doesn't satisfy the call.
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    await settle;

    expect(settled).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timeout/i);
    expect((caught as Error).message).toContain('https://example.test/stalled-body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('requestJson — caller cancellation (AbortSignal) is not retried', () => {
  it('fails fast on a single attempt (no retry) when the caller aborts an in-flight request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = requestJson({
      url: 'https://example.test/cancel-me',
      signal: controller.signal,
      retries: 2,
      retryDelayMs: 500,
    });
    let caught: unknown;
    const settle = promise.catch((err) => {
      caught = err;
    });

    controller.abort();
    await settle;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AbortError');
  });

  it('does not wait out the full inter-retry delay when the caller cancels while a retry is pending', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let callCount = 0;
      const fetchMock = vi.fn(async () => {
        callCount += 1;
        return jsonResponse(500, { error: 'down' });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = requestJson({
        url: 'https://example.test/retry-then-cancel',
        signal: controller.signal,
        retries: 3,
        retryDelayMs: 10_000, // huge — if the retry sleep weren't abort-aware, this would hang.
      });
      let caught: unknown;
      let settled = false;
      const settle = promise
        .catch((err) => {
          caught = err;
        })
        .finally(() => {
          settled = true;
        });

      // Let the first (failed, retryable) attempt run and enter its
      // retry-delay sleep.
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);
      expect(settled).toBe(false);

      controller.abort();
      await settle;

      expect(settled).toBe(true);
      expect(callCount).toBe(1); // the pending retry never actually re-fetched
      expect(caught).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('downloadBinary', () => {
  it('returns the response body as a Buffer plus contentType', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
      headers: { get: (key: string) => (key.toLowerCase() === 'content-type' ? 'image/png' : null) } as unknown as Headers,
      text: async () => '',
    })) as unknown as typeof fetch;

    const { data, contentType } = await downloadBinary('https://example.test/file.png');
    expect(contentType).toBe('image/png');
    expect(Buffer.from(bytes).equals(data)).toBe(true);
  });

  it('throws HttpError on a non-2xx response', async () => {
    // downloadBinary() doesn't expose retries/retryDelayMs (matches the
    // spec'd public signature), and 500 is retryable, so this exercises the
    // real (fixed) retry delays — fake timers keep it fast.
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(async () => textResponse(500, 'server error')) as unknown as typeof fetch;
      const promise = downloadBinary('https://example.test/file.png', { timeoutMs: 5000 });
      let caught: unknown;
      const settle = promise.catch((err) => {
        caught = err;
      });
      await vi.advanceTimersByTimeAsync(5000);
      await settle;
      expect(caught).toBeInstanceOf(HttpError);
    } finally {
      vi.useRealTimers();
    }
  });
});
