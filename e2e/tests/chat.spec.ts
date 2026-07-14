/**
 * FREE tier E2E for the AI-native chat loop (SPEC-step28.md §5) — real
 * browser + real server + real SQLite, but OpenRouter itself is a local mock
 * (`e2e/mock-openrouter.ts`, wired in by `playwright.config.ts`'s FREE-tier
 * `OPENROUTER_BASE_URL` override), so every scenario below runs at zero
 * cost. Skipped entirely for `E2E_REAL=1` (the mock must never intercept a
 * real-tier run).
 *
 * Each test creates its own fresh conversation (`+ Cuộc trò chuyện mới`) so
 * they're independent of each other and of `app.spec.ts`'s shared-server
 * state, and `beforeEach` resets the mock's recorded-requests log so each
 * test's own `GET /requests` assertions only ever see its own traffic.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Keep in sync with playwright.config.ts's `MOCK_OPENROUTER_PORT` (no shared
// source between the two configs, same as that file's own SERVER_PORT/
// WEB_PORT constants having none either).
const MOCK_PORT = 3979;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

// SPEC-step32.md B1 — a real image fixture for the composer-attachment test,
// same "point at samples/assets/ rather than fabricating bytes" convention
// as app.spec.ts's markdown-upload test (test 12) uses for its own fixture.
const ATTACHMENT_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../samples/assets/stock-coffee.jpg',
);

interface MockChatMessage {
  role: string;
  content: string;
}

interface MockRequestRecord {
  model?: unknown;
  messages: MockChatMessage[];
}

async function resetMock(): Promise<void> {
  const res = await fetch(`${MOCK_BASE_URL}/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`mock-openrouter /reset failed: HTTP ${res.status}`);
}

async function getMockRequests(): Promise<MockRequestRecord[]> {
  const res = await fetch(`${MOCK_BASE_URL}/requests`);
  return (await res.json()) as MockRequestRecord[];
}

function lastUserContent(messages: MockChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]!.content;
  }
  return '';
}

/**
 * System-prompt content of the request whose last user message equals
 * `userContent` exactly (searched newest-first). `pnpm run e2e` schedules
 * this file's tests strictly one-worker-sequential (Playwright's default,
 * `fullyParallel` unset) so in practice there's only ever one candidate —
 * but matching by exact content (instead of blindly trusting
 * `requests.at(-1)`) costs nothing and keeps this assertion correct even
 * under a stress run that forces concurrent scheduling (verified: this file
 * run with `--repeat-each` at the default worker count DOES occasionally
 * interleave requests from two repeats of the same test).
 */
function systemPromptFor(requests: MockRequestRecord[], userContent: string): string {
  for (let i = requests.length - 1; i >= 0; i--) {
    const req = requests[i]!;
    if (lastUserContent(req.messages ?? []) === userContent) {
      return req.messages.find((m) => m.role === 'system')?.content ?? '';
    }
  }
  return '';
}

// Same helper as app.spec.ts's own `openCanvasMode` — duplicated (not
// imported) so this file never re-executes that file's `test.describe`
// block as an import side effect. See that file for the full rationale.
async function openCanvasMode(page: Page): Promise<void> {
  await page.getByTestId('mode-canvas').click();
}

// Ditto for `clickPaletteAndAwaitLog`: with a conversation active, a palette
// click auto-persists via `POST /api/workflows/:id/changes` (the manual-log
// queue) — awaiting that response is what lets a caller immediately rely on
// the workflow's version having actually bumped server-side.
async function clickPaletteAndAwaitLog(page: Page, testId: string): Promise<void> {
  const logged = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /\/api\/workflows\/[^/]+\/changes$/.test(new URL(res.url()).pathname),
  );
  await page.getByTestId(testId).click();
  await logged;
}

async function startFreshConversation(page: Page): Promise<void> {
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('chat-rename-btn')).toBeVisible();
}

test.describe('FlowForge — chat loop (mock OpenRouter, free tier)', () => {
  // Real tier must behave exactly as before this step — the mock must never
  // run there, so these tests (which depend on it) don't either.
  test.skip(Boolean(process.env.E2E_REAL), 'mock OpenRouter chỉ chạy ở free tier');

  test.beforeEach(async () => {
    await resetMock();
  });

  // SPEC-step28.md §5.1 — landing hero -> "tạo văn bản" -> node materializes,
  // layout auto-splits, and the AI's change shows up in Lịch sử as a 🤖 row.
  test('1. Chat tạo workflow: "tạo văn bản" tạo node mock-text-1, tự chuyển split mode, log 🤖', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-hero')).toBeVisible();

    await page.getByTestId('chat-input').fill('tạo văn bản giúp tôi');
    await page.getByTestId('chat-input').press('Enter');

    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đã thêm node văn bản.' })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId('canvas-pane')).toHaveCSS('visibility', 'visible');
    await expect(page.locator('[data-testid="node-card"][data-node-id="mock-text-1"]')).toBeVisible();

    await page.getByTestId('history-tab').click();
    await expect(page.getByTestId('history-item')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('history-item').first()).toContainText('🤖');
  });

  // SPEC-step28.md §5.2 — a manual ("tay") canvas edit the AI hasn't seen
  // yet must show up in the NEXT turn's system prompt digest, marked `[tay]`.
  test('2. Digest thay đổi tay: sửa canvas tay rồi chat — system prompt của lượt sau chứa [tay]', async ({ page }) => {
    await page.goto('/');
    await startFreshConversation(page);
    await openCanvasMode(page);

    await clickPaletteAndAwaitLog(page, 'palette-input.text');
    await expect(page.getByTestId('node-card')).toHaveCount(1);

    await page.getByTestId('mode-chat').click();
    await page.getByTestId('chat-input').fill('chỉ trả lời đi');
    await page.getByTestId('chat-send').click();

    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đây là câu trả lời.' })).toBeVisible({
      timeout: 15_000,
    });

    const requests = await getMockRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(systemPromptFor(requests, 'chỉ trả lời đi')).toContain('[tay]');
  });

  // SPEC-step28.md §5.3 — reverting from Lịch sử itself becomes a digest
  // entry the very next turn sees (`routes/changes.ts`'s revert summary).
  test('3. Revert hiện trong digest: ↺ Khôi phục rồi chat — system prompt chứa "Khôi phục về trước thay đổi"', async ({
    page,
  }) => {
    await page.goto('/');
    await startFreshConversation(page);

    await page.getByTestId('chat-input').fill('tạo văn bản giúp tôi');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đã thêm node văn bản.' })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('history-tab').click();
    await expect(page.getByTestId('history-item')).toHaveCount(1, { timeout: 10_000 });

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('history-revert').click();
    await expect(page.getByTestId('node-card')).toHaveCount(0, { timeout: 10_000 });

    await page.getByTestId('chat-input').fill('chỉ trả lời tiếp');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đây là câu trả lời.' })).toBeVisible({
      timeout: 15_000,
    });

    const requests = await getMockRequests();
    expect(systemPromptFor(requests, 'chỉ trả lời tiếp')).toContain('Khôi phục về trước thay đổi');
  });

  // SPEC-step28.md §5.4 — clicking ■ Dừng mid-flight aborts the turn: the
  // assistant bubble surfaces the fail message, and the turn ends cleanly
  // (composer usable again — proven by actually sending a 2nd message).
  test('4. Stop: bấm ■ Dừng giữa lúc chờ — bubble lỗi "Đã dừng theo yêu cầu", composer dùng lại được', async ({
    page,
  }) => {
    await page.goto('/');
    await startFreshConversation(page);

    await page.getByTestId('chat-input').fill('làm gì đó chậm nhé');
    await page.getByTestId('chat-send').click();

    const sendButton = page.getByTestId('chat-send');
    await expect(sendButton).toHaveText('■ Dừng', { timeout: 5_000 });
    await sendButton.click();

    const errorBubble = page.locator('[data-testid="chat-message"][data-status="error"]');
    await expect(errorBubble).toContainText('Đã dừng theo yêu cầu', { timeout: 10_000 });
    await expect(sendButton).toHaveText('Gửi', { timeout: 10_000 });

    // Turn genuinely ended (not stuck) — the composer can send again.
    await page.getByTestId('chat-input').fill('chỉ trả lời đi');
    await sendButton.click();
    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đây là câu trả lời.' })).toBeVisible({
      timeout: 15_000,
    });
  });

  // SPEC-step28.md §5.5 — a hand-edit landing WHILE the LLM is "thinking"
  // (the mock's ~2s "chậm" delay) forces chatTurn.ts's optimistic-concurrency
  // rebuild-and-retry path: the mock must see ≥2 requests (original attempt +
  // rebuilt retry), and the turn must still finish successfully — not get
  // stuck pending, not fall through to the version-conflict fail-safe reply
  // (that only fires on a SECOND conflict within the same turn).
  test('5. Version-conflict rebuild: sửa canvas tay trong lúc chờ — mock nhận ≥2 request, turn vẫn hoàn tất', async ({
    page,
  }) => {
    test.setTimeout(45_000);

    await page.goto('/');
    await startFreshConversation(page);
    // Split (not canvas-only): the palette must be clickable WHILE the
    // composer's ■ Dừng/turn state is also visible, with no mode-switch
    // race against the mock's delay window.
    await page.getByTestId('mode-split').click();

    await page.getByTestId('chat-input').fill('làm gì đó chậm nhé');
    await page.getByTestId('chat-send').click();

    // Lands well inside the mock's ~2s delay on the FIRST attempt — bumps
    // the workflow's version out from under `runChatTurn`'s pre-apply check.
    await clickPaletteAndAwaitLog(page, 'palette-input.text');

    // The turn must still reach a real terminal state (not the fail-safe
    // "vừa được chỉnh tay" reply, which only fires on a 2nd conflict).
    await expect(page.getByTestId('chat-send')).toHaveText('Gửi', { timeout: 20_000 });
    const lastMessage = page.getByTestId('chat-message').last();
    await expect(lastMessage).toHaveAttribute('data-status', 'done', { timeout: 5_000 });
    await expect(lastMessage).not.toHaveText('');

    // Count only THIS turn's own requests (matched by its exact user
    // content) — see `systemPromptFor`'s doc comment on why exact-content
    // matching, not raw array length/position, is what's actually robust
    // here.
    const requests = await getMockRequests();
    const ownRequests = requests.filter((r) => lastUserContent(r.messages ?? []) === 'làm gì đó chậm nhé');
    expect(ownRequests.length).toBeGreaterThanOrEqual(2);
  });
});

// SPEC-step32.md B1/B2/B4 (Wave 3) — the same mock-OpenRouter + real
// browser/server/SQLite setup as the describe block above, covering the
// step32 UX-backlog pack: composer image attachments, the diff chip (+its
// reload-from-server path), and the AI-suggested conversation title.
// Content strings sent from each test are deliberately distinct from every
// scenario trigger used above (and from each other) so a conversation's
// auto-generated title (`routes/conversations.ts`'s `autoTitle`, first 8
// words of the first message) never collides with another test's — several
// assertions below select `conversation-item` by that exact title text, and
// the app DB/mock traffic persist across this whole file's tests.
test.describe('FlowForge — ux pack (step 32) (mock OpenRouter, free tier)', () => {
  test.skip(Boolean(process.env.E2E_REAL), 'mock OpenRouter chỉ chạy ở free tier');

  test.beforeEach(async () => {
    await resetMock();
  });

  // SPEC-step32.md B1 — attach an image via the composer's 📎 button before
  // sending: the chip shows a real thumbnail once upload finishes, the sent
  // user bubble carries the same thumbnail (both fresh and — implicitly,
  // since ChatPane renders it off `message.attachments` either way — on a
  // server reload), the POST body itself carries `attachments`, and the
  // note `chatTurn.ts`'s `attachmentsNote` appends reaches the LLM prompt.
  test('6. Đính kèm ảnh trong composer: chip thumbnail, bubble user hiện ảnh, POST + prompt AI có ghi chú đính kèm', async ({
    page,
  }) => {
    await page.goto('/');
    await startFreshConversation(page);

    await page.getByTestId('chat-attach-input').setInputFiles(ATTACHMENT_FIXTURE);
    // Chip flips uploading (Spinner) -> done (an <img>) once `POST /api/upload` resolves.
    const chipImg = page.locator('[data-testid="chat-attach-chip"] img');
    await expect(chipImg).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('chat-input').fill('chỉ trả lời đi kèm ảnh nhé');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    const sendReq = page.waitForRequest(
      (req) => req.method() === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(new URL(req.url()).pathname),
    );
    await page.getByTestId('chat-send').click();

    const req = await sendReq;
    const body = req.postDataJSON() as { content: string; attachments?: Array<{ path: string }> };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments?.[0]?.path).toMatch(/^uploads\/.+\.jpe?g$/);

    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đây là câu trả lời.' })).toBeVisible({
      timeout: 15_000,
    });

    // Composer cleared its chips on a successful send.
    await expect(page.getByTestId('chat-attach-chip')).toHaveCount(0);

    const userAttachment = page.getByTestId('chat-message-attachment');
    await expect(userAttachment).toBeVisible();
    await expect(userAttachment).toHaveAttribute('src', /^\/artifacts\/uploads\//);

    // `chatTurn.ts`'s `attachmentsNote` reached the actual LLM prompt (the
    // mock's `/chat/completions` sees the OpenAI-format request body).
    const requests = await getMockRequests();
    expect(requests.length).toBeGreaterThan(0);
    const lastContent = lastUserContent(requests.at(-1)!.messages ?? []);
    expect(lastContent).toContain('Đính kèm 1 ảnh đã upload sẵn');
    expect(lastContent).toContain('uploads/');
  });

  // SPEC-step32.md B2 — a turn that patches the workflow shows a diff chip
  // with the right aggregate count; clicking it while chat-only re-opens the
  // split (its CTA); reloading the page and re-selecting the conversation
  // from the rail still shows the same chip (`GET /api/conversations/:id`'s
  // `withDiff` join, B2-server).
  test('7. Diff chip: số đúng trên bubble AI, click mở lại split, còn nguyên sau khi tải lại trang', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-hero')).toBeVisible();

    await page.getByTestId('chat-input').fill('tạo văn bản để test diff chip nhé');
    await page.getByTestId('chat-input').press('Enter');

    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đã thêm node văn bản.' })).toBeVisible({
      timeout: 15_000,
    });

    const diffChip = page.getByTestId('chat-diff-chip');
    await expect(diffChip).toHaveText('🔧 +1 node');

    // Force chat-only, then use the chip's own CTA to re-open the split.
    await page.getByTestId('mode-chat').click();
    await expect(page.getByTestId('canvas-pane')).toHaveCSS('visibility', 'hidden');
    await diffChip.click();
    await expect(page.getByTestId('canvas-pane')).toHaveCSS('visibility', 'visible');

    // Reload wipes client state entirely — re-select the same conversation
    // from the rail (by its auto-generated title) and confirm the chip is
    // rebuilt from the server's own `diff` join, not just client memory.
    await page.reload();
    const item = page.getByTestId('conversation-item').filter({ hasText: 'tạo văn bản để test diff chip nhé' });
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
    await expect(page.getByTestId('chat-diff-chip')).toHaveText('🔧 +1 node', { timeout: 10_000 });
  });

  // SPEC-step32.md B4 — a turn answered while the conversation's title isn't
  // user-owned yet (`titleHint`) can rename it; the new title shows up both
  // in the rail (`ConversationRail`'s list) and in the header (mirrored into
  // `activeTitle`, surfaced here via the rename input's prefill value —
  // `startRename()` seeds it from `activeTitle`).
  test('8. AI đặt tên: turn đầu tự đặt tên workflow — hiện trên rail lẫn ô đổi tên', async ({ page }) => {
    await page.goto('/');
    await startFreshConversation(page);

    await page.getByTestId('chat-input').fill('đặt tên hộ mình với nhé');
    await page.getByTestId('chat-send').click();

    await expect(page.getByTestId('chat-message').filter({ hasText: 'Đã tạo workflow và đặt tên giúp bạn.' })).toBeVisible({
      timeout: 15_000,
    });

    const aiTitle = 'Chatbot CSKH tự động'; // must match e2e/mock-openrouter.ts's 'đặt tên hộ' scenario
    await expect(page.getByTestId('conversation-item').filter({ hasText: aiTitle })).toBeVisible();

    await page.getByTestId('chat-rename-btn').click();
    await expect(page.getByTestId('chat-rename-input')).toHaveValue(aiTitle);
  });
});
