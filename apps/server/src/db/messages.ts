/**
 * MessagesRepo (SPEC-step20.md §3.2): chat turns for a conversation. A turn's
 * assistant message lives through pending -> streaming -> done|error, mirrors
 * the node-run lifecycle pattern already used by SqliteRunStore.
 */
import type Database from 'better-sqlite3';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error';

/** SPEC-step32.md B1 — one image the user attached to a chat message, already
 * uploaded via `POST /api/upload` (this only carries the resulting `path`
 * plus display metadata, never the file bytes themselves). */
export interface MessageAttachment {
  path: string;
  filename?: string;
  mime?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error?: string;
  changeId?: number;
  /** `undefined` when the message has no attachments (the common case) —
   * never an empty array. */
  attachments?: MessageAttachment[];
  createdAt: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  status: string;
  error: string | null;
  change_id: number | null;
  attachments: string | null;
  created_at: number;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    status: row.status as MessageStatus,
    error: row.error ?? undefined,
    changeId: row.change_id ?? undefined,
    attachments: row.attachments ? (JSON.parse(row.attachments) as MessageAttachment[]) : undefined,
    createdAt: row.created_at,
  };
}

export class MessagesRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: {
    id: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    status?: MessageStatus;
    changeId?: number;
    /** SPEC-step32.md B1 — persisted verbatim (never the LLM-facing "[Đính
     * kèm N ảnh...]" note, which `chatTurn.ts` synthesizes on the fly at
     * prompt-build time instead of being stored here). */
    attachments?: MessageAttachment[];
  }): Message {
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, status, error, change_id, attachments, created_at)
         VALUES (@id, @conversationId, @role, @content, @status, NULL, @changeId, @attachments, @createdAt)`,
      )
      .run({
        id: input.id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        status: input.status ?? 'done',
        changeId: input.changeId ?? null,
        attachments:
          input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
        createdAt,
      });
    return this.get(input.id)!;
  }

  get(id: string): Message | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  listByConversation(conversationId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`)
      .all(conversationId) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Partial update for a turn's lifecycle transitions; unset fields keep their current DB value. */
  update(
    id: string,
    fields: Partial<{ content: string; status: MessageStatus; error: string | null; changeId: number | null }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = {
      content: fields.content ?? current.content,
      status: fields.status ?? current.status,
      error: 'error' in fields ? (fields.error ?? null) : (current.error ?? null),
      changeId: 'changeId' in fields ? (fields.changeId ?? null) : (current.changeId ?? null),
    };
    this.db
      .prepare(
        `UPDATE messages SET content = @content, status = @status, error = @error, change_id = @changeId WHERE id = @id`,
      )
      .run({ ...next, id });
  }
}
