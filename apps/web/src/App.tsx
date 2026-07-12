/**
 * Layout (SPEC-step4.md §2/§4, SPEC-step24.md §4): top Toolbar, then
 * ConversationRail | ChatPane | SplitDivider | CanvasPane. ChatPane and
 * CanvasPane always occupy the SAME viewport — the only difference between
 * "chat", "split" and "canvas" mode is `useChatStore`'s `splitRatio`
 * (`ChatPane`/`CanvasPane` each read it themselves and size their own root
 * via `flex-grow`; this file only owns the row they sit in, the global
 * ⌘\ / ⌘⇧\ shortcut, and the two overlay panels — JsonView/SettingsPage —
 * that are unrelated to the split). Replaces SPEC-step23.md §7's interim
 * fixed-width ConversationRail+ChatPane layout. The old `WorkflowList` modal
 * remains gone — ConversationRail is its full replacement.
 */
import { useEffect, useState } from 'react';
import { CanvasPane } from './panels/CanvasPane.tsx';
import { ChatPane } from './panels/ChatPane.tsx';
import { ConversationRail } from './panels/ConversationRail.tsx';
import { JsonView } from './panels/JsonView.tsx';
import { SettingsPage } from './panels/SettingsPage.tsx';
import { SplitDivider } from './panels/SplitDivider.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { layoutModeFromRatio, modeRatio, nextMode, useChatStore } from './store/chat.ts';
import { useFlowStore } from './store/flow.ts';
import { ToastHost } from './ui/Toast.tsx';

/** Native DOM keydown target check — the shortcut below must not fire while the user is typing (SPEC-step24.md §2). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

function App() {
  const loadRegistry = useFlowStore((state) => state.loadRegistry);
  const loadCatalog = useFlowStore((state) => state.loadCatalog);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const [showJsonView, setShowJsonView] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    loadRegistry().catch((err: unknown) => {
      console.error('Failed to load node registry', err);
    });
    loadCatalog().catch((err: unknown) => {
      console.error('Failed to load model catalog', err);
    });
    loadConversations().catch((err: unknown) => {
      console.error('Failed to load conversations', err);
    });
  }, [loadRegistry, loadCatalog, loadConversations]);

  // SPEC-step24.md §2 — ⌘\ cycles chat → split → canvas → chat; ⌘⇧\ reverses
  // it. Registered globally (not on a specific pane) so it works regardless
  // of where focus currently is, except inside an editable field (typing a
  // literal backslash must keep working there).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== '\\') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const dir = event.shiftKey ? -1 : 1;
      const current = layoutModeFromRatio(useChatStore.getState().splitRatio);
      const next = nextMode(current, dir);
      useChatStore.getState().setSplitRatio(modeRatio(next), { animate: true });
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
      <Toolbar onOpenJsonView={() => setShowJsonView(true)} onOpenSettings={() => setShowSettings(true)} />

      <div className="flex min-h-0 flex-1">
        <ConversationRail />
        <ChatPane />
        <SplitDivider />
        <CanvasPane />
      </div>

      {showJsonView && <JsonView onClose={() => setShowJsonView(false)} />}
      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}

      {/* SPEC-step27.md §6 — mounted once, globally, so a manualLog.ts toast
          (or one from any future call site) renders regardless of which
          pane/tab is currently active. */}
      <ToastHost />
    </div>
  );
}

export default App;
