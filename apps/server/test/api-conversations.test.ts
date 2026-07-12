/**
 * SPEC-step22.md §7 points 1-2 — conversations CRUD + POST messages (turn
 * kickoff via ChatTurnManager, via `app.inject()`). SSE streaming/replay/
 * fallback + stop need a real listening server and live in
 * api-conversations-sse.test.ts (mirrors api-runs.test.ts / api-sse.test.ts's
 * own split).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

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

interface ConversationJson {
  id: string;
  workflowId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastSeenChangeId: number | null;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('api-conversations', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-conversations-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function createConversation(): Promise<ConversationJson> {
    const res = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    expect(res.statusCode).toBe(200);
    return (res.json() as { conversation: ConversationJson }).conversation;
  }

  describe('CRUD', () => {
    it('POST creates a 1-1 empty workflow (version 0) + conversation with title ""', async () => {
      const conversation = await createConversation();
      expect(conversation.title).toBe('');
      expect(conversation.lastSeenChangeId).toBeNull();

      const wf = await app.inject({ method: 'GET', url: `/api/workflows/${conversation.workflowId}` });
      expect(wf.statusCode).toBe(200);
      expect(wf.json()).toMatchObject({ id: conversation.workflowId, nodes: [], edges: [] });
    });

    it('GET list + search by title', async () => {
      const a = await createConversation();
      await app.inject({ method: 'PATCH', url: `/api/conversations/${a.id}`, payload: { title: 'Video quảng cáo' } });
      const b = await createConversation();
      await app.inject({ method: 'PATCH', url: `/api/conversations/${b.id}`, payload: { title: 'Podcast intro' } });

      const all = await app.inject({ method: 'GET', url: '/api/conversations' });
      expect(all.statusCode).toBe(200);
      expect((all.json() as { conversations: unknown[] }).conversations).toHaveLength(2);

      const filtered = await app.inject({ method: 'GET', url: '/api/conversations?search=video' });
      expect(filtered.statusCode).toBe(200);
      const list = (filtered.json() as { conversations: Array<{ id: string }> }).conversations;
      expect(list.map((c) => c.id)).toEqual([a.id]);
    });

    it('GET :id returns conversation + messages + workflow + version; 404 for unknown id', async () => {
      const conv = await createConversation();
      const res = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        conversation: ConversationJson;
        messages: unknown[];
        workflow: { id: string };
        version: number;
      };
      expect(body.conversation.id).toBe(conv.id);
      expect(body.messages).toEqual([]);
      expect(body.workflow.id).toBe(conv.workflowId);
      expect(body.version).toBe(0);

      const missing = await app.inject({ method: 'GET', url: '/api/conversations/does-not-exist' });
      expect(missing.statusCode).toBe(404);
    });

    it('PATCH renames, validates title length (1-120); 404 for unknown id', async () => {
      const conv = await createConversation();
      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${conv.id}`,
        payload: { title: 'Tên mới' },
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { conversation: ConversationJson }).conversation.title).toBe('Tên mới');

      const empty = await app.inject({ method: 'PATCH', url: `/api/conversations/${conv.id}`, payload: { title: '' } });
      expect(empty.statusCode).toBe(400);

      const tooLong = await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${conv.id}`,
        payload: { title: 'x'.repeat(121) },
      });
      expect(tooLong.statusCode).toBe(400);

      const missing = await app.inject({
        method: 'PATCH',
        url: '/api/conversations/does-not-exist',
        payload: { title: 'x' },
      });
      expect(missing.statusCode).toBe(404);
    });

    it('DELETE cascades messages/changes/workflow; 404 if missing', async () => {
      const conv = await createConversation();

      globalThis.fetch = vi.fn(async () =>
        chatResponse(JSON.stringify({ reply: 'ok', ops: [] })),
      ) as unknown as typeof fetch;
      const msg = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content: 'hi' },
      });
      expect(msg.statusCode).toBe(202);
      await wait(20); // let the (mocked, near-instant) turn finish writing its rows

      const del = await app.inject({ method: 'DELETE', url: `/api/conversations/${conv.id}` });
      expect(del.statusCode).toBe(204);

      expect((await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/workflows/${conv.workflowId}` })).statusCode).toBe(404);

      const missing = await app.inject({ method: 'DELETE', url: '/api/conversations/does-not-exist' });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('POST /api/conversations/:id/messages', () => {
    it('202 with real message ids that round-trip through GET :id', async () => {
      const conv = await createConversation();
      globalThis.fetch = vi.fn(async () =>
        chatResponse(JSON.stringify({ reply: 'Đã tạo.', ops: [] })),
      ) as unknown as typeof fetch;

      const res = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content: 'Tạo giúp mình 1 workflow' },
      });
      expect(res.statusCode).toBe(202);
      const { userMessageId, assistantMessageId } = res.json() as {
        userMessageId: string;
        assistantMessageId: string;
      };
      expect(typeof userMessageId).toBe('string');
      expect(typeof assistantMessageId).toBe('string');
      expect(userMessageId).not.toBe(assistantMessageId);

      await wait(20);
      const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
      const messages = (detail.json() as { messages: Array<{ id: string }> }).messages;
      expect(messages.map((m) => m.id).sort()).toEqual([assistantMessageId, userMessageId].sort());
    });

    it('sets title from the first 8 words (<=60 chars) only when title is currently ""', async () => {
      const conv = await createConversation();
      globalThis.fetch = vi.fn(async () =>
        chatResponse(JSON.stringify({ reply: 'ok', ops: [] })),
      ) as unknown as typeof fetch;

      const content = 'một hai ba bốn năm sáu bảy tám chín mười';
      const expectedTitle = content.split(/\s+/).slice(0, 8).join(' ');
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content },
      });
      const after1 = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
      const title1 = (after1.json() as { conversation: ConversationJson }).conversation.title;
      expect(title1).toBe(expectedTitle);

      await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content: 'tin nhắn thứ hai không được đổi title' },
      });
      const after2 = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
      expect((after2.json() as { conversation: ConversationJson }).conversation.title).toBe(title1);
    });

    it('404 for an unknown conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/conversations/does-not-exist/messages',
        payload: { content: 'hi' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400 for empty content', async () => {
      const conv = await createConversation();
      const res = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('409 turn-in-progress when a turn is already running for that conversation', async () => {
      const conv = await createConversation();
      // Never resolves -- the LLM call is permanently in flight.
      globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

      const first = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content: 'đầu tiên' },
      });
      expect(first.statusCode).toBe(202);

      const second = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        payload: { content: 'thứ hai' },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'turn-in-progress' });
    });
  });
});
