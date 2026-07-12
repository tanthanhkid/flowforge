/**
 * SPEC-step20.md §5.6 — backfillConversations() idempotency + deleteCascade
 * on backfill-created data.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillConversations } from '../src/db/backfill.js';
import { ConversationsRepo } from '../src/db/conversations.js';
import { MessagesRepo } from '../src/db/messages.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';

function makeWorkflow(id: string, name = ''): Workflow {
  return { version: 1, id, name, nodes: [], edges: [] };
}

describe('backfillConversations', () => {
  let db: Database.Database;
  let workflows: WorkflowsRepo;
  let conversations: ConversationsRepo;
  let messages: MessagesRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    workflows = new WorkflowsRepo(db, () => 999);
    conversations = new ConversationsRepo(db, () => 999);
    messages = new MessagesRepo(db, () => 999);
  });

  afterEach(() => {
    db.close();
  });

  it('creates exactly 1 conversation + 1 intro message per orphan workflow, none for the already-linked one', () => {
    workflows.create(makeWorkflow('orphan-1', 'Sample A'));
    workflows.create(makeWorkflow('orphan-2', 'Sample B'));
    workflows.create(makeWorkflow('orphan-3', ''));
    workflows.create(makeWorkflow('linked', 'Already linked'));
    conversations.create({ id: 'existing-conv', workflowId: 'linked', title: 'Already linked' });

    const created = backfillConversations(db, () => 5000);
    expect(created).toBe(3);

    expect(conversations.getByWorkflowId('linked')?.id).toBe('existing-conv');

    for (const [wfId, expectedTitle] of [
      ['orphan-1', 'Sample A'],
      ['orphan-2', 'Sample B'],
      ['orphan-3', 'Workflow không tên'],
    ] as const) {
      const conv = conversations.getByWorkflowId(wfId);
      expect(conv).toBeDefined();
      expect(conv?.title).toBe(expectedTitle);
      const msgs = messages.listByConversation(conv!.id);
      expect(msgs).toHaveLength(1);
      const [intro] = msgs;
      expect(intro?.role).toBe('assistant');
      expect(intro?.status).toBe('done');
      expect(intro?.content).toMatch(/Workflow này được nhập từ mẫu có sẵn/);
    }

    // No extra conversation/message was created for the workflow that already had one.
    expect(messages.listByConversation('existing-conv')).toHaveLength(0);
  });

  it('inherits the workflow\'s own created_at/updated_at (falling back to now() if null)', () => {
    workflows.create(makeWorkflow('orphan-1'));
    db.prepare(`UPDATE workflows SET created_at = 111, updated_at = 222 WHERE id = 'orphan-1'`).run();
    db.prepare(
      `INSERT INTO workflows (id, name, json, created_at, updated_at, version) VALUES ('no-timestamps', '', '{}', NULL, NULL, 0)`,
    ).run();

    backfillConversations(db, () => 9999);

    expect(conversations.getByWorkflowId('orphan-1')).toMatchObject({ createdAt: 111, updatedAt: 222 });
    expect(conversations.getByWorkflowId('no-timestamps')).toMatchObject({ createdAt: 9999, updatedAt: 9999 });
  });

  it('is idempotent: a second (and third) run creates 0 once every workflow has a conversation', () => {
    workflows.create(makeWorkflow('orphan-1'));
    workflows.create(makeWorkflow('orphan-2'));

    expect(backfillConversations(db)).toBe(2);
    expect(backfillConversations(db)).toBe(0);
    expect(backfillConversations(db)).toBe(0);

    // Still exactly one conversation per workflow, no duplicates from re-running.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get()).toEqual({ n: 2 });
  });

  it('returns 0 and creates nothing when there are no workflows at all', () => {
    expect(backfillConversations(db)).toBe(0);
  });

  it('deleteCascade removes a backfill-created conversation, its intro message, and the workflow', () => {
    workflows.create(makeWorkflow('orphan-1', 'Sample'));
    backfillConversations(db, () => 5000);
    const conv = conversations.getByWorkflowId('orphan-1')!;
    expect(messages.listByConversation(conv.id)).toHaveLength(1);

    conversations.deleteCascade(conv.id);

    expect(conversations.get(conv.id)).toBeUndefined();
    expect(workflows.get('orphan-1')).toBeUndefined();
    expect(messages.listByConversation(conv.id)).toHaveLength(0);
  });
});
