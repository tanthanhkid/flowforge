# SPEC step 30 — AI nhìn thấy kết quả run (run summary vào context chat)

Nguồn gốc: session thật 2026-07-13 — user hỏi "sao ảnh kết quả ra không liên quan", AI chẩn đoán ĐÚNG nhưng hoàn toàn mù về run (context chatTurn chỉ có workflow + digest + history). Bước này cho AI thấy tóm tắt run gần nhất của workflow đang chat. KHÔNG làm vision/đính kèm ảnh (backlog).

## §1 Phạm vi file

- `apps/server/src/agent/chatTurn.ts`: dep mới + build khối run summary.
- `apps/server/src/agent/promptBuilder.ts`: `buildChatSystemPrompt` nhận thêm tham số optional.
- `apps/server/src/server.ts`: inject dep từ db.
- Tests server. KHÔNG đổi FE, KHÔNG route mới.

## §2 Dep mới trong `ChatTurnDeps` (additive)

```ts
getLatestRun?: (workflowId: string) => { run: RunRecord; nodes: NodeRunRecord[] } | undefined;
```

`server.ts` implement bằng query như `routes/runs.ts` đang dùng (`SELECT id ... WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`) + `runStore.getRun(id)` — hoặc thêm method nhỏ `latestRunForWorkflow(workflowId)` vào `SqliteRunStore` (chọn cách sạch hơn, ghi notes). Dep optional → mọi test/chỗ gọi cũ không cần sửa.

## §3 Khối run summary trong system prompt

- `buildChatSystemPrompt(registry, workflow, digest, runSummary?: string)` — thêm tham số optional (additive; caller cũ không truyền vẫn chạy). Khi có, chèn khối:

```
## Run gần nhất của workflow này
<runSummary>
(Dùng thông tin này khi người dùng hỏi về kết quả/lỗi của lần chạy.)
```

- `chatTurn.ts` build `runSummary` (hàm thuần `buildRunSummary(run, nodes): string`, export để test):
  - Dòng đầu: `Run <8 ký tự đầu id> — <status>, <thời gian tương đối so với now()> (bắt đầu <ISO ngắn>)`.
  - Mỗi node 1 dòng: `- <nodeId> (<node type từ workflow nếu tra được, else '?'>): <state><', cache' nếu cacheHit><', model <modelId>' nếu params workflow có modelId>` + nếu `state='error'`: `— lỗi: <error cắt 200 ký tự>`; nếu success và có outputs: liệt kê tên loại output + tên file artifact (basename path, KHÔNG kèm nội dung/URL đầy đủ).
  - Cap toàn khối 1500 ký tự (cắt từ các node success trước, giữ node error).
  - Tiếng Việt, deterministic (now inject qua deps.now — LƯU Ý: `ChatTurnDeps.now` đã tồn tại từ step 21 nhưng đang unused; giờ dùng thật cho thời gian tương đối).
- Lấy run: gọi `deps.getLatestRun?.(workflowId)` tại bước build prompt (và build LẠI khi rebuild version-conflict — dùng chung đường build context hiện có).

## §4 Tests (`chat-turn.test.ts` bổ sung + file mới nếu gọn hơn)

1. `buildRunSummary` thuần: run success đủ node (format đúng, cache/model hiện đúng), run có node error (error cắt 200 ký tự + được giữ khi cap), cap 1500 ký tự.
2. `runChatTurn`: có `getLatestRun` trả run → spy messages: system prompt chứa khối "Run gần nhất" đúng nội dung; không có dep/không có run → prompt KHÔNG chứa khối; rebuild sau version-conflict vẫn có khối (gọi getLatestRun lần nữa).
3. Test cũ xanh nguyên trạng (dep optional).

## §5 Nghiệm thu

`pnpm --filter server test` + typecheck xanh; e2e không đổi (mock OpenRouter nhận thêm system prompt dài hơn — 5 test chat vẫn phải xanh); smoke tay orchestrator: chạy 1 run thật trên workflow có sẵn rồi hỏi AI về kết quả qua API chat, xác nhận reply phản ánh run (1 call LLM, ~$0.01).
