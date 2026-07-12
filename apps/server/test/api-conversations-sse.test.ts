/**
 * SPEC-step22.md §7 points 3-4 — SSE turn streaming (happy path with instant
 * pacing, replay-after-done, DB fallback after a simulated restart, 404) and
 * stop. Needs a *real* listening server + real fetch to 127.0.0.1 (mirrors
 * api-sse.test.ts) since events genuinely arrive over separate event-loop
 * turns — `app.inject()` can't observe a hijacked response streaming live.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

interface SseEvent {
  event: string;
  data: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

function chatResponse(content: string): Response {
  return jsonResponse(200, { choices: [{ message: { content } }] });
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input);
}

/** Mocks OpenRouter's chat-completions endpoint with `handler`; every other
 * URL (in particular our own loopback server) falls through to whatever
 * `globalThis.fetch` already was — test/setup.ts's beforeEach has already
 * installed its loopback-aware guard by the time this runs. */
function mockOpenRouter(handler: () => Response | Promise<Response>): void {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (urlOf(input) === 'https://openrouter.ai/api/v1/chat/completions') {
      return handler();
    }
    return fallback(input as Parameters<typeof fetch>[0], init);
  }) as unknown as typeof fetch;
}

/** Same abort-aware shape as chat-turn.test.ts's own abort test: the signal
 * `chatCompletion` actually threads through is `AbortSignal.any([...])`
 * (lib/http.ts), which still fires 'abort' once the *original* controller
 * aborts — hanging forever otherwise is what a mock ignoring `init.signal`
 * would do, and would never let the turn resolve. */
function mockOpenRouterHang(): void {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (urlOf(input) === 'https://openrouter.ai/api/v1/chat/completions') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return fallback(input as Parameters<typeof fetch>[0], init);
  }) as unknown as typeof fetch;
}

/** Opens the SSE endpoint and returns both a promise that resolves once the
 * response headers have arrived (i.e. the server has already hijacked +
 * subscribed) and a promise for the fully-collected event list (resolves at
 * the 'done' event or `timeoutMs`). */
function openSse(url: string, timeoutMs = 5000): { started: Promise<void>; events: Promise<SseEvent[]> } {
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const events = (async (): Promise<SseEvent[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    resolveStarted();
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new Error(`SSE request failed: ${res.status}`);
    }

    const collected: SseEvent[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!chunk.trim() || chunk.startsWith(':')) continue;

          const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;

          const event = eventLine.slice('event: '.length);
          const data: unknown = JSON.parse(dataLine.slice('data: '.length));
          collected.push({ event, data });
          if (event === 'done') return collected;
        }
      }
      return collected;
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
  })();

  return { started, events };
}

async function collectSseEvents(url: string, timeoutMs = 5000): Promise<SseEvent[]> {
  return openSse(url, timeoutMs).events;
}

describe('api-conversations SSE', () => {
  let app: FastifyInstance;
  let tmp: string;
  let dbPath: string;
  let baseUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-conv-sse-'));
    dbPath = path.join(tmp, 'test.db');
    app = await buildServer({ dbPath, artifactsDir: tmp, chatTurnPaceMs: () => 0 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function createConversation(): Promise<{ id: string; workflowId: string }> {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json()) as { conversation: { id: string; workflowId: string } };
    return body.conversation;
  }

  async function postMessage(conversationId: string, content: string): Promise<{ assistantMessageId: string }> {
    const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(202);
    return (await res.json()) as { assistantMessageId: string };
  }

  it('streams thinking -> patch-op xN -> message -> done, then replays the identical sequence on reconnect', async () => {
    const conversation = await createConversation();
    const ops = [
      { op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'hi' } } },
      { op: 'add-node', node: { id: 'n2', type: 'output.collect', params: {} } },
      { op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'in1' } } },
    ];
    mockOpenRouter(() => chatResponse(JSON.stringify({ reply: 'Đã tạo workflow.', ops })));

    const { assistantMessageId } = await postMessage(conversation.id, 'Tạo giúp mình 1 workflow');
    const events = await collectSseEvents(
      `${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`,
    );

    expect(events[0]?.event).toBe('thinking');
    const patchOps = events.filter((e) => e.event === 'patch-op');
    expect(patchOps.map((e) => (e.data as { index: number }).index)).toEqual([0, 1, 2]);
    expect(patchOps.every((e) => (e.data as { total: number }).total === 3)).toBe(true);

    expect(events.at(-2)?.event).toBe('message');
    const messageData = events.at(-2)?.data as {
      content: string;
      workflow: { nodes: unknown[] };
      changeId: number | null;
    };
    expect(messageData.content).toBe('Đã tạo workflow.');
    expect(messageData.workflow.nodes).toHaveLength(2);
    expect(messageData.changeId).not.toBeNull();

    expect(events.at(-1)?.event).toBe('done');

    // Reconnecting after the turn is fully done must yield the exact same
    // sequence again, replayed from the manager's buffer.
    const replay = await collectSseEvents(
      `${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`,
    );
    expect(replay).toEqual(events);
  });

  it('falls back to the messages table when a fresh manager (simulated restart) does not know the turn', async () => {
    const conversation = await createConversation();
    mockOpenRouter(() => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));

    const { assistantMessageId } = await postMessage(conversation.id, 'chỉ hỏi thôi');
    // Drain this turn's own SSE stream so it's fully done before "restarting".
    await collectSseEvents(`${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`);

    await app.close();

    // Simulated restart: a brand-new process/manager backed by the same db file.
    app = await buildServer({ dbPath, artifactsDir: tmp, chatTurnPaceMs: () => 0 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const events = await collectSseEvents(
      `${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`,
    );
    expect(events.map((e) => e.event)).toEqual(['message', 'done']);
    expect((events[0]?.data as { content: string }).content).toBe('ok');
  });

  it('404 for an unknown assistantMessageId', async () => {
    const conversation = await createConversation();
    const res = await fetch(`${baseUrl}/api/conversations/${conversation.id}/turns/does-not-exist/events`);
    expect(res.status).toBe(404);
  });

  it('stop aborts an in-flight turn: {stopped:true}, SSE gets error+done, message ends up status=error; stopping again -> {stopped:false}', async () => {
    const conversation = await createConversation();
    mockOpenRouterHang();

    const { assistantMessageId } = await postMessage(conversation.id, 'treo mãi');

    const { started, events: eventsPromise } = openSse(
      `${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`,
    );
    await started; // the SSE GET has hijacked + subscribed server-side by now

    const stopRes = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/messages/${assistantMessageId}/stop`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(stopRes.status).toBe(200);
    expect(await stopRes.json()).toEqual({ stopped: true });

    const events = await eventsPromise;
    expect(events.map((e) => e.event)).toEqual(['thinking', 'error', 'done']);
    expect((events[1]?.data as { message: string }).message).toBe('Đã dừng theo yêu cầu');

    const detail = await fetch(`${baseUrl}/api/conversations/${conversation.id}`);
    const detailBody = (await detail.json()) as { messages: Array<{ id: string; status: string; error?: string }> };
    const assistantMsg = detailBody.messages.find((m) => m.id === assistantMessageId)!;
    expect(assistantMsg.status).toBe('error');
    expect(assistantMsg.error).toBe('Đã dừng theo yêu cầu');

    const stopAgain = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/messages/${assistantMessageId}/stop`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(await stopAgain.json()).toEqual({ stopped: false });
  });
});
