/**
 * backfillConversations (SPEC-step20.md §4 / DESIGN-ai-native.md §8): the
 * new ConversationRail is keyed on `conversations`, but every workflow that
 * existed before this step (the 11 samples + anything hand-created) has no
 * conversation row yet and would be invisible to it. This scans for orphan
 * workflows and gives each one a conversation + a short intro message, so
 * the rail always lists every workflow. Idempotent — the `NOT IN` scan
 * always converges to 0 orphans after the first successful run, so calling
 * this on every server start / seed run is safe.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

interface OrphanWorkflowRow {
  id: string;
  name: string | null;
  created_at: number | null;
  updated_at: number | null;
}

const INTRO_MESSAGE =
  'Workflow này được nhập từ mẫu có sẵn — bạn có thể chat để AI tiếp tục chỉnh sửa.';

/** Returns the number of conversations created (0 once nothing is orphaned anymore). */
export function backfillConversations(db: Database.Database, now: () => number = Date.now): number {
  const run = db.transaction((): number => {
    const orphans = db
      .prepare(
        `SELECT id, name, created_at, updated_at FROM workflows
         WHERE id NOT IN (SELECT workflow_id FROM conversations)`,
      )
      .all() as OrphanWorkflowRow[];

    if (orphans.length === 0) return 0;

    const insertConversation = db.prepare(
      `INSERT INTO conversations (id, workflow_id, title, created_at, updated_at, last_seen_change_id)
       VALUES (@id, @workflowId, @title, @createdAt, @updatedAt, NULL)`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, status, error, change_id, created_at)
       VALUES (@id, @conversationId, 'assistant', @content, 'done', NULL, NULL, @createdAt)`,
    );

    for (const wf of orphans) {
      const nowTs = now();
      const createdAt = wf.created_at ?? nowTs;
      const updatedAt = wf.updated_at ?? nowTs;
      const conversationId = randomUUID();

      insertConversation.run({
        id: conversationId,
        workflowId: wf.id,
        title: wf.name || 'Workflow không tên',
        createdAt,
        updatedAt,
      });
      insertMessage.run({
        id: randomUUID(),
        conversationId,
        content: INTRO_MESSAGE,
        createdAt: nowTs,
      });
    }

    return orphans.length;
  });

  return run();
}
