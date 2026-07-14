/**
 * Mock OpenRouter HTTP server (SPEC-step28.md §3) — a tiny `node:http`
 * server (no new dependency) that stands in for `https://openrouter.ai`
 * during the FREE-tier e2e run (`e2e/playwright.config.ts` points the real
 * server's `OPENROUTER_BASE_URL` at this instead), so `e2e/tests/chat.spec.ts`
 * can drive the real chat/agent loop (`apps/server/src/agent/chatTurn.ts`
 * -> `nodes/providers/openrouter.ts`'s `chatCompletion`) at zero cost and
 * fully deterministically.
 *
 * Endpoints:
 * - `POST /chat/completions` — the one `chatCompletion()` actually calls
 *   (`${OPENROUTER_BASE_URL}/chat/completions`). Reads the OpenAI-format
 *   `{ model, messages, temperature, max_tokens? }` body, records it (see
 *   `GET /requests` below), picks a canned scenario by matching a substring
 *   against the content of the LAST `role: 'user'` message, and replies
 *   wrapped in the exact shape `chatCompletion()` parses:
 *   `{ choices: [{ message: { content: '<JSON-stringified {reply, ops}>' } }] }`.
 *   Every scenario's `ops` are valid patch ops against the REAL NodeRegistry
 *   (an `input.text` node — see `apps/server/src/nodes/input.text.ts`'s
 *   `{ value: string }` params schema) so `applyPatch` + `validateWorkflow`
 *   in `chatTurn.ts` actually accept them.
 * - `GET /requests` — every recorded request body, oldest first (also
 *   doubles as this server's Playwright `webServer.url` readiness probe —
 *   it 200s with `[]` before any request has landed).
 * - `POST /reset` — clears the recorded-requests array. Called from
 *   `chat.spec.ts`'s `beforeEach` so each test's `GET /requests` assertions
 *   only ever see that test's own traffic.
 *
 * Runs standalone via `tsx e2e/mock-openrouter.ts` (see playwright.config.ts's
 * webServer entry) — port from `process.env.PORT`, default 3979.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT) || 3979;
const HOST = '127.0.0.1';

/** SPEC-step28.md §5.4/§5.5 — "chậm" scenario delay before responding.
 * Long enough that a "bấm ■ Dừng" click (test 4) lands well before it, and
 * that a hand-edit dragged into the canvas (test 5) lands before this
 * resolves. Deliberately > the mock's own near-0ms response time for every
 * other scenario, and comfortably under the free-tier per-test timeout
 * (playwright.config.ts: 30s) even doubled (the version-conflict test
 * triggers this delay TWICE — once per rebuild attempt). */
const SLOW_DELAY_MS = 2000;

interface ChatMessageLike {
  role: string;
  content: string;
}

interface RecordedRequest {
  model?: unknown;
  messages: ChatMessageLike[];
  temperature?: unknown;
  max_tokens?: unknown;
}

/** In-memory, oldest-first — cleared by `POST /reset`. */
const requests: RecordedRequest[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function lastUserContent(messages: ChatMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]!.content;
  }
  return '';
}

interface Scenario {
  reply: string;
  ops: unknown[];
  delayMs: number;
  /** SPEC-step32.md B4 — only a couple of scenarios set this; `respond()`
   * below omits the `title` key entirely from the JSON payload when absent
   * (mirrors `ChatTurnResponseSchema`'s `title` being `optional()`, and lets
   * every pre-step32 scenario/test stay byte-identical). */
  title?: string;
}

/**
 * Deterministic scenario selection (SPEC-step28.md §3) — matched by
 * substring against the last user message, checked most-specific-first
 * (none of the 3 trigger substrings actually overlap in the fixtures
 * `chat.spec.ts` sends, but ordering them this way keeps the function
 * unambiguous even if a future test message happened to contain more than
 * one trigger word).
 */
function scenarioFor(userContent: string): Scenario {
  if (userContent.includes('tạo văn bản')) {
    return {
      reply: 'Đã thêm node văn bản.',
      ops: [{ op: 'add-node', node: { id: 'mock-text-1', type: 'input.text', params: { value: 'xin chào' } } }],
      delayMs: 0,
    };
  }
  if (userContent.includes('chậm')) {
    return {
      reply: 'Đã xử lý xong (chậm).',
      ops: [{ op: 'add-node', node: { id: 'mock-slow-1', type: 'input.text', params: { value: 'chậm' } } }],
      delayMs: SLOW_DELAY_MS,
    };
  }
  if (userContent.includes('chỉ trả lời')) {
    return { reply: 'Đây là câu trả lời.', ops: [], delayMs: 0 };
  }
  // SPEC-step32.md B4 — the ONLY scenario that returns a `title`, so
  // `chat.spec.ts`'s AI-title test gets a turn that both patches the
  // workflow (title also gets stamped onto `workflow.name`, chatTurn.ts) and
  // renames the conversation, same as a real turn would.
  if (userContent.includes('đặt tên hộ')) {
    return {
      reply: 'Đã tạo workflow và đặt tên giúp bạn.',
      ops: [{ op: 'add-node', node: { id: 'mock-title-1', type: 'input.text', params: { value: 'nội dung' } } }],
      title: 'Chatbot CSKH tự động',
      delayMs: 0,
    };
  }
  return { reply: 'OK.', ops: [], delayMs: 0 };
}

function handleChatCompletions(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'failed to read request body' });
      return;
    }

    let parsed: RecordedRequest;
    try {
      parsed = JSON.parse(raw) as RecordedRequest;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    // Recorded immediately (before any scenario delay) — GET /requests
    // during a "chậm" scenario's wait already reflects this request, and
    // the version-conflict test's "≥2 requests" assertion only needs both
    // attempts to have reached this point, not to have been answered yet.
    requests.push(parsed);

    const scenario = scenarioFor(lastUserContent(parsed.messages ?? []));

    const respond = (): void => {
      const content = JSON.stringify({
        reply: scenario.reply,
        ops: scenario.ops,
        ...(scenario.title ? { title: scenario.title } : {}),
      });
      sendJson(res, 200, { choices: [{ message: { content } }] });
    };

    if (scenario.delayMs <= 0) {
      respond();
      return;
    }

    const timer = setTimeout(respond, scenario.delayMs);
    // A client abort (chatTurnManager.stop() aborts the fetch, or the
    // request's timeout fires) closes this response's underlying socket —
    // without this, `respond()` would still fire later and try to write to
    // an already-closed response, and the timer would otherwise keep the
    // mock server's event loop alive for `delayMs` past the point where
    // anyone still cares about the answer.
    res.on('close', () => clearTimeout(timer));
  })();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/reset') {
    requests.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/requests') {
    sendJson(res, 200, requests);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat/completions') {
    handleChatCompletions(req, res);
    return;
  }

  sendJson(res, 404, { error: `mock-openrouter: no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-openrouter] listening on http://${HOST}:${PORT}`);
});
