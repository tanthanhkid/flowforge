/**
 * Custom React Flow node (SPEC-step4.md §4): title + category badge header,
 * input ports left / output ports right (colored by type via portColors.ts),
 * a run-state badge footer (pending/running/success/error/skipped, +
 * ⚡cache when cacheHit), an inline Preview of successful outputs, and
 * (SPEC-step5.md §6) a ✨ button opening a popover to edit this node via
 * natural-language instruction (POST /api/agent/edit-node).
 *
 * SPEC-step9.md §1: the inline preview is capped to a small, fixed-height
 * strip (Preview's `compact` default) so the node's box never grows past a
 * bounded height regardless of output size — otherwise a big image/video
 * inline on the node made edges "chĩa tá lả" as node boxes resized. Each
 * node also gets its own ▾/▸ toggle to hide/show that strip, on top of the
 * global "👁 Preview" toolbar toggle (store `showNodePreviews`) which hides
 * every node's preview at once. Clicking the preview strip opens the
 * ResultsPanel (right-panel "Kết quả" tab) and scrolls to this node's entry.
 *
 * SPEC-step16.md §1: every node is a *fixed* `w-[300px]` box — no content
 * (long title, long text preview, a wide param value) may widen it past
 * that, otherwise a long LLM text preview stretches the node to 1000+px and
 * overlaps neighbors / sends edges everywhere. Title truncates with a
 * tooltip; the text preview keeps its 1-line clamp plus `break-all` so a
 * single unbroken token (a URL, a base64 blob) can't push the box wider
 * either; media previews stay `max-w-full` so they scale down to fit.
 *
 * SPEC-step18.md §5.3 (neo-brutalist pass): white body, 3px black border, 0
 * radius, shadow-hard-5; header is a solid category-colored strip with an
 * uppercase font-display title. A corner "stamp" badge (22px, top:-10px;
 * right:-10px) carries the state glyph (○/◐/✓/✕/—/⚡) per the spec's "6
 * run-state" table; the *footer* status chip below it is kept verbatim from
 * the pre-redesign version (exact text 'pending'/'running'/'error'/etc, plus
 * a separate "⚡cache" label) because node-card.test.tsx and e2e's free tier
 * (`text=⚡cache`) assert on that literal text — a corner glyph alone would
 * have silently dropped that assertion coverage rather than "cập nhật assertion
 * theo UI mới" (spec §8), so both coexist: the stamp is the spec's visual
 * flourish, the footer chip is the accessible/testable state readout.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useRef, useState, type CSSProperties } from 'react';
import { editNodeWithInstruction } from '../api/client.ts';
import type { NodeState, PortType } from '../api/types.ts';
import { Preview } from '../preview/Preview.tsx';
import { useChatStore } from '../store/chat.ts';
import { useFlowStore } from '../store/flow.ts';
import { Badge } from '../ui/Badge.tsx';
import { Button } from '../ui/Button.tsx';
import { Popover } from '../ui/Popover.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { categoryHex, categoryTextClass } from './categoryColors.ts';
import { PORT_COLORS } from './portColors.ts';
import { STATUS_COLORS, type StatusColorKey } from './statusColors.ts';
import type { FlowNode } from './types.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

/** Footer status chip text — unchanged from the pre-redesign component (tests assert these exact strings). */
const STATE_BADGE: Record<NodeState, { label: string; className: string }> = {
  pending: { label: 'pending', className: 'bg-status-pending text-ink' },
  running: { label: 'running', className: 'bg-status-running text-ink' },
  success: { label: 'success', className: 'bg-status-success text-ink' },
  error: { label: 'error', className: 'bg-status-error text-paper' },
  skipped: { label: 'skipped', className: 'bg-status-skipped text-ink' },
};

/** Corner "stamp" badge (spec §5.3's 6 run-states) — resolves `cached` as its own key, layered over `success`. */
function badgeKey(state: NodeState | undefined, cached: boolean | undefined): StatusColorKey {
  if (!state) return 'pending';
  if (state === 'success' && cached) return 'cached';
  return state;
}

const STAMP_GLYPH: Record<StatusColorKey, string> = {
  pending: '○',
  running: '◐',
  success: '✓',
  error: '✕',
  skipped: '—',
  cached: '⚡',
};

/**
 * Background per stamp key — usually `statusColors.ts`'s STATUS_COLORS
 * directly, except `error`: spec §5.3 calls it out as "✕ trắng/đỏ" (white
 * badge, red glyph) rather than a solid red chip, so it deliberately does
 * NOT reuse STATUS_COLORS.error (which is the red used for the *card's*
 * border/shadow instead — see cardStyle below).
 */
const STAMP_BG: Record<StatusColorKey, string> = {
  ...STATUS_COLORS,
  error: '#FFFFFF',
};

/** Shape + text-color per stamp key (spec §5.3: circle for pending/running/success, square for error/skipped/cached). */
const STAMP_SHAPE: Record<StatusColorKey, string> = {
  pending: 'rounded-full text-ink',
  running: 'rounded-full text-ink',
  success: 'rounded-full text-ink',
  error: 'rounded-none text-status-error',
  skipped: 'rounded-none text-ink',
  cached: 'rounded-none text-white rotate-[13deg]',
};

/**
 * SPEC-step18.md §5.3 / §6.2 (post-review fix): the border was previously
 * the port's own saturated color (e.g. lime/yellow), which on the cream/
 * white card background reads at ~1.1:1 contrast — exactly the low-contrast
 * problem the judge's §6.2 outline rule exists to prevent for edges, and the
 * port dot is the very endpoint of that edge. Border is now always solid
 * black (`any`'s color already *is* ink-black, so its dashed border stays
 * self-consistent); the port's own color still reads via the fill.
 *
 * Also nudges the dot outside the card's own edge ("nhô ra ngoài mép card",
 * spec §5.3): each port row is a `position: relative` box inset
 * `border-[3px]` + `px-1` (≈7px) from the card's outer edge, so React
 * Flow's own default `left:0`/`right:0` handle offset (which centers the
 * dot on the row's own edge) lands the whole 12px square *inside* that
 * inset, not past the card outline. The explicit `left`/`right` below
 * overrides that default (inline `style` always wins over the stylesheet
 * class) to push the dot's center a few px beyond the card's true outer
 * border.
 */
function portDotStyle(type: PortType, side: 'left' | 'right'): CSSProperties {
  const color = PORT_COLORS[type];
  const base: CSSProperties = {
    width: 12,
    height: 12,
    borderRadius: 0,
    background: type === 'any' ? 'transparent' : color,
    border: `2px ${type === 'any' ? 'dashed' : 'solid'} #0D0D0D`,
  };
  return side === 'left' ? { ...base, left: -12 } : { ...base, right: -12 };
}

export function NodeCard({ data, selected, dragging }: NodeProps<FlowNode>) {
  const { node, spec, runState } = data;
  const inputs = Object.entries(spec?.inputs ?? {});
  const outputs = Object.entries(spec?.outputs ?? {});
  const badge = runState ? STATE_BADGE[runState.state] : undefined;
  const hasOutputs = runState?.state === 'success' && runState.outputs && Object.keys(runState.outputs).length > 0;

  const workflow = useFlowStore((s) => s.workflow);
  const setWorkflowJson = useFlowStore((s) => s.setWorkflowJson);
  const selectNode = useFlowStore((s) => s.selectNode);
  const isForced = useFlowStore((s) => s.forceNodeIds.includes(node.id));
  const showNodePreviews = useFlowStore((s) => s.showNodePreviews);
  const requestScrollToNode = useFlowStore((s) => s.requestScrollToNode);
  // SPEC-step26.md §2.3/§3 — this turn's optimistic-apply highlight for this
  // node (`add-node`→'added', `update-node`/`move-node`→'updated'), cleared
  // by store/chat.ts's onDone. Read directly off the chat store (not
  // threaded through FlowCanvas's own `data` prop) since it's transient
  // animation-only state, unrelated to the workflow JSON this card actually
  // renders.
  const highlight = useChatStore((s) => s.opHighlights[node.id]);

  const [showEdit, setShowEdit] = useState(false);
  // SPEC-step18.md §5.3 (post-review fix): anchors the ✨ edit Popover.
  // Previously the Popover was nested inside a zero-size `relative` div
  // that was itself a *third* flex child of the header's `justify-between`
  // row (shifting the badge/✨ button ~8px) and, being anchored `left-0`
  // against that div's position at the header's far-right corner, rendered
  // ~256px off the card — for any node near the right panel that put the
  // whole popover under the panel, unusable. Popover.tsx now portals to
  // `document.body` and positions itself from this ref's own rect, so it
  // no longer needs to be nested in the header's flex flow at all.
  const editBtnRef = useRef<HTMLButtonElement>(null);
  const [instruction, setInstruction] = useState('');
  const [applying, setApplying] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Per-node preview collapse (spec §1's ▾/▸ toggle) — local, not store
  // state: it's this one node's own UI preference, independent of the
  // global toolbar toggle and not worth persisting.
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const showPreview = hasOutputs && showNodePreviews && !previewCollapsed;

  async function handleApply(): Promise<void> {
    setApplying(true);
    setEditError(null);
    try {
      const result = await editNodeWithInstruction(workflow, node.id, instruction);
      setWorkflowJson(result.workflow);
      // setWorkflowJson clears selection when the previously selected node
      // no longer exists — this node still does, so re-select it explicitly
      // (spec §6: "thành công setWorkflowJson(kết quả) giữ selection").
      selectNode(node.id);
      setShowEdit(false);
      setInstruction('');
    } catch (err) {
      setEditError(errorMessage(err));
    } finally {
      setApplying(false);
    }
  }

  const category = spec?.category ?? '';
  const headerHex = categoryHex(category);
  const headerTextClass = categoryTextClass(category);
  const stampKey = badgeKey(runState?.state, runState?.cached);

  // SPEC-step18.md §6.6: no shadow-jump animation on `running` — only the
  // header barber-pole + spinning stamp move, the card's own shadow stays a
  // plain static `shadow-hard-5`/`shadow-hard-8` class. `error` and
  // `dragging` need colors/values no fixed shadow-hard-* token has (red,
  // 10px), so those two are inline `style` (which always wins over a class
  // regardless of Tailwind's generated source order) rather than classes.
  const state = runState?.state;
  const isError = state === 'error';

  let cardClassName = 'w-[300px] border-[3px] bg-paper transition-transform duration-100';
  cardClassName += isError ? ' border-status-error' : ' border-ink';
  if (selected) cardClassName += ' border-[4px]';
  if (!isError) cardClassName += selected ? ' shadow-hard-8' : ' shadow-hard-5';
  if (state === 'pending' || state === undefined) cardClassName += ' opacity-90';
  if (state === 'skipped') cardClassName += ' opacity-55';
  // SPEC-step26.md §3 — one-shot AI-patch-op animations: `ff-node-pop`
  // (scale+opacity "đóng dấu" materialize) for a just-`add-node`'d node,
  // `ff-node-flash` (border flash) for `update-node`/`move-node`. Both
  // classes are neutralized under `prefers-reduced-motion` by index.css's
  // existing global `*`-selector rule — no extra gating needed here.
  if (highlight?.kind === 'added') cardClassName += ' ff-node-pop';
  if (highlight?.kind === 'updated') cardClassName += ' ff-node-flash';

  const cardStyle: CSSProperties = {};
  if (isError) {
    // One-shot shake: `animation-iteration-count: 1` only replays when the
    // computed `animation` value actually changes (i.e. on *entering* the
    // error state) — a later re-render that stays in `error` doesn't retrigger it.
    cardStyle.boxShadow = '5px 5px 0 #FF3B3B';
    cardStyle.animation = 'ff-shake 0.3s ease-in-out 1';
  }
  if (state === 'skipped') {
    cardStyle.boxShadow = 'none';
  }
  if (dragging) {
    cardStyle.boxShadow = '10px 10px 0 #0D0D0D';
    cardStyle.transform = 'rotate(1deg)';
  }

  return (
    <div
      // SPEC-step26.md §3 — "key bằng nonce để re-trigger được": a nonce
      // bump (the same node highlighted again — e.g. two consecutive turns
      // both `update-node` this id) forces React to unmount+remount this
      // element even though its animation *class name* may be unchanged
      // (`ff-node-flash` both times), which is what makes the CSS animation
      // actually replay rather than silently no-op (a class the browser
      // already considers "applied" doesn't restart on its own). Harmless
      // when it fires: NodeCard's own hooks (useState/useRef above) live on
      // this component's own fiber, not this div, so remounting only resets
      // this div's DOM subtree (Handles/Popover re-register, idempotently).
      key={highlight ? `hl-${highlight.nonce}` : 'base'}
      data-testid="node-card"
      data-node-id={node.id}
      data-state={runState?.state ?? 'pending'}
      className={`relative ${cardClassName}`}
      style={cardStyle}
    >
      {/* Corner "stamp" badge — spec §5.3: 22px, top:-10px; right:-10px. */}
      <div
        aria-hidden="true"
        className={`absolute z-10 flex h-[22px] w-[22px] items-center justify-center border-2 border-ink text-[12px] font-black leading-none ${STAMP_SHAPE[stampKey]}`}
        style={{ top: -10, right: -10, background: STAMP_BG[stampKey] }}
      >
        {stampKey === 'running' ? (
          // SPEC-step18.md §6.4 (judge-mandated): under reduced motion the
          // spinning ◐ must be *replaced* by a static "…" badge, not just
          // frozen mid-spin (a half-filled circle reads as a rendering
          // glitch, not a deliberate "running" state).
          <>
            <span className="motion-reduce:hidden">
              <Spinner className="text-[13px]" />
            </span>
            <span aria-hidden="true" className="hidden motion-reduce:inline">
              …
            </span>
          </>
        ) : (
          STAMP_GLYPH[stampKey]
        )}
      </div>

      {/* SPEC-step18.md §5.3: header barber-pole while running. */}
      <div
        className={`relative flex items-center justify-between gap-2 border-b-[3px] border-ink px-2 py-1.5 ${
          state === 'running' ? 'ff-node-running-header' : ''
        }`}
        style={state === 'running' ? undefined : { background: headerHex }}
      >
        <span
          className={`truncate font-display text-[12px] uppercase tracking-wide ${state === 'running' ? 'text-ink' : headerTextClass}`}
          title={node.id}
        >
          {spec?.title ?? node.type}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Badge>{spec?.category ?? '?'}</Badge>
          {isForced && (
            <span title="Sẽ force re-run ở lần Run kế tiếp">
              <Badge color="#FFDE21">🔁 force</Badge>
            </span>
          )}
          <button
            ref={editBtnRef}
            type="button"
            title="Edit this node with AI"
            onClick={(e) => {
              e.stopPropagation();
              setShowEdit((v) => !v);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center border-2 border-ink bg-paper text-[11px] hover:bg-ink hover:text-paper"
          >
            ✨
          </button>
        </div>
      </div>

      {/* Rendered as a card-level sibling (not nested in the header's flex
          row above) — Popover portals to document.body anyway, so keeping
          it here just avoids it ever perturbing the header's justify-between
          layout. */}
      {showEdit && (
        <Popover anchorRef={editBtnRef} align="right" className="w-64 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono-data text-[11px] font-bold uppercase text-ink">Sửa node bằng AI</span>
            <button
              type="button"
              onClick={() => setShowEdit(false)}
              className="flex h-4 w-4 items-center justify-center border-2 border-ink bg-paper text-[10px] hover:bg-ink hover:text-paper"
            >
              ✕
            </button>
          </div>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Mô tả thay đổi bạn muốn…"
            rows={3}
            className="mb-2 w-full border-2 border-ink bg-paper p-1 text-[11px] text-ink focus:border-cat-video focus:outline-none"
          />
          <Button variant="ai" onClick={() => void handleApply()} disabled={applying || instruction.trim().length === 0}>
            {applying && <Spinner />}
            {applying ? 'Applying…' : 'Apply'}
          </Button>
          {editError && <p className="mt-1 text-[11px] font-bold text-status-error">{editError}</p>}
        </Popover>
      )}

      {stampKey === 'success' && <div className="h-1 bg-status-success" />}
      {stampKey === 'cached' && <div className="border-b-2 border-dashed border-status-cached" />}

      {state === 'skipped' && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 8px, rgba(13,13,13,.12) 8px 16px)',
          }}
        />
      )}

      <div className="flex justify-between gap-3 px-1 py-1.5">
        <div className="flex flex-col gap-1.5">
          {inputs.map(([name, portSpec]) => (
            <div key={name} className="relative flex h-4 items-center pl-3">
              <Handle
                type="target"
                position={Position.Left}
                id={name}
                title={`${name}: ${portSpec.type}`}
                style={portDotStyle(portSpec.type, 'left')}
              />
              <span className="truncate font-mono-data text-[11px] text-ink-soft">{name}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {outputs.map(([name, portSpec]) => (
            <div key={name} className="relative flex h-4 items-center justify-end pr-3">
              <span className="truncate font-mono-data text-[11px] text-ink-soft">{name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={name}
                title={`${name}: ${portSpec.type}`}
                style={portDotStyle(portSpec.type, 'right')}
              />
            </div>
          ))}
        </div>
      </div>

      {hasOutputs && showNodePreviews && (
        <div className="border-t-2 border-ink px-2 py-0.5">
          <button
            type="button"
            data-testid="node-preview-toggle"
            title={previewCollapsed ? 'Hiện preview' : 'Ẩn preview'}
            onClick={(e) => {
              e.stopPropagation();
              setPreviewCollapsed((v) => !v);
            }}
            className="font-mono-data text-[11px] text-ink-soft hover:text-ink"
          >
            {previewCollapsed ? '▸' : '▾'} preview
          </button>
          {showPreview && runState?.outputs && (
            <div
              data-testid="node-preview"
              className="mt-0.5 flex max-h-[90px] cursor-pointer flex-col gap-1 overflow-hidden"
              title="Xem kết quả đầy đủ"
              onClick={(e) => {
                e.stopPropagation();
                requestScrollToNode(node.id);
              }}
            >
              {Object.entries(runState.outputs).map(([key, value]) => (
                <Preview key={key} value={value} />
              ))}
            </div>
          )}
        </div>
      )}

      {badge && (
        <div className="flex items-center gap-1.5 border-t-2 border-ink px-2 py-1" title={runState?.error}>
          <span
            data-testid="node-state-badge"
            className={`border-2 border-ink px-1.5 py-0.5 font-mono-data text-[11px] font-bold ${badge.className}`}
          >
            {badge.label}
          </span>
          {runState?.cached && <span className="font-mono-data text-[11px] font-bold text-ink-soft">⚡cache</span>}
        </div>
      )}
    </div>
  );
}
