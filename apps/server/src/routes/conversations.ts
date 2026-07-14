/**
 * Conversation + chat-turn HTTP routes (SPEC-step22.md §4): CRUD over
 * `conversations`, the SSE endpoint that streams `ChatTurnManager`'s events
 * for a single turn, and the stop endpoint. The run/SSE lifecycle here
 * mirrors routes/runs.ts's hijack pattern; the difference is
 * `ChatTurnManager.subscribe()` replays a buffer (so a late/reconnecting
 * client never misses events) whereas `RunManager.subscribe()` has no
 * buffer at all (`routes/runs.ts` sends its own one-shot `snapshot` instead).
 */
import type { OutgoingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationNotFoundError } from '../agent/chatTurn.js';
import type { PatchOp } from '../agent/patch.js';
import type { ChatTurnManager, ChatTurnSseEvent } from '../chatTurnManager.js';
import { TurnInProgressError } from '../chatTurnManager.js';
import type { ChangesRepo } from '../db/changes.js';
import type { ConversationsRepo } from '../db/conversations.js';
import type { Message } from '../db/messages.js';
import type { MessagesRepo } from '../db/messages.js';
import type { WorkflowsRepo } from '../db/workflows.js';
import { emptyWorkflow } from '../engine/schema.js';

export interface ConversationsRouteDeps {
  conversationsRepo: ConversationsRepo;
  messagesRepo: MessagesRepo;
  workflowsRepo: WorkflowsRepo;
  chatTurnManager: ChatTurnManager;
  /** SPEC-step32.md B2 — needed by `GET /:id` to join each message's
   * `changeId` against `workflow_changes` and count its ops into a `diff`. */
  changesRepo: ChangesRepo;
}

/** SPEC-step32.md B2 — mirrors apps/web/src/api/types.ts's `ChatDiffCounts`
 * shape exactly (hand-mirrored, same "no shared package for this yet"
 * situation as every other FE/BE type pair in this route file's neighbours). */
interface ChatDiffCounts {
  addNode: number;
  removeNode: number;
  updateNode: number;
  addEdge: number;
  removeEdge: number;
  moveNode: number;
}

/** Tallies a change row's `ops` by kind — the `diff` chip's raw counts. */
function countOpsByKind(ops: PatchOp[]): ChatDiffCounts {
  const counts: ChatDiffCounts = {
    addNode: 0,
    removeNode: 0,
    updateNode: 0,
    addEdge: 0,
    removeEdge: 0,
    moveNode: 0,
  };
  for (const op of ops) {
    switch (op.op) {
      case 'add-node':
        counts.addNode++;
        break;
      case 'remove-node':
        counts.removeNode++;
        break;
      case 'update-node':
        counts.updateNode++;
        break;
      case 'add-edge':
        counts.addEdge++;
        break;
      case 'remove-edge':
        counts.removeEdge++;
        break;
      case 'move-node':
        counts.moveNode++;
        break;
    }
  }
  return counts;
}

/**
 * SPEC-step32.md B2 — reload path for the diff chip: a message only gets a
 * `diff` key when it has a `changeId` AND that change row still exists
 * (defensive — every `changeId` on a message is written by the same turn
 * that created the change row, so in practice it always resolves); every
 * other message is returned untouched (no `diff` key at all, matching the
 * live/`onPatchOp` path's optional `ChatMessage['diff']` field).
 */
function withDiff(message: Message, changesRepo: ChangesRepo): Message & { diff?: ChatDiffCounts } {
  if (message.changeId === undefined) return message;
  const change = changesRepo.get(message.changeId);
  if (!change) return message;
  return { ...message, diff: countOpsByKind(change.ops as PatchOp[]) };
}

const TitleSchema = z.object({ title: z.string().min(1).max(120) });

/**
 * SPEC-step32.md B1 — same `uploads/<uuid>.<ext>` shape `routes/upload.ts`
 * hands back (only the 4 image extensions it can produce for an `image`-kind
 * upload), matched against the WHOLE string so a value like
 * `uploads/../../etc/passwd.png` can't sneak through: the character class
 * between the literal `uploads/` prefix and the extension has no `/`, so
 * there is no way to spell a path-traversal segment inside it at all — same
 * traversal-proofing philosophy as `routes/artifacts.ts`'s serve route.
 */
const MessageAttachmentSchema = z.object({
  path: z.string().regex(/^uploads\/[A-Za-z0-9.-]+\.(png|jpe?g|webp|gif)$/),
  filename: z.string().optional(),
  mime: z.string().optional(),
});

const MessageBodySchema = z.object({
  content: z.string().min(1),
  attachments: z.array(MessageAttachmentSchema).max(3).optional(),
});

const HEARTBEAT_MS = 15_000;

/** SPEC-step22.md §4.6 — first 8 words of `content`, then hard-capped at 60
 * chars (not re-trimmed to a whole word after that cut). */
function autoTitle(content: string): string {
  const words = content
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 8)
    .join(' ');
  return words.length > 60 ? words.slice(0, 60) : words;
}

export function registerConversationsRoutes(app: FastifyInstance, deps: ConversationsRouteDeps): void {
  const { conversationsRepo, messagesRepo, workflowsRepo, chatTurnManager, changesRepo } = deps;

  app.post('/api/conversations', async (_request, reply) => {
    const workflowId = randomUUID();
    workflowsRepo.create(emptyWorkflow(workflowId, 'Workflow mới'));
    const conversation = conversationsRepo.create({ id: randomUUID(), workflowId, title: '' });
    reply.code(200).send({ conversation });
  });

  app.get('/api/conversations', async (request) => {
    const { search } = request.query as { search?: string };
    return { conversations: conversationsRepo.list(search) };
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = conversationsRepo.get(id);
    if (!conversation) {
      reply.code(404).send({ error: `Conversation "${id}" not found` });
      return;
    }
    const wfv = workflowsRepo.getWithVersion(conversation.workflowId);
    reply.send({
      conversation,
      messages: messagesRepo.listByConversation(id).map((m) => withDiff(m, changesRepo)),
      workflow: wfv?.workflow,
      version: wfv?.version,
    });
  });

  app.patch('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!conversationsRepo.get(id)) {
      reply.code(404).send({ error: `Conversation "${id}" not found` });
      return;
    }
    const parsed = TitleSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'title is required (string, 1-120 characters)' });
      return;
    }
    // SPEC-step32.md B4 — a user-initiated rename always marks the title as
    // user-owned, so the AI's `titleHint` (chatTurn.ts) stops offering to
    // change it on future turns.
    conversationsRepo.rename(id, parsed.data.title, 'user');
    reply.send({ conversation: conversationsRepo.get(id) });
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!conversationsRepo.get(id)) {
      reply.code(404).send({ error: `Conversation "${id}" not found` });
      return;
    }
    conversationsRepo.deleteCascade(id);
    reply.code(204).send();
  });

  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = conversationsRepo.get(id);
    if (!conversation) {
      reply.code(404).send({ error: `Conversation "${id}" not found` });
      return;
    }

    const parsed = MessageBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply
        .code(400)
        .send({ error: 'content is required (string, min length 1); attachments: tối đa 3 ảnh đã upload hợp lệ' });
      return;
    }
    const { content, attachments } = parsed.data;

    if (conversation.title === '') {
      conversationsRepo.rename(id, autoTitle(content), 'auto');
    }

    try {
      const ids = chatTurnManager.start(id, content, attachments);
      reply.code(202).send(ids);
    } catch (err) {
      if (err instanceof TurnInProgressError) {
        reply.code(409).send({ error: 'turn-in-progress' });
        return;
      }
      if (err instanceof ConversationNotFoundError) {
        reply.code(404).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get('/api/conversations/:id/turns/:assistantMessageId/events', async (request, reply) => {
    const { id, assistantMessageId } = request.params as { id: string; assistantMessageId: string };

    const conversation = conversationsRepo.get(id);
    const message = messagesRepo.get(assistantMessageId);
    if (!conversation || !message || message.conversationId !== id || message.role !== 'assistant') {
      reply.code(404).send({ error: `Turn "${assistantMessageId}" not found` });
      return;
    }

    // See routes/runs.ts's identical comment: reply.hijack() is the only way
    // to keep writing to this response well after the handler returns, and
    // headers accumulated by hooks (CORS) must be merged in manually since
    // hijack() bypasses Fastify's normal reply serialization.
    const sseHeaders = {
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    } as unknown as OutgoingHttpHeaders;
    reply.raw.writeHead(200, sseHeaders);
    reply.hijack();

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let finished = false;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      request.raw.off('close', finish);
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    const onEvent = (event: ChatTurnSseEvent): void => {
      send(event.event, event.data);
      if (event.event === 'done') finish();
    };

    const result = chatTurnManager.subscribe(assistantMessageId, onEvent);
    if (result) {
      // `subscribe()` replays the buffer synchronously — for an
      // already-finished turn that replay includes `done`, which already
      // ran `finish()` above (with `unsubscribe` still `undefined`, so it
      // was a no-op there). Assign it now and, if that happened, invoke it
      // immediately so the listener doesn't leak inside the manager forever.
      unsubscribe = result;
      if (finished) {
        unsubscribe();
      } else {
        request.raw.on('close', finish);
      }
      return;
    }

    // SPEC-step22.md §4.7 — manager doesn't know this turn (process restart
    // since the 202, or its LRU-200 cap already evicted it): reconstruct the
    // terminal event(s) from whatever's durably in `messages`.
    if (message.status === 'done') {
      const wfv = workflowsRepo.getWithVersion(conversation.workflowId);
      send('message', {
        content: message.content,
        workflow: wfv?.workflow,
        version: wfv?.version,
        changeId: message.changeId ?? null,
      });
    } else if (message.status === 'error') {
      send('error', { message: message.error ?? 'Lỗi không xác định' });
    } else {
      send('error', { message: 'Turn không còn chạy' });
    }
    send('done', {});
    finish();
  });

  app.post('/api/conversations/:id/messages/:messageId/stop', async (request, reply) => {
    const { messageId } = request.params as { id: string; messageId: string };
    reply.code(200).send({ stopped: chatTurnManager.stop(messageId) });
  });
}
