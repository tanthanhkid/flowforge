/**
 * `extractJson` (SPEC-step5.md §2, file list): tolerant JSON extraction from
 * an LLM's raw text response. LLMs routinely wrap the JSON they were asked
 * for in a ```json fence, prepend/append commentary ("Here is the
 * workflow:\n\n{...}\n\nLet me know if..."), or otherwise fail to return
 * *only* the JSON. This tries, in order:
 *
 *   1. A fenced code block (```json ... ``` or plain ``` ... ```) — the
 *      strongest signal of "this is the intended JSON payload".
 *   2. The whole trimmed input parsed directly (the model behaved).
 *   3. A balanced-bracket scan: find the first `{`/`[` and its matching
 *      close (respecting JSON string literals so braces inside strings don't
 *      throw off the count), extracting exactly the JSON substring out of
 *      any surrounding prose.
 *
 * Throws if none of the above yields parseable JSON.
 */

/** Sentinel wrapper so a successfully-parsed `null`/`undefined` value is
 * distinguishable from "parsing failed". */
interface ParseAttempt {
  value: unknown;
}

function tryParse(text: string): ParseAttempt | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** Extracts the content of the first fenced code block, if any. */
function extractFenced(text: string): string | undefined {
  const match = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (!match) return undefined;
  const inner = match[1];
  return inner !== undefined ? inner.trim() : undefined;
}

/**
 * Scans `text` for the first `{` or `[` and returns the substring up to its
 * matching close bracket (same bracket type), skipping over the contents of
 * JSON string literals (so a `{`/`}` inside a quoted string doesn't affect
 * the depth count). Returns undefined if no balanced region is found.
 */
function findBalancedJson(text: string): string | undefined {
  const startIdx = text.search(/[{[]/);
  if (startIdx === -1) return undefined;

  const openChar = text[startIdx];
  const closeChar = openChar === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  return undefined;
}

/**
 * Extracts and parses JSON out of an LLM's raw text response. Throws an
 * Error (no custom subclass — callers only care that parsing failed, see
 * generateWorkflow.ts / editNode.ts's retry loop which maps any throw here to
 * a `code: 'parse'` validation issue) when no valid JSON can be found.
 */
export function extractJson(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('extractJson: phản hồi rỗng, không có JSON để parse.');
  }

  const fenced = extractFenced(raw);
  if (fenced !== undefined) {
    const parsed = tryParse(fenced);
    if (parsed) return parsed.value;
  }

  const direct = tryParse(raw.trim());
  if (direct) return direct.value;

  const balanced = findBalancedJson(raw);
  if (balanced !== undefined) {
    const parsed = tryParse(balanced);
    if (parsed) return parsed.value;
  }

  throw new Error('extractJson: không tìm thấy JSON hợp lệ trong phản hồi của model.');
}
