/**
 * Layout (SPEC-step4.md §2/§4): top Toolbar, then Sidebar | Canvas | right
 * panel (Params/Runs tabs). WorkflowList renders as an overlay.
 */
import { useEffect, useState } from 'react';
import { FlowCanvas } from './canvas/FlowCanvas.tsx';
import { Sidebar } from './canvas/Sidebar.tsx';
import { ParamsPanel } from './panels/ParamsPanel.tsx';
import { RunsPanel } from './panels/RunsPanel.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { WorkflowList } from './panels/WorkflowList.tsx';
import { useFlowStore } from './store/flow.ts';

type RightTab = 'params' | 'runs';

function App() {
  const loadRegistry = useFlowStore((state) => state.loadRegistry);
  const [rightTab, setRightTab] = useState<RightTab>('params');
  const [showWorkflowList, setShowWorkflowList] = useState(false);

  useEffect(() => {
    loadRegistry().catch((err: unknown) => {
      console.error('Failed to load node registry', err);
    });
  }, [loadRegistry]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      <Toolbar onOpenWorkflowList={() => setShowWorkflowList(true)} />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <FlowCanvas />
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-white">
          <div className="flex border-b border-slate-200">
            <button
              type="button"
              onClick={() => setRightTab('params')}
              className={`flex-1 px-3 py-2 text-xs font-medium ${
                rightTab === 'params' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-slate-500'
              }`}
            >
              Params
            </button>
            <button
              type="button"
              onClick={() => setRightTab('runs')}
              className={`flex-1 px-3 py-2 text-xs font-medium ${
                rightTab === 'runs' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-slate-500'
              }`}
            >
              Runs
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{rightTab === 'params' ? <ParamsPanel /> : <RunsPanel />}</div>
        </aside>
      </div>

      {showWorkflowList && <WorkflowList onClose={() => setShowWorkflowList(false)} />}
    </div>
  );
}

export default App;
