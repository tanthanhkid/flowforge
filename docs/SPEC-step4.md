# SPEC — Bước 4: Frontend canvas (React Flow) + run + preview

Nguyên tắc: **tối giản, function over beauty**. Workflow JSON là nguồn sự thật duy nhất — canvas chỉ là view. KHÔNG đụng backend trừ khi có bug thật (ghi chú lại). Server API theo `docs/SPEC-step3.md` (đọc cả code routes thật trước khi viết client).

## 1. Scaffold apps/web

- Vite + React 18 + TypeScript strict. Deps: `@xyflow/react`, `zustand`. Dev: `tailwindcss` v4 + `@tailwindcss/vite`, `vitest`, `@testing-library/react`, `jsdom`.
- `vite.config.ts`: plugin react + tailwind; `server.proxy`: `/api` và `/artifacts` → `http://localhost:3001`.
- Scripts: `dev` (vite), `build` (`tsc -b && vite build`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`).
- Root `package.json` thêm script tiện: `"dev": "concurrently server+web"`? — KHÔNG thêm dep mới ở root; chỉ ghi README ngắn trong docs/ nếu cần. Bỏ qua.

## 2. Files

```
apps/web/src/main.tsx, App.tsx            # layout: Sidebar | Canvas | right panel; top Toolbar
apps/web/src/api/types.ts                 # Workflow, NodeSpec (từ /api/registry), RunRecord, NodeRunRecord, ValidationIssue — mirror server
apps/web/src/api/client.ts                # fetch wrappers + openRunEvents(runId, handlers) dùng EventSource
apps/web/src/store/flow.ts                # zustand store — nguồn sự thật
apps/web/src/canvas/FlowCanvas.tsx        # React Flow: derive nodes/edges từ store, DnD từ sidebar
apps/web/src/canvas/NodeCard.tsx          # custom node: title, ports màu theo type, badge trạng thái, preview inline
apps/web/src/canvas/Sidebar.tsx           # palette node theo category (GET /api/registry), drag/click để thêm
apps/web/src/canvas/portColors.ts         # map PortType → màu + compatible(out,in)
apps/web/src/panels/Toolbar.tsx           # tên workflow, Save, Validate, ▶ Run, trạng thái run
apps/web/src/panels/ParamsPanel.tsx       # form params của node đang chọn (render từ paramsJsonSchema)
apps/web/src/panels/RunsPanel.tsx         # lịch sử runs của workflow + mở lại run cũ (đọc node states/outputs)
apps/web/src/panels/WorkflowList.tsx      # danh sách workflows: mở/tạo/xóa
apps/web/src/preview/Preview.tsx          # render PortValue: image→<img>, audio→<audio controls>, video→<video controls>, text→clamp 5 dòng, json→<pre>
apps/web/test/*.test.tsx|ts
```

## 3. store/flow.ts (zustand)

State: `workflow: Workflow` (JSON thuần đúng schema server v1), `selectedNodeId`, `registry: NodeSpec[]`, `runId?`, `runStatus?`, `nodeRuns: Record<nodeId, { state, cached?, error?, outputs? }>`, `dirty: boolean`, `validationIssues: ValidationIssue[]`.

Actions: `loadRegistry()`, `newWorkflow()`, `loadWorkflow(id)`, `saveWorkflow()` (POST nếu chưa có trên server, PUT nếu có — dirty=false), `addNode(type, position)` (id = `${type.replace('.','_')}_${k}` k tăng tới khi unique; params = defaults từ paramsJsonSchema `default`), `updateNodeParams(id, params)`, `updateNodePosition(id, pos)`, `removeNode(id)` (xóa edge liên quan), `addEdge(from, to)` (check compatible + input port chưa bị chiếm — trả false nếu invalid), `removeEdge(id)`, `setWorkflowJson(json)` (thay toàn bộ — dùng cho JSON view bước 6), `run(force?: string[])` (save trước nếu dirty → POST /api/runs → subscribe SSE → cập nhật nodeRuns realtime; done → refetch GET /api/runs/:id để có outputs đầy đủ), `openRun(runId)` (nạp run cũ vào nodeRuns).

Mapping React Flow: nodes = workflow.nodes.map (position từ JSON, data = { spec, params, runState }); edges = workflow.edges (id giữ nguyên). Position thay đổi → ghi ngược vào workflow JSON (dirty=true).

## 4. Hành vi UI

- **Port màu theo type** (portColors.ts): text #3b82f6, image #22c55e, video #a855f7, audio #f97316, json #94a3b8, number #14b8a6, any #e5e7eb (viền đứt). Handle tooltip = `tên: type`.
- **Edge validation**: React Flow `isValidConnection` dùng `compatible()` (giống server: bằng nhau hoặc 1 bên `any`) + input port chỉ 1 edge. Kết nối invalid → không cho nối.
- **NodeCard**: header = title (+ badge category màu nhạt), body = list input ports trái / output ports phải, footer = badge trạng thái run (pending xám, running xanh dương pulse, success xanh lá, error đỏ + tooltip message, skipped vàng, cached thêm nhãn ⚡cache). Node success có output media → Preview inline nhỏ (max-h-32; image thumbnail, audio/video player). Click node → chọn (ring highlight) → ParamsPanel.
- **ParamsPanel**: render từng field từ paramsJsonSchema: string→input (multiline textarea nếu tên field ∈ {system, template, instruction} hoặc maxLength lớn), number→input number (min/max từ schema), boolean→checkbox, enum→select, object/record→textarea JSON (parse lỗi → viền đỏ, không apply). Hiện description của node + của field nếu có. Nút "Force re-run node này" (thêm nodeId vào force list của lần run kế) + nút Delete node.
- **Toolbar**: tên workflow (editable), Save (disabled khi !dirty), Validate (hiện list issues, click issue → select node lỗi), ▶ Run (disabled khi đang chạy; đang chạy hiện spinner + trạng thái), New, nút mở WorkflowList.
- **RunsPanel** (tab cùng cột phải): list runs (status icon + thời gian), click → openRun hiển thị states/outputs của run đó lên canvas.
- **Media URL**: MediaValue.path → src = `/artifacts/${basename(path)}`; MediaValue.url (không có path) → dùng url trực tiếp.
- Artifacts/outputs của `output.collect` hiện đủ mọi input đã gom trong Preview.

## 5. Tests (vitest + jsdom, mock fetch/EventSource — KHÔNG cần server thật)

- `portColors.test.ts`: compatible() đúng ma trận (text→text ok, text→video fail, any→mọi thứ ok, mọi thứ→any ok); đủ màu cho 7 type.
- `store.test.ts`: addNode sinh id unique + params default từ schema; addEdge từ chối type mismatch + input đã chiếm; removeNode dọn edges; position update set dirty; setWorkflowJson thay thế toàn bộ; run() flow với SSE mock (emit node:state events → nodeRuns cập nhật, done → refetch).
- `api-client.test.ts`: đúng URL/method/body cho CRUD + validate + runs; openRunEvents parse event types (snapshot/node:state/done) từ EventSource mock.
- `params-panel.test.tsx`: render field types từ một paramsJsonSchema mẫu (string/number/enum/boolean); nhập số ngoài min/max → không apply; textarea JSON lỗi parse → không gọi updateNodeParams.
- `node-card.test.tsx`: render ports đúng số lượng + màu class; badge state đổi theo runState; preview img xuất hiện khi output image.

## 6. Definition of Done

- `pnpm --filter web typecheck` + `pnpm --filter web build` + `pnpm --filter web test` đều xanh; server suite (94+) không bị đụng.
- Orchestrator sẽ tự smoke bằng browser: dev server + tạo workflow input.text→llm.generate, Run, xem badge + preview.
