/**
 * `buildChangeDigest` (SPEC-step21.md §3): compresses a run of unseen
 * `workflow_changes` rows into a short, deterministic (no LLM call) Vietnamese
 * digest that gets embedded in the chat system prompt (promptBuilder.ts's
 * `buildChatSystemPrompt`), so the AI "knows" what the user changed by hand
 * since it last looked — without paying the token cost of the full history.
 */
import type { WorkflowChange } from '../db/changes.js';
import type { PatchOp } from './patch.js';

const MAX_LINES = 40;
const MAX_CHARS = 6000;
const VALUE_TRUNCATE_LEN = 120;

/** JSON-stringifies `value` and truncates to `VALUE_TRUNCATE_LEN` chars (the
 * "giá trị JSON, cắt 120 ký tự" of SPEC-step21.md §3). `JSON.stringify` can
 * return `undefined` for values like a bare `undefined` — falls back to
 * `String(value)` so a line is always produced. */
function formatValue(value: unknown): string {
  const json = JSON.stringify(value);
  const text = json ?? String(value);
  return text.length > VALUE_TRUNCATE_LEN ? `${text.slice(0, VALUE_TRUNCATE_LEN)}…` : text;
}

function sourcePrefix(source: WorkflowChange['source']): string {
  return source === 'user' ? '[tay]' : '[AI]';
}

/**
 * Flattens every change's ops (in order) into a `Map<key, line>` — a plain
 * JS `Map` preserves insertion order, and re-`set`ting an EXISTING key
 * without first `delete`-ing it does NOT move it to the end. So dedupe
 * (SPEC-step21.md §3.2: "chỉ giữ giá trị SAU CÙNG") is implemented as
 * delete-then-set on every occurrence of a dedupe-able key
 * ((nodeId, paramKey) for update-node params, (nodeId, 'label') for label) —
 * the line ends up positioned where its LAST occurrence happened
 * chronologically, holding its LAST value. Non-dedupe-able ops (add-node,
 * remove-node, add-edge, remove-edge) each get a unique key (an incrementing
 * counter) so they never collide with one another. `move-node` never gets a
 * key at all (§3 point 3: "bỏ qua, không sinh dòng").
 */
function flattenToLines(changes: WorkflowChange[]): string[] {
  const lines = new Map<string, string>();
  let seq = 0;

  for (const change of changes) {
    const prefix = sourcePrefix(change.source);
    const ops = change.ops as PatchOp[];

    for (const op of ops) {
      switch (op.op) {
        case 'add-node': {
          lines.set(`uniq:${seq++}`, `${prefix} thêm node ${op.node.type} (id ${op.node.id})`);
          break;
        }
        case 'remove-node': {
          lines.set(`uniq:${seq++}`, `${prefix} xoá node ${op.nodeId}`);
          break;
        }
        case 'add-edge': {
          lines.set(
            `uniq:${seq++}`,
            `${prefix} nối ${op.edge.from.node}.${op.edge.from.port} → ${op.edge.to.node}.${op.edge.to.port}`,
          );
          break;
        }
        case 'remove-edge': {
          lines.set(`uniq:${seq++}`, `${prefix} xoá edge ${op.edgeId}`);
          break;
        }
        case 'update-node': {
          if (op.label !== undefined) {
            const key = `label:${op.nodeId}`;
            lines.delete(key);
            lines.set(key, `${prefix} node ${op.nodeId}: label = ${formatValue(op.label)}`);
          }
          if (op.params) {
            for (const [paramKey, value] of Object.entries(op.params)) {
              const key = `param:${op.nodeId}:${paramKey}`;
              lines.delete(key);
              lines.set(key, `${prefix} node ${op.nodeId}: ${paramKey} = ${formatValue(value)}`);
            }
          }
          break;
        }
        case 'move-node':
          // Cosmetic-only op — never surfaced to the digest.
          break;
      }
    }
  }

  return [...lines.values()];
}

function render(droppedCount: number, lines: string[]): string {
  const rollup = droppedCount > 0 ? [`… (${droppedCount} thay đổi cũ hơn đã lược bớt)`] : [];
  return [...rollup, ...lines].join('\n');
}

export function buildChangeDigest(changes: WorkflowChange[]): string {
  let lines = flattenToLines(changes);
  let droppedCount = 0;

  // §3.4 — cap 40 lines, keep the newest.
  if (lines.length > MAX_LINES) {
    droppedCount = lines.length - MAX_LINES;
    lines = lines.slice(-MAX_LINES);
  }

  // §3.5 — hard ~1500-token (≈6000 char) budget; keep trimming the oldest
  // remaining line (LIFO from the front) until it fits, updating the rollup
  // line's count each time.
  let output = render(droppedCount, lines);
  while (output.length > MAX_CHARS && lines.length > 0) {
    lines = lines.slice(1);
    droppedCount += 1;
    output = render(droppedCount, lines);
  }

  return output;
}
