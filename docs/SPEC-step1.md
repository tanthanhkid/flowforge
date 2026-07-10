# SPEC — Bước 1: Workflow schema + NodeRegistry + Execution Engine + Tests

Spec này do orchestrator viết; implementor (Sonnet) bám sát interface dưới đây. Được phép đặt tên biến nội bộ khác, KHÔNG được đổi shape của public interface, tên file, hay hành vi đã spec.

## 0. Scaffold monorepo

```
pnpm-workspace.yaml          # packages: ["apps/*"]
package.json                 # root, private, scripts: { "test": "pnpm -r test" }
.gitignore                   # node_modules, dist, data/artifacts, .env.local, *.db, .DS_Store
apps/server/package.json     # name "server", type: "module"
apps/server/tsconfig.json    # strict, NodeNext module/resolution, target ES2022, outDir dist
apps/server/vitest.config.ts
```

Dependencies (apps/server): `zod` (v4 — dùng `z.toJSONSchema` built-in), `better-sqlite3`.
DevDeps: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/better-sqlite3`.
Scripts (apps/server): `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.

`apps/web` CHƯA scaffold ở bước này (bước 4).

## 1. Files

```
apps/server/src/engine/types.ts      # PortType, PortValue, MediaValue, NodeDefinition, ExecutionContext, states
apps/server/src/engine/schema.ts     # WorkflowSchema (zod) + validateWorkflow()
apps/server/src/engine/registry.ts   # NodeRegistry
apps/server/src/engine/graph.ts      # buildGraph, topoSort, detectCycle, descendantsOf
apps/server/src/engine/cache.ts      # cacheKey(), CacheStore interface, InMemoryCacheStore
apps/server/src/engine/context.ts    # createContext() — log, poll, saveArtifact
apps/server/src/engine/executor.ts   # Engine
apps/server/src/engine/stores.ts     # RunStore interface, InMemoryRunStore
apps/server/src/db/sqlite.ts         # openDb(), SqliteRunStore, SqliteCacheStore
apps/server/test/helpers/mockNodes.ts
apps/server/test/*.test.ts
```

## 2. types.ts

```ts
export type PortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'number' | 'any';

export interface MediaValue {
  kind: 'image' | 'video' | 'audio';
  path?: string;          // relative path trong data/artifacts
  url?: string;
  mime?: string;
  meta?: Record<string, unknown>;
}
export type PortValue = unknown; // text=string, number=number, image/video/audio=MediaValue, json/any=unknown

export interface PortSpec { type: PortType; required?: boolean; description?: string; }

export interface ExecutionContext {
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  artifactsDir: string;
  log(message: string): void;
  saveArtifact(data: Buffer, ext: string): Promise<string>; // ghi file <hash-or-uuid>.<ext> vào artifactsDir, trả relative path
  poll<T>(
    check: () => Promise<{ done: boolean; value?: T }>,
    opts?: { initialDelayMs?: number; maxDelayMs?: number; factor?: number; timeoutMs?: number },
  ): Promise<T>;
}

export interface NodeDefinition<P = unknown> {
  type: string;                    // 'llm.generate'
  category: string;                // 'llm' | 'image' | 'video' | 'audio' | 'utility'
  title: string;
  description?: string;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  paramsSchema: import('zod').ZodType<P>;
  cacheable?: boolean;             // default true
  execute(args: { inputs: Record<string, PortValue>; params: P; ctx: ExecutionContext }): Promise<Record<string, PortValue>>;
}

export type NodeState = 'pending' | 'running' | 'success' | 'error' | 'skipped';
export type RunStatus = 'running' | 'success' | 'error';
```

`poll` defaults: initialDelayMs 1000, factor 1.5, maxDelayMs 10_000, timeoutMs 300_000. Backoff: delay = min(initial * factor^n, max). Abort qua `signal` → reject `new Error('aborted')`. Timeout → reject error có chữ 'timeout'. Sleep phải cancel được bằng signal. **Timer delay của poll KHÔNG được `unref()`** — một run đang poll phải giữ process sống (standalone runner/script sẽ thoát sớm nếu unref; đã gặp bug thật ở smoke script). Để test được với fake timers, dùng `setTimeout` thường (vitest fake timers điều khiển được).

## 3. schema.ts — Workflow JSON (versioned)

```ts
export const WorkflowSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().default(''),
  nodes: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    label: z.string().optional(),
  })),
  edges: z.array(z.object({
    id: z.string().min(1),
    from: z.object({ node: z.string(), port: z.string() }),
    to: z.object({ node: z.string(), port: z.string() }),
  })),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export interface ValidationIssue { code: string; message: string; nodeId?: string; edgeId?: string; }
export function validateWorkflow(wf: unknown, registry: NodeRegistry):
  { ok: true; workflow: Workflow } | { ok: false; issues: ValidationIssue[] };
```

`validateWorkflow` trả về **tất cả** issues tìm được (không dừng ở lỗi đầu — agent layer bước 5 sẽ feed nguyên danh sách cho LLM sửa). Checks theo thứ tự:

1. Zod parse (fail → map từng zod issue thành ValidationIssue, code `schema`).
2. `duplicate-node-id`, `duplicate-edge-id`
3. `unknown-node-type` (không có trong registry)
4. `unknown-edge-endpoint` (node id hoặc port name không tồn tại; from phải là output port, to phải là input port)
5. `type-mismatch` — compatible(out, in) = `out === in || out === 'any' || in === 'any'`
6. `duplicate-input` — một input port chỉ nhận tối đa 1 edge
7. `invalid-params` — params không pass paramsSchema của node type (dùng safeParse; áp dụng schema `.default()` nghĩa là params thiếu field có default vẫn hợp lệ)
8. `missing-required-input` — input `required: true` không có edge nối vào
9. `cycle` — graph có chu trình; message liệt kê các node trong chu trình

## 4. registry.ts

```ts
export class NodeRegistry {
  register(def: NodeDefinition<any>): void;         // throw nếu trùng type
  get(type: string): NodeDefinition | undefined;
  list(): NodeDefinition[];
  describeForAgent(): AgentNodeSchema[];             // serializable: type, category, title, description,
}                                                    // inputs/outputs (port name→{type,required}), paramsJsonSchema (z.toJSONSchema)
```

## 5. graph.ts

- `topoSort(workflow): string[]` — Kahn. Throw nếu có cycle.
- `detectCycle(workflow): string[] | null` — trả danh sách node id trong chu trình (hoặc null).
- `descendantsOf(workflow, nodeId): Set<string>` — mọi node downstream (transitive).
- Nhiều edge giữa cùng cặp node (2 port khác nhau) chỉ tính là 1 dependency.

## 6. cache.ts

```ts
export function cacheKey(nodeType: string, params: unknown, inputs: Record<string, PortValue>): string;
// sha256(canonicalJson({ nodeType, params, inputs })) — canonicalJson: object keys sort đệ quy, giữ nguyên array order
export interface CacheStore {
  get(key: string): Record<string, PortValue> | undefined;
  set(key: string, nodeType: string, outputs: Record<string, PortValue>): void;
}
export class InMemoryCacheStore implements CacheStore { ... }
```

## 7. stores.ts

```ts
export interface NodeRunRecord {
  runId: string; nodeId: string; state: NodeState;
  outputs?: Record<string, PortValue>; error?: string; logs: string[];
  cacheHit: boolean; startedAt?: number; finishedAt?: number;
}
export interface RunRecord { id: string; workflowId: string; workflowJson: string; status: RunStatus; createdAt: number; finishedAt?: number; }
export interface RunStore {
  createRun(run: RunRecord): void;
  finishRun(runId: string, status: RunStatus, finishedAt: number): void;
  upsertNodeRun(rec: NodeRunRecord): void;
  appendNodeLog(runId: string, nodeId: string, message: string): void;
  getRun(runId: string): { run: RunRecord; nodes: NodeRunRecord[] } | undefined;
}
export class InMemoryRunStore implements RunStore { ... }
```

## 8. executor.ts — Engine

```ts
export interface EngineOptions { artifactsDir?: string; concurrency?: number; now?: () => number; }
export interface RunOptions { forceNodes?: string[]; signal?: AbortSignal; }
export interface NodeResult { state: NodeState; outputs?: Record<string, PortValue>; error?: string; cached: boolean; durationMs?: number; }
export interface RunResult { runId: string; status: 'success' | 'error'; nodes: Record<string, NodeResult>; }

export class Engine extends EventEmitter {
  constructor(registry: NodeRegistry, stores: { runs: RunStore; cache: CacheStore }, opts?: EngineOptions);
  async run(workflow: Workflow, options?: RunOptions): Promise<RunResult>;
}
```

Events (cho SSE ở bước 3): `'node:state'` `{ runId, nodeId, state, error?, cached? }`; `'node:log'` `{ runId, nodeId, message }`; `'run:state'` `{ runId, status }`.

Hành vi:

1. `run()` gọi `validateWorkflow` trước; invalid → throw với danh sách issues.
2. Scheduler: indegree theo unique-node-dependency; node indegree 0 → ready. Chạy song song mọi node ready, giới hạn `concurrency` (default `Infinity`). Node xong → giảm indegree các node con.
3. Resolve inputs: mỗi input port lấy value từ output của source node theo edge. Input optional không nối → không có key trong `inputs`.
4. Node lỗi (execute throw): state `error`, error message lưu lại; **toàn bộ descendants → `skipped`** (không chạy); các branch độc lập vẫn chạy tiếp đến hết.
5. Cache: nếu `cacheable !== false` và nodeId ∉ `forceNodes` → lookup `cacheKey(type, params, resolvedInputs)`; hit → state `success`, `cached: true`, KHÔNG gọi execute. Miss/force → execute, thành công → `cache.set`. `forceNodes` chỉ bypass lookup của đúng node đó (vẫn ghi cache mới sau khi chạy).
6. Params được parse qua `paramsSchema.parse()` trước khi đưa vào execute (đã áp defaults).
7. Mọi chuyển state đều: emit event + ghi RunStore (upsertNodeRun). `ctx.log` → append log vào store + emit `node:log`.
8. Run status: `success` nếu không node nào error; ngược lại `error` (chi tiết per-node nằm trong `nodes`).
9. `runId` = `crypto.randomUUID()`. Timestamps qua `opts.now ?? Date.now`.
10. Một node crash không được unhandled-reject cả process; engine luôn resolve `RunResult`.

## 9. db/sqlite.ts

```ts
export function openDb(path: string): Database;   // better-sqlite3, tạo schema nếu chưa có, WAL mode
export class SqliteRunStore implements RunStore { constructor(db) }
export class SqliteCacheStore implements CacheStore { constructor(db) }
```

```sql
CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT, json TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow_id TEXT, workflow_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS node_runs (run_id TEXT, node_id TEXT, state TEXT NOT NULL, outputs_json TEXT, error TEXT, logs_json TEXT, cache_hit INTEGER DEFAULT 0, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (run_id, node_id));
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, node_type TEXT, outputs_json TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## 10. Mock nodes (test/helpers/mockNodes.ts — KHÔNG nằm trong src)

- `mock.text` — params `{ value: string }`, không input, out `text:text`. (đóng vai input.text)
- `mock.upper` — in `text:text` required, out `text:text`, uppercase.
- `mock.concat` — in `a:text` required, `b:text` optional, out `text:text`.
- `mock.delay` — params `{ ms: number }`, in `text:text` optional, out `text:text`; ghi lại `{start, end}` timestamps vào mảng share để test parallel.
- `mock.fail` — execute luôn throw `new Error('boom')`.
- `mock.counter` — factory tạo node với counter đếm số lần execute (test cache).
- `mock.poller` — dùng `ctx.poll`, done sau N lần check (N qua params).
- `mock.anyIn` — input `value:any`, để test any-port compatibility.

## 11. Tests (vitest) — danh sách bắt buộc

`schema.test.ts`
- workflow hợp lệ → ok; thiếu version / sai shape → issues code `schema`
- edge trỏ node/port không tồn tại → `unknown-edge-endpoint`
- nối text→video (mock node có output video) hoặc dùng 2 mock type khác nhau → `type-mismatch`; `any` port nối với mọi type → ok
- duplicate node id → issue; params sai schema → `invalid-params`; required input không nối → `missing-required-input`
- nhiều lỗi cùng lúc → trả đủ danh sách issues

`graph.test.ts`
- diamond (A→B, A→C, B→D, C→D): topoSort ra thứ tự hợp lệ (A trước B/C, B/C trước D)
- cycle A→B→C→A: detectCycle trả về đúng các node; validateWorkflow ra issue `cycle`; engine.run throw

`engine.test.ts`
- chain A→B→C chạy đúng thứ tự, output truyền đúng
- parallel: 2 nhánh `mock.delay` 50ms độc lập → khoảng thời gian chạy overlap (startB < endA && startA < endB)
- concurrency: 4 node delay độc lập, `concurrency: 2` → tại mọi thời điểm ≤ 2 node chạy đồng thời (đo bằng counter trong mock)
- error branch: A→fail→C và D→E độc lập → fail=error, C=skipped, D/E=success, run status=error, RunStore ghi đúng states
- events: emit đủ `node:state` transitions pending→running→success

`cache.test.ts`
- chạy 2 lần cùng workflow → lần 2 counter không tăng, node result `cached: true`
- đổi params → counter tăng (cache miss)
- đổi output của node upstream (đổi params node nguồn) → node downstream cũng miss (vì inputs đổi)
- `forceNodes: [X]` → X re-execute, node khác vẫn cache hit
- `cacheable: false` → không bao giờ cache

`poll.test.ts` (fake timers)
- poller done sau 3 lần check → resolve đúng value; delay tăng theo backoff (1000, 1500, 2250)
- timeoutMs vượt → reject error chứa 'timeout'
- abort signal → reject

`sqlite.test.ts`
- openDb(':memory:') tạo schema; SqliteRunStore ghi/đọc run + node states + logs round-trip đúng
- SqliteCacheStore: set rồi get ra đúng outputs; engine chạy với sqlite stores end-to-end (mock nodes) → node_runs có đủ record

## 12. Definition of Done

- `pnpm install` sạch, `pnpm --filter server typecheck` 0 lỗi, `pnpm --filter server test` xanh toàn bộ
- Không dùng `any` bừa bãi ở public interface; ESM imports có đuôi `.js` (NodeNext)
- Chưa implement node thật / Fastify / frontend nào cả (bước sau)
