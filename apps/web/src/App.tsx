/**
 * Layout (SPEC-step4.md §2/§4): top Toolbar, then Sidebar | Canvas | right
 * panel (Params/Runs/Kết quả tabs — SPEC-step9.md §2 lifted the tab
 * selection into the store so `openRun` can auto-switch to "Kết quả").
 * WorkflowList renders as an overlay.
 *
 * SPEC-step18.md §5.5 — right-panel tabs restyled as "bìa hồ sơ" (folder
 * tabs): 2px black border box, active tab bg-accent with its bottom border
 * recolored to match (rather than removed outright, which would shift tab
 * height under Tailwind's border-box sizing) so it reads as fused with the
 * panel body directly beneath it, no dividing line.
 */
import { useEffect, useState } from 'react';
import { FlowCanvas } from './canvas/FlowCanvas.tsx';
import { Sidebar } from './canvas/Sidebar.tsx';
import { JsonView } from './panels/JsonView.tsx';
import { ParamsPanel } from './panels/ParamsPanel.tsx';
import { ResultsPanel } from './panels/ResultsPanel.tsx';
import { RunsPanel } from './panels/RunsPanel.tsx';
import { SettingsPage } from './panels/SettingsPage.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { WorkflowList } from './panels/WorkflowList.tsx';
import { useFlowStore } from './store/flow.ts';

/** "Bìa hồ sơ" tab classes (spec §5.5) — see file header for the fused-border trick. */
function rightTabClass(active: boolean): string {
  const base =
    'flex-1 border-r-2 border-b-[3px] border-ink px-2 py-2.5 text-center font-display text-[11px] uppercase tracking-wide text-ink transition-colors last:border-r-0';
  return active ? `${base} bg-accent border-b-accent` : `${base} bg-bg hover:bg-paper`;
}

function App() {
  const loadRegistry = useFlowStore((state) => state.loadRegistry);
  const loadCatalog = useFlowStore((state) => state.loadCatalog);
  const rightTab = useFlowStore((state) => state.rightTab);
  const setRightTab = useFlowStore((state) => state.setRightTab);
  const [showWorkflowList, setShowWorkflowList] = useState(false);
  const [showJsonView, setShowJsonView] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    loadRegistry().catch((err: unknown) => {
      console.error('Failed to load node registry', err);
    });
    loadCatalog().catch((err: unknown) => {
      console.error('Failed to load model catalog', err);
    });
  }, [loadRegistry, loadCatalog]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
      <Toolbar
        onOpenWorkflowList={() => setShowWorkflowList(true)}
        onOpenJsonView={() => setShowJsonView(true)}
        onOpenSettings={() => setShowSettings(true)}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <FlowCanvas />
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l-[3px] border-ink bg-paper">
          <div className="flex shrink-0">
            <button type="button" onClick={() => setRightTab('params')} className={rightTabClass(rightTab === 'params')}>
              Params
            </button>
            <button
              type="button"
              data-testid="runs-tab"
              onClick={() => setRightTab('runs')}
              className={rightTabClass(rightTab === 'runs')}
            >
              Runs
            </button>
            <button
              type="button"
              data-testid="results-tab"
              onClick={() => setRightTab('results')}
              className={rightTabClass(rightTab === 'results')}
            >
              Kết quả
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rightTab === 'params' && <ParamsPanel />}
            {rightTab === 'runs' && <RunsPanel />}
            {rightTab === 'results' && <ResultsPanel />}
          </div>
        </aside>
      </div>

      {showWorkflowList && <WorkflowList onClose={() => setShowWorkflowList(false)} />}
      {showJsonView && <JsonView onClose={() => setShowJsonView(false)} />}
      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}
    </div>
  );
}

export default App;
