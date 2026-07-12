# SPEC step 20 — AI-native "Copilot Song Song": nền dữ liệu (conversations, messages, workflow_changes, version, backfill)

Bước 1/9 của lộ trình redesign AI-native (thiết kế đầy đủ: `docs/DESIGN-ai-native.md` — Phần I là authoritative). Bước này CHỈ làm tầng dữ liệu: schema + repos + backfill + unit test. **KHÔNG** route mới, **KHÔNG** UI, **KHÔNG** đổi hành vi endpoint nào hiện có.

## §1 Phạm vi

- 3 bảng SQLite mới: `conversations`, `messages`, `workflow_changes`.
- 1 cột mới trên bảng có sẵn: `workflows.version INTEGER NOT NULL DEFAULT 0`.
- 3 repo mới theo pattern `WorkflowsRepo` (class nhận `db` + `now` injection): `ConversationsRepo`, `MessagesRepo`, `ChangesRepo`; mở rộng `WorkflowsRepo` với version.
- Backfill idempotent cho workflow mồ côi (11 sample cũ + mọi workflow không có conversation).
- Unit tests vitest trong `apps/server/test/` (db in-memory).

## §2 Schema (thêm vào `SCHEMA_SQL` trong `apps/server/src/db/sqlite.ts`)

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL UNIQUE,      -- quan hệ 1-1 bắt buộc với workflows.id
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_change_id INTEGER            -- con trỏ digest: AI đã "đọc" tới change nào; NULL = chưa turn nào
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'user' | 'assistant'
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',   -- 'pending' | 'streaming' | 'done' | 'error'
  error TEXT,
  change_id INTEGER,                     -- workflow_changes.id nếu turn này tạo ra change (NULL nếu chỉ trả lời)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source TEXT NOT NULL,                  -- 'ai' | 'user'
  scope TEXT NOT NULL,                   -- 'structural' | 'cosmetic'
  message_id TEXT,                       -- set khi source='ai'
  ops_json TEXT NOT NULL,                -- PatchOp[] (vocabulary chung — bước 21 thêm op move-node)
  summary TEXT NOT NULL,                 -- 1 dòng tiếng Việt human-readable
  snapshot_after TEXT NOT NULL,          -- full Workflow JSON NGAY SAU khi apply — phục vụ revert đúng 100%
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_workflow ON workflow_changes(workflow_id, id);
CREATE INDEX IF NOT EXISTS idx_changes_conversation ON workflow_changes(conversation_id, id);
```

**Cột `workflows.version`**: `CREATE TABLE IF NOT EXISTS` không thêm cột vào bảng đã tồn tại → cần helper migration trong `openDb()`:

```ts
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  // PRAGMA table_info(<table>) → nếu thiếu column thì ALTER TABLE <table> ADD COLUMN <ddl>
}
ensureColumn(db, 'workflows', 'version', 'version INTEGER NOT NULL DEFAULT 0');
```

DB mới lẫn DB cũ (data/*.db đang có) đều phải hội tụ về cùng schema, không mất dữ liệu.

## §3 Repos

Types camelCase (`Conversation`, `ConversationSummary`, `Message`, `WorkflowChange`) export từ chính file repo tương ứng. File mới: `apps/server/src/db/conversations.ts`, `db/messages.ts`, `db/changes.ts`.

### 3.1 `ConversationsRepo`

- `create(input: { id: string; workflowId: string; title?: string }): Conversation` — timestamps = `now()`.
- `get(id)`, `getByWorkflowId(workflowId)`.
- `list(search?: string): ConversationSummary[]` — `title LIKE '%…%'` (escape `%_`), `ORDER BY updated_at DESC`. Summary gồm `{ id, workflowId, title, createdAt, updatedAt, nodeCount, lastRunStatus? }`:
  - `nodeCount`: `json_array_length(w.json, '$.nodes')` qua JOIN `workflows`.
  - `lastRunStatus`: correlated subquery lấy `status` của run mới nhất theo `workflow_id` (có thể NULL).
- `rename(id, title)` + bump `updated_at`; `touch(id)`; `setLastSeenChangeId(id, changeId | null)`.
- `deleteCascade(id): void` — trong 1 transaction: xoá `messages`, `workflow_changes`, `node_runs` + `runs` (theo `workflow_id`), `workflows`, rồi `conversations`. (Route dùng ở bước 22.)

### 3.2 `MessagesRepo`

- `create(input: { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; status?: MessageStatus; changeId?: number }): Message`.
- `get(id)`, `listByConversation(conversationId)` — `ORDER BY created_at, rowid`.
- `update(id, fields: Partial<{ content: string; status: MessageStatus; error: string | null; changeId: number | null }>): void` — cho vòng đời turn: tạo `pending` → `streaming` → `done`/`error`.

### 3.3 `ChangesRepo`

- `create(input: { workflowId; conversationId; source: 'ai' | 'user'; scope: 'structural' | 'cosmetic'; messageId?; ops: unknown[]; summary; snapshotAfter: unknown }): WorkflowChange` — serialize `ops_json`/`snapshot_after`, trả về bản ghi kèm `id` autoincrement.
- `get(id)`, `latestForWorkflow(workflowId)`.
- `listByWorkflow(workflowId, opts?: { sinceId?: number; limit?: number; includeCosmetic?: boolean })` — mặc định `limit=100`, `includeCosmetic=false` (lọc `scope='cosmetic'`), `sinceId` = chỉ lấy `id > sinceId`, order theo `id ASC`.
- `getPrevSnapshot(workflowId, changeId): unknown | undefined` — `snapshot_after` (đã parse) của dòng có `id` LỚN NHẤT nhưng `< changeId` cùng workflow; `undefined` nếu changeId là dòng đầu (caller sẽ dùng emptyWorkflow — bước 22).

### 3.4 `WorkflowsRepo` mở rộng (sửa `db/workflows.ts`)

- `getVersion(id): number | undefined`.
- `getWithVersion(id): { workflow: Workflow; version: number } | undefined`.
- `saveVersioned(workflow: Workflow, expectedVersion?: number): number` — trong 1 transaction: nếu `expectedVersion !== undefined` và khác version hiện tại (workflow chưa tồn tại coi như version 0) → throw `VersionConflictError` (class mới, mang `currentVersion`); ngược lại upsert như `upsert()` + `version = version + 1`, trả version mới.
- `upsert()`/`create()` cũ giữ nguyên hành vi (không bump version) — route cũ không đổi semantics.

## §4 Backfill (`apps/server/src/db/backfill.ts`)

```ts
export function backfillConversations(db: Database.Database, now: () => number = Date.now): number
```

- Tìm mọi workflow mồ côi: `SELECT ... FROM workflows WHERE id NOT IN (SELECT workflow_id FROM conversations)`.
- Với mỗi workflow: tạo conversation `{ id: randomUUID(), workflowId, title: name || 'Workflow không tên', created_at/updated_at = created_at/updated_at gốc của workflow (fallback now()) }` + 1 message assistant `status='done'`: `"Workflow này được nhập từ mẫu có sẵn — bạn có thể chat để AI tiếp tục chỉnh sửa."`.
- Idempotent: chạy N lần, sau lần đầu luôn trả 0. Chạy trong 1 transaction. Trả số conversation đã tạo.
- Gọi tại: (1) server startup ngay sau `openDb()` (log `[backfill] tạo N conversation cho workflow mồ côi` khi N > 0); (2) cuối seed script (`pnpm --filter server seed`).

## §5 Unit tests (`apps/server/test/db-conversations.test.ts` + file tương ứng, db `:memory:`)

1. **Schema/migration**: `openDb()` tạo đủ 3 bảng mới; với DB đã có bảng `workflows` KHÔNG có cột `version` (giả lập DB cũ), `openDb()` lần 2 thêm cột, dữ liệu cũ nguyên vẹn, chạy lại lần 3 không lỗi.
2. **ConversationsRepo**: CRUD, list order + search (kể cả ký tự `%`), unique `workflow_id` (tạo 2 conversation cùng workflow → throw), `nodeCount`/`lastRunStatus` đúng, `setLastSeenChangeId`.
3. **MessagesRepo**: create/list đúng thứ tự, update vòng đời pending→done và pending→error.
4. **ChangesRepo**: id tăng dần; `listByWorkflow` mặc định ẩn cosmetic + tôn trọng `sinceId`/`limit`/`includeCosmetic`; `getPrevSnapshot` trả snapshot dòng liền trước và `undefined` cho dòng đầu; `latestForWorkflow`.
5. **saveVersioned**: bump 0→1→2; `expectedVersion` đúng → ok; lệch → `VersionConflictError` mang `currentVersion`, DB không đổi.
6. **Backfill**: 3 workflow mồ côi + 1 đã có conversation → lần 1 tạo đúng 3 (title/timestamps kế thừa, có message giới thiệu), lần 2 tạo 0; `deleteCascade` xoá sạch messages/changes/runs/node_runs/workflow/conversation.

## §6 Nghiệm thu

- `pnpm --filter server test` xanh toàn bộ (335 test cũ + mới), `pnpm --filter server typecheck` sạch.
- `pnpm --filter server seed` chạy được, sau seed mỗi sample có đúng 1 conversation.
- Không dependency mới; không đổi contract route nào; không đọc/ghi `.env.local`.
