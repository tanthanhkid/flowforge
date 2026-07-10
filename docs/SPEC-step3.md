# SPEC — Bước 3: Fastify API routes + SSE run status

Xây trên engine (B1) + nodes (B2). KHÔNG sửa engine/nodes trừ khi có bug thật. ESM NodeNext. Settings API để Bước 6 — KHÔNG làm ở bước này.

## 1. Files

```
apps/server/src/index.ts              # entry: loadEnv() → buildServer() → listen PORT (default 3001)
apps/server/src/server.ts             # buildServer(opts) — tạo Fastify app, DI được để test
apps/server/src/runManager.ts         # quản lý engine runs + fan-out events cho SSE
apps/server/src/db/workflows.ts       # WorkflowsRepo trên bảng workflows có sẵn
apps/server/src/routes/registry.ts
apps/server/src/routes/workflows.ts
apps/server/src/routes/runs.ts
apps/server/src/routes/artifacts.ts
apps/server/test/{api-workflows,api-runs,api-sse,api-artifacts}.test.ts
```

Deps mới: `fastify`, `@fastify/cors`. (Artifacts serve tự viết handler — không cần @fastify/static, để kiểm soát path traversal.)

## 2. buildServer

```ts
export interface ServerOpts {
  registry?: NodeRegistry;        // default createDefaultRegistry()
  dbPath?: string;                // default <repoRoot>/data/flowforge.db  (':memory:' cho test)
  artifactsDir?: string;          // default <repoRoot>/data/artifacts
  logger?: boolean;               // default false
}
export async function buildServer(opts?: ServerOpts): Promise<FastifyInstance>; // app.decorate('runManager', …)
```
- CORS: `@fastify/cors` origin true (local dev).
- Engine 1 instance/app: `new Engine(registry, { runs: SqliteRunStore, cache: SqliteCacheStore }, { artifactsDir })`.
- Error handler chung: lỗi validate → 400 `{ error, issues? }`; không tìm thấy → 404; còn lại 500 `{ error: message }` (không leak stack ra response).

## 3. runManager.ts

```ts
export class RunManager {
  constructor(engine: Engine, runStore: RunStore);
  start(workflow: Workflow, options?: { forceNodes?: string[] }): { runId: string }; // chạy nền, KHÔNG await engine.run
  subscribe(runId: string, listener: (event: { type: string; data: unknown }) => void): () => void; // unsubscribe fn
  isActive(runId: string): boolean;
}
```
- `start`: validateWorkflow trước → invalid throw (route trả 400 kèm issues). Hợp lệ → engine.run() chạy nền; promise catch để không unhandled-reject. runId lấy từ engine — **engine.run hiện tự sinh runId bên trong**: nếu cần, thêm `options.runId?` cho Engine.run (thay đổi engine TỐI THIỂU, giữ backward-compat, cập nhật test B1 không được phá).
- Fan-out: listen 3 event của engine, filter theo runId, phát cho subscribers dạng `{ type: 'node:state'|'node:log'|'run:state', data }`. Khi `run:state` kết thúc (success/error) → phát rồi dọn subscribers của runId đó.

## 4. Endpoints

- `GET /api/health` → `{ ok: true }`
- `GET /api/registry` → `{ nodes: registry.describeForAgent() }`
- `GET /api/workflows` → `[{ id, name, createdAt, updatedAt }]`
- `POST /api/workflows` body = workflow JSON → zod WorkflowSchema parse (shape); id trùng → 409. Lưu draft KHÔNG cần qua validateWorkflow đầy đủ (draft được phép thiếu edge). → 201 `{ id }`
- `GET /api/workflows/:id` → workflow JSON | 404
- `PUT /api/workflows/:id` → upsert (shape-valid), cập nhật updated_at → `{ id }`
- `DELETE /api/workflows/:id` → 204
- `POST /api/workflows/validate` body = workflow JSON → `{ ok: boolean, issues: ValidationIssue[] }` (dùng validateWorkflow + registry thật)
- `POST /api/runs` body `{ workflowId?: string, workflow?: Workflow, forceNodes?: string[] }` (đúng 1 trong workflowId/workflow) → 400 + issues nếu invalid; hợp lệ → 202 `{ runId }`
- `GET /api/runs?workflowId=&limit=` → lịch sử `[{ id, workflowId, status, createdAt, finishedAt }]` mới nhất trước
- `GET /api/runs/:id` → `{ run, nodes: NodeRunRecord[] }` | 404
- `GET /api/runs/:id/events` → **SSE** (`text/event-stream`):
  1. Gửi ngay `event: snapshot` data = `{ run, nodes }` hiện tại từ RunStore.
  2. Stream tiếp `event: node:state | node:log | run:state` (data JSON) qua RunManager.subscribe.
  3. Run đã kết thúc từ trước hoặc kết thúc sau đó → gửi `event: done` rồi end response. Run không tồn tại → 404.
  4. Heartbeat comment `: ping` mỗi 15s (test dùng interval nhỏ config được? — hardcode 15s, test không cần đợi heartbeat). Cleanup subscriber khi client disconnect (`request.raw.on('close')`).
- `GET /artifacts/:filename` → file từ artifactsDir. **Chặn path traversal**: chỉ cho basename (`/`, `..`, `\` → 400). Content-Type theo ext (mp3/wav/png/jpg/webp/gif/mp4/webm/mov cơ bản), 404 nếu không có.

## 5. index.ts

`loadEnv()` → `buildServer({ logger: true })` → `app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })`. Log 1 dòng port + số node types đăng ký. Scripts package.json: `"dev": "tsx watch src/index.ts"`, `"start": "tsx src/index.ts"`.

## 6. Tests

Test dùng `buildServer({ dbPath: ':memory:', artifactsDir: <tmp>, registry: <registry mock nodes B1> })`. HTTP qua `app.inject()`; riêng SSE test dùng `app.listen({ port: 0 })` + fetch thật tới `127.0.0.1` — **cập nhật test/setup.ts guard: cho phép fetch tới 127.0.0.1/localhost, vẫn chặn mọi host khác**.

- `api-workflows.test.ts`: CRUD roundtrip; POST id trùng → 409; PUT upsert; DELETE → GET 404; POST body sai shape → 400; /validate trả issues đúng (dùng workflow lỗi type-mismatch).
- `api-runs.test.ts`: POST /api/runs với workflow mock (chain + fail branch) → 202 runId; poll GET /api/runs/:id tới khi xong → states đúng (success/error/skipped); POST workflow invalid → 400 kèm issues; POST workflowId không tồn tại → 404; forceNodes truyền xuống (chạy 2 lần, lần 2 force 1 node → node đó cached=false); GET /api/runs lịch sử đúng thứ tự.
- `api-sse.test.ts`: start run delay nodes → mở SSE → nhận snapshot trước tiên, rồi ≥1 node:state, cuối cùng done; mở SSE của run ĐÃ xong → snapshot + done ngay; run không tồn tại → 404.
- `api-artifacts.test.ts`: ghi file tmp vào artifactsDir → GET 200 đúng content-type; `..%2Fsecret` và `../x` → 400; không tồn tại → 404.

Toàn bộ test B1+B2 phải tiếp tục xanh.

## 7. Definition of Done

- typecheck 0 lỗi; full test suite xanh.
- `pnpm --filter server dev` khởi động được, `GET /api/health` ok (orchestrator smoke tay).
