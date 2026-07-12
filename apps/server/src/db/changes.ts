/**
 * ChangesRepo (SPEC-step20.md §3.3): append-only log of workflow_changes —
 * one shared PatchOp vocabulary for both AI and manual edits. Every row also
 * carries a full `snapshot_after` (the whole Workflow JSON right after that
 * change applied) so a future revert can restore state exactly, without
 * needing to compute inverse ops.
 */
import type Database from 'better-sqlite3';

export type ChangeSource = 'ai' | 'user';
export type ChangeScope = 'structural' | 'cosmetic';

export interface WorkflowChange {
  id: number;
  workflowId: string;
  conversationId: string;
  source: ChangeSource;
  scope: ChangeScope;
  messageId?: string;
  ops: unknown[];
  summary: string;
  snapshotAfter: unknown;
  createdAt: number;
}

interface WorkflowChangeRow {
  id: number;
  workflow_id: string;
  conversation_id: string;
  source: string;
  scope: string;
  message_id: string | null;
  ops_json: string;
  summary: string;
  snapshot_after: string;
  created_at: number;
}

function toChange(row: WorkflowChangeRow): WorkflowChange {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    conversationId: row.conversation_id,
    source: row.source as ChangeSource,
    scope: row.scope as ChangeScope,
    messageId: row.message_id ?? undefined,
    ops: JSON.parse(row.ops_json) as unknown[],
    summary: row.summary,
    snapshotAfter: JSON.parse(row.snapshot_after) as unknown,
    createdAt: row.created_at,
  };
}

export class ChangesRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: {
    workflowId: string;
    conversationId: string;
    source: ChangeSource;
    scope: ChangeScope;
    messageId?: string;
    ops: unknown[];
    summary: string;
    snapshotAfter: unknown;
  }): WorkflowChange {
    const inserted = this.db
      .prepare(
        `INSERT INTO workflow_changes
           (workflow_id, conversation_id, source, scope, message_id, ops_json, summary, snapshot_after, created_at)
         VALUES (@workflowId, @conversationId, @source, @scope, @messageId, @opsJson, @summary, @snapshotAfter, @createdAt)
         RETURNING id`,
      )
      .get({
        workflowId: input.workflowId,
        conversationId: input.conversationId,
        source: input.source,
        scope: input.scope,
        messageId: input.messageId ?? null,
        opsJson: JSON.stringify(input.ops),
        summary: input.summary,
        snapshotAfter: JSON.stringify(input.snapshotAfter),
        createdAt: this.now(),
      }) as { id: number };
    return this.get(inserted.id)!;
  }

  get(id: number): WorkflowChange | undefined {
    const row = this.db.prepare(`SELECT * FROM workflow_changes WHERE id = ?`).get(id) as
      | WorkflowChangeRow
      | undefined;
    return row ? toChange(row) : undefined;
  }

  latestForWorkflow(workflowId: string): WorkflowChange | undefined {
    const row = this.db
      .prepare(`SELECT * FROM workflow_changes WHERE workflow_id = ? ORDER BY id DESC LIMIT 1`)
      .get(workflowId) as WorkflowChangeRow | undefined;
    return row ? toChange(row) : undefined;
  }

  /** Default: hides cosmetic (move-node) rows, limit 100, id ASC; sinceId filters to id > sinceId. */
  listByWorkflow(
    workflowId: string,
    opts?: { sinceId?: number; limit?: number; includeCosmetic?: boolean },
  ): WorkflowChange[] {
    const sinceId = opts?.sinceId ?? 0;
    const limit = opts?.limit ?? 100;
    const includeCosmetic = opts?.includeCosmetic ?? false;
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_changes
         WHERE workflow_id = @workflowId AND id > @sinceId AND (@includeCosmetic = 1 OR scope != 'cosmetic')
         ORDER BY id ASC
         LIMIT @limit`,
      )
      .all({
        workflowId,
        sinceId,
        includeCosmetic: includeCosmetic ? 1 : 0,
        limit,
      }) as WorkflowChangeRow[];
    return rows.map(toChange);
  }

  /**
   * The `snapshot_after` of the row immediately before `changeId` for the
   * same workflow — what a revert of `changeId` should restore. Returns
   * undefined when `changeId` is the first row for that workflow (caller
   * falls back to an empty workflow — wired up in a later step).
   */
  getPrevSnapshot(workflowId: string, changeId: number): unknown | undefined {
    const row = this.db
      .prepare(
        `SELECT snapshot_after FROM workflow_changes
         WHERE workflow_id = ? AND id < ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(workflowId, changeId) as { snapshot_after: string } | undefined;
    return row ? (JSON.parse(row.snapshot_after) as unknown) : undefined;
  }
}
