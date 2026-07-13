/**
 * FREE tier E2E (SPEC-step7.md §3): only utility nodes (`input.text`,
 * `text.template`, `output.collect`) — zero API cost, safe to run anytime.
 * Must pass 100% reliably, twice in a row.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Matches playwright.config.ts's `FLOWFORGE_ARTIFACTS_DIR` for the free tier
// (`path.join(tmpDir, 'artifacts')` where `tmpDir = e2e/.tmp`) — used by test
// 11 (SPEC-step9.md §4) to drop a fixture image straight on disk so a
// zero-cost `input.file` node can reference it (no fal.ai call needed to
// exercise the ResultsPanel's media/download rendering).
const artifactsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.tmp/artifacts');

// SPEC-step23.md §8 test 14 — same `e2e/.tmp` scratch dir playwright.config.ts
// points the running server at, so `pnpm --filter server seed` (run from a
// separate child process, DB closed before it returns) operates on the
// exact DB/artifacts the already-running webServer has open.
const e2eRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.join(e2eRoot, '..');
const e2eDbPath = path.join(e2eRoot, '.tmp', 'e2e.db');

// A valid, minimal 1x1 transparent PNG — content doesn't matter, only that
// `input.file` accepts it as a real file and the browser can point an <img>
// at it.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const PALETTE_TYPES = [
  'input.text',
  'input.file',
  'text.template',
  'output.collect',
  'llm.generate',
  'llm.transform',
  'fal.image',
  'fal.video',
  'vbee.tts',
];

interface WorkflowNodeLike {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position?: { x: number; y: number };
}

interface WorkflowLike {
  version: 1;
  id: string;
  name: string;
  nodes: WorkflowNodeLike[];
  edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }>;
}

function sampleWorkflow(): WorkflowLike {
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: `e2e sample ${Date.now()}`,
    nodes: [
      { id: 'input_1', type: 'input.text', params: { value: 'xin chào' }, position: { x: 40, y: 40 } },
      {
        id: 'text_template_1',
        type: 'text.template',
        params: { template: 'Lời chào: {{a}}' },
        position: { x: 320, y: 40 },
      },
      { id: 'output_collect_1', type: 'output.collect', params: {}, position: { x: 600, y: 40 } },
    ],
    edges: [
      { id: 'e_1', from: { node: 'input_1', port: 'text' }, to: { node: 'text_template_1', port: 'a' } },
      { id: 'e_2', from: { node: 'text_template_1', port: 'text' }, to: { node: 'output_collect_1', port: 'in1' } },
    ],
  };
}

/**
 * Clicks a run button and waits for the run *it actually triggers* to
 * finish — not for stale UI left over from a previous run.
 *
 * A previous free-tier run (utility nodes only, no real I/O) can complete
 * so fast that the store's synchronous `runStatus: 'running'` reset
 * (apps/web/src/store/flow.ts `run()`) and the SSE-driven flip back to
 * `'success'` land in the same UI tick — there is no reliable window in
 * which the DOM ever shows "status: running" for Playwright to observe.
 * Waiting on that text is therefore not just occasionally flaky, it can be
 * unobservable by construction, and previously the test fell back to
 * reading whatever `data-state`/`status:` text was already on screen —
 * which could be the *previous* run's "success", making the wait vacuous.
 *
 * Instead: capture the `POST /api/runs` response to learn the new run's
 * id, then poll `GET /api/runs/:id` (server truth, independent of any UI
 * render race) until that specific run reaches a terminal status. Only
 * then assert the UI has caught up.
 */
async function runAndWaitForSuccess(
  page: Page,
  cards: import('@playwright/test').Locator,
  buttonTestId: string,
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/runs',
  );
  await page.getByTestId(buttonTestId).click();
  const response = await responsePromise;
  const { runId } = (await response.json()) as { runId: string };

  await expect
    .poll(
      async () => {
        const runRes = await page.request.get(`/api/runs/${runId}`);
        const snapshot = (await runRes.json()) as { run: { status: string } };
        return snapshot.run.status;
      },
      { timeout: 20_000 },
    )
    .toBe('success');

  const header = page.locator('header');
  await expect(header).toContainText('status: success', { timeout: 20_000 });
  for (const card of await cards.all()) {
    await expect(card).toHaveAttribute('data-state', 'success', { timeout: 20_000 });
  }
}

// SPEC-step24.md §7 — the landing layout is chat-only (`splitRatio` inits to
// 1.0, chat-first) by default on every fresh page load (each test gets its
// own isolated browser context, so `ff.splitRatio` never carries over from
// an earlier test) — CanvasPane (Sidebar/palette/node-card/right-panel) is
// mounted but `visibility: hidden` and effectively 0px wide in that mode, so
// any test whose FIRST canvas/palette/params interaction is a `.click()`,
// `.fill()`, or `.toBeVisible()` on something inside it must switch modes
// first, or Playwright's actionability checks (which require real
// visibility) time out.
async function openCanvasMode(page: Page): Promise<void> {
  await page.getByTestId('mode-canvas').click();
}

async function openSplitMode(page: Page): Promise<void> {
  await page.getByTestId('mode-split').click();
}

/**
 * A mode change animates `flex-grow` over 300ms (store/chat.ts's
 * `SPLIT_ANIMATE_MS`, `{ animate: true }` calls) — reading `boundingBox()`
 * exactly once right after the click can catch it mid-transition. Wrapped
 * in `expect.poll()` (same pattern `runAndWaitForSuccess` above already
 * uses for a different kind of eventual consistency) so assertions against
 * a pane's rendered width wait out the transition instead of racing it.
 */
async function paneWidth(locator: import('@playwright/test').Locator): Promise<number> {
  const box = await locator.boundingBox();
  return box?.width ?? 0;
}

/** Opens the JSON view, replaces the textarea with `wf`, clicks Apply, closes the overlay. */
async function applyWorkflowViaJsonView(page: Page, wf: WorkflowLike): Promise<void> {
  await page.getByTestId('json-view-btn').click();
  const textarea = page.getByTestId('json-view-textarea');
  await textarea.click();
  await textarea.fill(JSON.stringify(wf, null, 2));
  await page.getByTestId('json-view-apply').click();
  await expect(page.getByTestId('json-view-error')).toHaveCount(0);
  await page.keyboard.press('Escape').catch(() => undefined);
  // The overlay closes on outside-click / its own ✕ button, not Escape —
  // click outside the panel to close it.
  await page.mouse.click(5, 5);
}

/**
 * SPEC-step27.md §3/§4 — with an active conversation, clicking a palette
 * entry auto-persists immediately via `POST /api/workflows/:id/changes`
 * (store/manualLog.ts's queue) instead of only marking the workflow `dirty`
 * for a later manual Save. Clicks the palette entry and waits for that
 * request to resolve, so a caller that immediately reloads/re-fetches the
 * workflow server-side (or reselects the conversation from the rail) sees
 * the node that was just added.
 */
async function clickPaletteAndAwaitLog(page: Page, testId: string): Promise<void> {
  const logged = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /\/api\/workflows\/[^/]+\/changes$/.test(new URL(res.url()).pathname),
  );
  await page.getByTestId(testId).click();
  await logged;
}

test.describe('FlowForge — free tier (utility nodes only)', () => {
  test('1. App load: sidebar shows all 9 node types, toolbar has its buttons', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    for (const type of PALETTE_TYPES) {
      await expect(page.getByTestId(`palette-${type}`)).toBeVisible();
    }
    await expect(page.getByTestId('save-btn')).toBeVisible();
    await expect(page.getByTestId('validate-btn')).toBeVisible();
    await expect(page.getByTestId('run-btn')).toBeVisible();
    await expect(page.getByTestId('run-force-btn')).toBeVisible();
    await expect(page.getByTestId('mode-chat')).toBeVisible();
    await expect(page.getByTestId('mode-split')).toBeVisible();
    await expect(page.getByTestId('mode-canvas')).toBeVisible();
    await expect(page.getByTestId('json-view-btn')).toBeVisible();
    await expect(page.getByTestId('settings-btn')).toBeVisible();
  });

  test('2. Add node from palette: clicking a palette entry adds one node-card', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await expect(page.getByTestId('node-card')).toHaveCount(0);
    await page.getByTestId('palette-input.text').click();
    await expect(page.getByTestId('node-card')).toHaveCount(1);
  });

  test('3. Params edit: editing a value in ParamsPanel is reflected in the JSON view', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await page.getByTestId('palette-input.text').click();
    await page.getByTestId('node-card').click();

    // Scoped to the right panel (SPEC-step23.md §7 added `data-testid=
    // "right-panel"`) — a bare `input[type="text"]` would now also match
    // ConversationRail's search box, which sits earlier in the DOM.
    const valueInput = page.getByTestId('right-panel').locator('input[type="text"]').first();
    await valueInput.fill('hello from e2e');

    await page.getByTestId('json-view-btn').click();
    await expect(page.getByTestId('json-view-textarea')).toContainText('hello from e2e');
  });

  test('4. Happy run: sample workflow runs to success with the expected preview text', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await applyWorkflowViaJsonView(page, sampleWorkflow());

    // SPEC-step15.md §5 free-tier assert: a utility-only workflow (no
    // fal/vbee/llm nodes) has zero estimated cost — the 💰 toolbar badge
    // should settle on ~$0.00 once its debounced POST /api/estimate resolves.
    await expect(page.getByTestId('cost-estimate')).toContainText('~$0.00', { timeout: 10_000 });

    await page.getByTestId('save-btn').click();
    await page.getByTestId('run-btn').click();

    const cards = page.getByTestId('node-card');
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) {
      await expect(card).toHaveAttribute('data-state', 'success', { timeout: 20_000 });
    }

    const templateCard = page.locator('[data-testid="node-card"][data-node-id="text_template_1"]');
    await expect(templateCard.getByTestId('node-preview')).toContainText('Lời chào: xin chào');

    await expect(page.locator('header')).toContainText('status: success');
  });

  test('5. Cache: a second run shows the cache badge; force-run clears it', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await applyWorkflowViaJsonView(page, sampleWorkflow());
    await page.getByTestId('save-btn').click();

    const cards = page.getByTestId('node-card');
    await runAndWaitForSuccess(page, cards, 'run-btn');

    // Second run of the same, unchanged workflow -> at least one node hits cache.
    await runAndWaitForSuccess(page, cards, 'run-btn');
    await expect(page.locator('text=⚡cache').first()).toBeVisible();

    // Force re-run (bypass cache) -> the badge disappears.
    await runAndWaitForSuccess(page, cards, 'run-force-btn');
    await expect(page.locator('text=⚡cache')).toHaveCount(0);
  });

  test('6. JSON view error: broken JSON shows an inline error and does not touch the store', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await page.getByTestId('palette-input.text').click();
    await expect(page.getByTestId('node-card')).toHaveCount(1);

    await page.getByTestId('json-view-btn').click();
    const textarea = page.getByTestId('json-view-textarea');
    await textarea.click();
    await textarea.fill('{ this is not valid json');
    await page.getByTestId('json-view-apply').click();

    await expect(page.getByTestId('json-view-error')).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.getByTestId('node-card')).toHaveCount(1);
  });

  test('7. Validate: a workflow with a missing required input surfaces an issue; clicking it selects the node', async ({
    page,
  }) => {
    await page.goto('/');
    await openCanvasMode(page);
    const wf: WorkflowLike = {
      version: 1,
      id: crypto.randomUUID(),
      name: 'e2e invalid',
      nodes: [{ id: 'llm_generate_1', type: 'llm.generate', params: {}, position: { x: 40, y: 40 } }],
      edges: [],
    };
    await applyWorkflowViaJsonView(page, wf);

    await page.getByTestId('validate-btn').click();
    const issueButton = page.locator('button', { hasText: 'llm_generate_1' }).first();
    // Fall back to matching any issue text if the node id isn't inlined —
    // the important assertion is that at least one issue is listed.
    const anyIssue = page.locator('text=/\\[.*\\]/').first();
    if (await issueButton.count() > 0) {
      await issueButton.click();
    } else {
      await expect(anyIssue).toBeVisible();
      await anyIssue.click();
    }

    // SPEC-step18.md §5.3: selection is a thicker 4px black border
    // (`border-[4px]`), not the old blue Tailwind `ring-*` treatment.
    const selectedCard = page.locator('[data-testid="node-card"][class*="border-[4px]"]');
    await expect(selectedCard).toHaveCount(1);
  });

  // SPEC-step23.md §7/§8 — WorkflowList's "Workflows" browsing modal is gone;
  // reopening a saved workflow now goes through ConversationRail's
  // conversation-item list instead. A conversation is 1-1 with a workflow
  // (DESIGN-ai-native.md §II.4), so this test starts from "+ Cuộc trò chuyện
  // mới" (which claims a real server-side workflow id up front) rather than
  // building the sample workflow onto a fresh client-generated id — the
  // latter would save as an orphan workflow with no paired conversation,
  // invisible in the rail until the next server restart's backfill.
  test('8. Persistence: saved workflow survives a page reload (via a conversation)', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('new-conversation').click();
    // Confirms selectConversation's GET already resolved (ChatPane only
    // renders this button once `activeConversationId` is set) before doing
    // anything that depends on the freshly-adopted workflow below.
    await expect(page.getByTestId('chat-rename-btn')).toBeVisible();
    await expect(page.getByTestId('node-card')).toHaveCount(0);

    // Conversation titles default to '' until a chat message auto-titles
    // them (routes/conversations.ts §4.6) — rename it to something unique so
    // it's findable in the rail after reload without sending a real message
    // (which would cost a real OpenRouter call).
    const title = `e2e persistence ${Date.now()}`;
    await page.getByTestId('chat-rename-btn').click();
    await page.getByTestId('chat-rename-input').fill(title);
    await page.getByTestId('chat-rename-input').press('Enter');
    await expect(page.getByTestId('chat-pane').getByText(title)).toBeVisible();

    // Switch to canvas mode (chat is full-width by default) before the
    // palette clicks below — its buttons are hidden/0px-wide otherwise.
    await openCanvasMode(page);

    // Add 3 nodes directly via the palette rather than round-tripping through
    // the JSON view — this mutates whatever workflow id is *currently*
    // adopted in the store, so there's no separate "read the id back out,
    // then reapply a whole new workflow object onto it" step that could race
    // with the just-finished conversation adoption above.
    //
    // SPEC-step27.md: each click auto-persists via the manual-change queue
    // (this conversation is active) — Save is no longer what makes the
    // workflow survive a reload, so this waits for each add's own log POST
    // instead of clicking Save. `save-btn` correctly stays disabled
    // throughout (checked below) since `dirty` is never set for a logged op.
    await clickPaletteAndAwaitLog(page, 'palette-input.text');
    await clickPaletteAndAwaitLog(page, 'palette-text.template');
    await clickPaletteAndAwaitLog(page, 'palette-output.collect');
    await expect(page.getByTestId('node-card')).toHaveCount(3);
    await expect(page.getByTestId('save-btn')).toBeDisabled();

    await page.reload();
    await page.getByTestId('palette-input.text').waitFor();

    // `.first()`: the item's title button renders before its ✕ delete
    // button — both are `<button>` elements, so this picks the title one.
    const item = page.getByTestId('conversation-item').filter({ hasText: title });
    await item.getByRole('button').first().click();

    await expect(page.getByTestId('node-card')).toHaveCount(3);
  });

  test('9. Runs history: the Runs tab lists at least 2 runs; opening an old one shows its states', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await applyWorkflowViaJsonView(page, sampleWorkflow());
    await page.getByTestId('save-btn').click();

    const cards = page.getByTestId('node-card');
    await runAndWaitForSuccess(page, cards, 'run-btn');
    await runAndWaitForSuccess(page, cards, 'run-force-btn');

    await page.getByTestId('runs-tab').click();
    const items = page.getByTestId('run-history-item');
    await expect(items).toHaveCount(2, { timeout: 10_000 });

    await items.last().click();
    await expect(page.getByTestId('node-card').first()).toHaveAttribute('data-state', 'success');
  });

  test('10. Settings mask: secret fields never render the raw key value', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-btn').click();

    const fields = page.locator('[data-testid^="settings-field-"]');
    await expect(fields).toHaveCount(5);

    for (const field of await fields.all()) {
      const value = await field.inputValue();
      const placeholder = await field.getAttribute('placeholder');
      // A raw API key/secret is long and contiguous; the mask is
      // '••••' + last 4 chars, well under 20 characters.
      expect(value.length).toBeLessThan(20);
      if (placeholder) expect(placeholder.length).toBeLessThan(20);
    }

    // Cross-check against the server's own masked previews (last 4 chars of
    // each *set* secret) rather than relying only on a prefix blocklist —
    // `sk-`/`Bearer`/`eyJ` only catches 2 of the 3 providers' known secret
    // shapes, and a regression could echo a full secret in a DOM location a
    // prefix check never sees (a data attribute, inline JSON, error text).
    // The server never returns the full secret — only the masked preview —
    // so this never reads/prints a raw value.
    const settingsRes = await page.request.get('/api/settings');
    const { settings } = (await settingsRes.json()) as {
      settings: Array<{ secret: boolean; isSet: boolean; preview: string | null }>;
    };
    const secretSuffixes = settings
      .filter((s) => s.secret && s.isSet && s.preview && s.preview !== '••••')
      .map((s) => (s.preview as string).slice(-4));

    const content = await page.content();
    // No 20+ character alnum/symbol run that isn't part of the page's own
    // markup/CSS should be present — a crude guard against a leaked secret.
    const suspicious = content.match(/[A-Za-z0-9_-]{24,}/g) ?? [];
    for (const token of suspicious) {
      // Reject known secret-value prefixes (OpenRouter/Bearer bearer tokens,
      // and Vbee's JWT tokens which start with "eyJ") ...
      expect(token).not.toMatch(/^(sk-|Bearer|eyJ)/);
      // ... and, regardless of prefix, reject any token that ends with the
      // last-4 chars of a secret the server has confirmed is actually set.
      for (const suffix of secretSuffixes) {
        expect(token.endsWith(suffix)).toBe(false);
      }
    }
  });

  test('11. Kết quả tab (SPEC-step9.md §2): auto-opens after a run, shows the final text + a working copy button + a media download link with ?download=1', async ({
    page,
  }) => {
    const fixtureName = `${crypto.randomUUID()}.png`;
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, fixtureName), Buffer.from(TINY_PNG_BASE64, 'base64'));

    await page.goto('/');
    await openCanvasMode(page);
    const wf: WorkflowLike = {
      version: 1,
      id: crypto.randomUUID(),
      name: `e2e results tab ${Date.now()}`,
      nodes: [
        { id: 'input_1', type: 'input.text', params: { value: 'xin chào' }, position: { x: 40, y: 40 } },
        {
          id: 'text_template_1',
          type: 'text.template',
          params: { template: 'Lời chào: {{a}}' },
          position: { x: 320, y: 40 },
        },
        { id: 'input_file_1', type: 'input.file', params: { path: fixtureName }, position: { x: 320, y: 220 } },
        { id: 'output_collect_1', type: 'output.collect', params: {}, position: { x: 600, y: 100 } },
      ],
      edges: [
        { id: 'e_1', from: { node: 'input_1', port: 'text' }, to: { node: 'text_template_1', port: 'a' } },
        { id: 'e_2', from: { node: 'text_template_1', port: 'text' }, to: { node: 'output_collect_1', port: 'in1' } },
        { id: 'e_3', from: { node: 'input_file_1', port: 'file' }, to: { node: 'output_collect_1', port: 'in2' } },
      ],
    };
    await applyWorkflowViaJsonView(page, wf);
    await page.getByTestId('save-btn').click();

    const cards = page.getByTestId('node-card');
    await runAndWaitForSuccess(page, cards, 'run-btn');

    // Auto-switch (SPEC-step9.md §2): no click on the "Kết quả" tab itself.
    const resultsPanel = page.getByTestId('results-panel');
    await expect(resultsPanel).toBeVisible();
    await expect(resultsPanel).toContainText('Lời chào: xin chào');
    await expect(page.getByTestId('result-copy-btn').first()).toBeVisible();

    const downloadLink = page.getByTestId('result-download-link').first();
    await expect(downloadLink).toHaveAttribute('href', /\?download=1$/);
  });

  // SPEC-step10.md §3: a real browser upload (via the ParamsPanel's file
  // chooser on an `input.markdown` node), not a fixture dropped straight
  // into artifactsDir like test 11 — this exercises `POST /api/upload` end
  // to end through the UI, zero-cost (input.markdown/text.template are pure
  // utility nodes).
  test('12. Markdown upload: choosing a local .md file uploads it, sets the node\'s path, and its content flows through to Kết quả', async ({
    page,
  }) => {
    const mdContent = '# Xin chào từ upload e2e\n\nĐây là nội dung tải lên qua browser.';
    const mdDir = path.join(os.tmpdir(), `ff-e2e-md-${crypto.randomUUID()}`);
    mkdirSync(mdDir, { recursive: true });
    const mdPath = path.join(mdDir, 'note.md');
    writeFileSync(mdPath, mdContent, 'utf-8');

    await page.goto('/');
    await openCanvasMode(page);
    const wf: WorkflowLike = {
      version: 1,
      id: crypto.randomUUID(),
      name: `e2e markdown upload ${Date.now()}`,
      nodes: [
        { id: 'input_markdown_1', type: 'input.markdown', params: {}, position: { x: 40, y: 40 } },
        { id: 'text_template_1', type: 'text.template', params: { template: '{{a}}' }, position: { x: 320, y: 40 } },
        { id: 'output_collect_1', type: 'output.collect', params: {}, position: { x: 600, y: 40 } },
      ],
      edges: [
        { id: 'e_1', from: { node: 'input_markdown_1', port: 'text' }, to: { node: 'text_template_1', port: 'a' } },
        { id: 'e_2', from: { node: 'text_template_1', port: 'text' }, to: { node: 'output_collect_1', port: 'in1' } },
      ],
    };
    await applyWorkflowViaJsonView(page, wf);

    await page.locator('[data-testid="node-card"][data-node-id="input_markdown_1"]').click();
    await page.getByTestId('upload-file-input').setInputFiles(mdPath);
    await expect(page.getByText(/Đã chọn: note\.md/)).toBeVisible();

    // The upload response's `path` landed in the node's params.
    await page.getByTestId('json-view-btn').click();
    await expect(page.getByTestId('json-view-textarea')).toContainText('uploads/');
    await page.mouse.click(5, 5);

    await page.getByTestId('save-btn').click();

    const cards = page.getByTestId('node-card');
    await runAndWaitForSuccess(page, cards, 'run-btn');

    const resultsPanel = page.getByTestId('results-panel');
    await expect(resultsPanel).toBeVisible();
    await expect(resultsPanel).toContainText('Xin chào từ upload e2e');
    await expect(resultsPanel).toContainText('Đây là nội dung tải lên qua browser.');
  });

  // SPEC-step16.md §4: reproduces the user's "nodes overlapping after
  // ✨ generate" bug directly (all positions pinned to the same point) and
  // asserts the 🪄 Sắp xếp button actually separates them.
  test('13. Auto-layout: nodes applied on top of each other are separated after clicking 🪄 Sắp xếp', async ({
    page,
  }) => {
    await page.goto('/');
    await openCanvasMode(page);
    const wf: WorkflowLike = {
      version: 1,
      id: crypto.randomUUID(),
      name: `e2e auto-layout ${Date.now()}`,
      nodes: [
        { id: 'input_1', type: 'input.text', params: { value: 'a' }, position: { x: 400, y: 400 } },
        {
          id: 'text_template_1',
          type: 'text.template',
          params: { template: '{{a}}' },
          position: { x: 400, y: 400 },
        },
        { id: 'output_collect_1', type: 'output.collect', params: {}, position: { x: 400, y: 400 } },
      ],
      edges: [
        { id: 'e_1', from: { node: 'input_1', port: 'text' }, to: { node: 'text_template_1', port: 'a' } },
        { id: 'e_2', from: { node: 'text_template_1', port: 'text' }, to: { node: 'output_collect_1', port: 'in1' } },
      ],
    };
    await applyWorkflowViaJsonView(page, wf);
    await expect(page.getByTestId('node-card')).toHaveCount(3);

    await page.getByTestId('auto-layout-btn').click();

    // Read positions back via the JSON view (server/store truth), same
    // approach `applyWorkflowViaJsonView` already relies on for round-trips.
    await page.getByTestId('json-view-btn').click();
    const textarea = page.getByTestId('json-view-textarea');
    const jsonText = await textarea.inputValue();
    await page.mouse.click(5, 5);

    const laidOut = JSON.parse(jsonText) as WorkflowLike;
    const positions = laidOut.nodes.map((n) => n.position);
    for (const p of positions) {
      expect(p).toBeDefined();
    }
    // All three previously sat on the exact same point (400,400) — no two
    // should still coincide after auto-layout.
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        expect(positions[i]).not.toEqual(positions[j]);
      }
    }

    // The graph is also visually still intact (no node lost/duplicated).
    await expect(page.getByTestId('node-card')).toHaveCount(3);
  });

  // SPEC-step23.md §8 (a) — end-to-end verification of the backfill
  // migration (DESIGN-ai-native.md §8 / db/backfill.ts): running the real
  // seed script against this same run's scratch DB must make every seeded
  // sample show up in the rail as its own conversation.
  test('14. Backfill: after seeding the 11 sample workflows, the rail lists at least 11 conversations', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    try {
      execFileSync('pnpm', ['--filter', 'server', 'seed'], {
        cwd: repoRoot,
        env: { ...process.env, FLOWFORGE_DB_PATH: e2eDbPath, FLOWFORGE_ARTIFACTS_DIR: artifactsDir },
        stdio: 'pipe',
      });
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      console.error('seed-samples failed:\n', stdout?.toString(), stderr?.toString());
      throw err;
    }

    await page.goto('/');
    await expect
      .poll(async () => page.getByTestId('conversation-item').count(), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(11);
  });

  // SPEC-step23.md §8 (b) — "+ Cuộc trò chuyện mới" creates a fresh
  // conversation+workflow pair and selects it immediately.
  test('15. ConversationRail: "+ Cuộc trò chuyện mới" adds a new item and clears the canvas', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);
    await page.getByTestId('palette-input.text').waitFor();

    // Not asserting an exact/incremented `conversation-item` count here —
    // earlier tests in this same run (shared server/DB) may have already
    // created any number of conversations, and reading a "before" baseline
    // right after navigation races App.tsx's own mount-time
    // `loadConversations()` fetch. `newConversation()` always prepends the
    // freshly created (and immediately selected) conversation to the front
    // of the list, so asserting the first item is active + the canvas is
    // empty is enough to prove one was actually created.
    await page.getByTestId('new-conversation').click();

    await expect(page.getByTestId('conversation-item').first()).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('node-card')).toHaveCount(0);
  });

  // SPEC-step23.md §8 (c) — deleting a conversation removes it from the rail
  // (confirm dialog accepted, mirrors WorkflowList's old delete UX).
  test('16. ConversationRail: deleting a conversation removes it from the rail', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-conversation').click();

    const title = `e2e delete-me ${Date.now()}`;
    await page.getByTestId('chat-rename-btn').click();
    await page.getByTestId('chat-rename-input').fill(title);
    await page.getByTestId('chat-rename-input').press('Enter');
    await expect(page.getByTestId('chat-pane').getByText(title)).toBeVisible();

    const item = page.getByTestId('conversation-item').filter({ hasText: title });
    await expect(item).toHaveCount(1);

    page.once('dialog', (dialog) => void dialog.accept());
    await item.getByTestId('conversation-delete-btn').click();

    await expect(page.getByTestId('conversation-item').filter({ hasText: title })).toHaveCount(0);
  });

  // SPEC-step24.md §7 (a) — a fresh app load (isolated browser context, so
  // `ff.splitRatio` was never persisted) lands on the chat-first landing
  // hero, full width, with the canvas pane mounted but hidden.
  test('17. Landing hero: a fresh app load shows chat full-width and hides the canvas pane', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-hero')).toBeVisible();
    await expect(page.getByTestId('canvas-pane')).toHaveCSS('visibility', 'hidden');
  });

  // SPEC-step24.md §7 (b) — the 3 Mode Toggle buttons switch the layout;
  // the canvas pane's visibility (chat-only -> hidden, else -> visible) and
  // the chat pane's rendered width (~0px in canvas-only mode) both track it.
  test('18. Mode Toggle: 3 buttons switch the layout; canvas visibility and chat width follow', async ({ page }) => {
    await page.goto('/');
    const canvasPane = page.getByTestId('canvas-pane');
    const chatPane = page.getByTestId('chat-pane');

    await expect(canvasPane).toHaveCSS('visibility', 'hidden');

    await openSplitMode(page);
    await expect(canvasPane).toHaveCSS('visibility', 'visible');
    await expect.poll(() => paneWidth(chatPane), { timeout: 2000 }).toBeGreaterThan(100);
    await expect.poll(() => paneWidth(canvasPane), { timeout: 2000 }).toBeGreaterThan(100);

    await openCanvasMode(page);
    await expect(canvasPane).toHaveCSS('visibility', 'visible');
    await expect.poll(() => paneWidth(chatPane), { timeout: 2000 }).toBeLessThan(5);

    await page.getByTestId('mode-chat').click();
    await expect(canvasPane).toHaveCSS('visibility', 'hidden');
  });

  // SPEC-step24.md §7 (c) — selecting a conversation whose workflow already
  // has nodes, while the layout is chat-only, auto-splits to 50/50
  // (store/chat.ts's `selectConversation` auto-behavior).
  test('19. Selecting a non-empty conversation from the rail auto-splits the layout', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-conversation').click();
    await openCanvasMode(page);

    // selectConversation re-fetches the workflow from the SERVER (`GET
    // /api/conversations/:id`) — SPEC-step27.md: with this conversation
    // active, the click below already auto-persists via the manual-change
    // queue (awaited here), so the rail reselect below is guaranteed to see
    // a non-empty server-side workflow without a separate Save click.
    await clickPaletteAndAwaitLog(page, 'palette-input.text');
    await expect(page.getByTestId('node-card')).toHaveCount(1);
    await expect(page.getByTestId('save-btn')).toBeDisabled();

    // Back to chat-only, then reselect the very same (now non-empty)
    // conversation from the rail.
    await page.getByTestId('mode-chat').click();
    const canvasPane = page.getByTestId('canvas-pane');
    await expect(canvasPane).toHaveCSS('visibility', 'hidden');

    const item = page.getByTestId('conversation-item').first();
    await item.getByRole('button').first().click();

    await expect(canvasPane).toHaveCSS('visibility', 'visible');
    const chatPane = page.getByTestId('chat-pane');
    await expect.poll(() => paneWidth(chatPane), { timeout: 2000 }).toBeGreaterThan(100);
    await expect.poll(() => paneWidth(canvasPane), { timeout: 2000 }).toBeGreaterThan(100);
  });

  // SPEC-step24.md §7 (d) — ⌘\ (Ctrl+\ works cross-platform, per
  // store/chat.ts's `metaKey || ctrlKey` guard) cycles chat -> split ->
  // canvas -> chat.
  test('20. Keyboard shortcut Ctrl+\\ cycles chat -> split -> canvas -> chat', async ({ page }) => {
    await page.goto('/');
    const canvasPane = page.getByTestId('canvas-pane');
    const chatPane = page.getByTestId('chat-pane');
    await expect(canvasPane).toHaveCSS('visibility', 'hidden'); // starts chat-only

    await page.keyboard.press('Control+Backslash');
    await expect(canvasPane).toHaveCSS('visibility', 'visible'); // now split

    await page.keyboard.press('Control+Backslash');
    await expect(canvasPane).toHaveCSS('visibility', 'visible'); // now canvas-only
    await expect.poll(() => paneWidth(chatPane), { timeout: 2000 }).toBeLessThan(5);

    await page.keyboard.press('Control+Backslash');
    await expect(canvasPane).toHaveCSS('visibility', 'hidden'); // back to chat-only
  });

  // SPEC-step27.md §7 (e2e 1) — every manual canvas mutation logs a PatchOp
  // (store/manualLog.ts's queue) once a conversation is active: dropping a
  // node from the palette logs immediately (✋ row), editing a param logs
  // ~800ms after the last keystroke (its own debounced row).
  test('21. History tab: adding a node from the palette and editing its param each log a ✋ row', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-conversation').click();
    await expect(page.getByTestId('chat-rename-btn')).toBeVisible();
    await openCanvasMode(page);

    await page.getByTestId('palette-input.text').click();
    await expect(page.getByTestId('node-card')).toHaveCount(1);

    await page.getByTestId('history-tab').click();
    await expect(page.getByTestId('history-panel')).toBeVisible();
    await expect(page.getByTestId('history-item')).toHaveCount(1, { timeout: 10_000 });
    const addRow = page.getByTestId('history-item').first();
    await expect(addRow).toContainText('✋');
    await expect(addRow).toContainText('thêm node input.text');

    // Back to Params to edit the node's value — this row logs debounced
    // (800ms after the last keystroke), not immediately like add-node above.
    await page.getByRole('button', { name: 'Params' }).click();
    await page.getByTestId('node-card').click();
    const valueInput = page.getByTestId('right-panel').locator('input[type="text"]').first();
    await valueInput.fill('lịch sử e2e');

    await page.getByTestId('history-tab').click();
    await expect(page.getByTestId('history-item')).toHaveCount(2, { timeout: 10_000 });
    const newestRow = page.getByTestId('history-item').first();
    await expect(newestRow).toContainText('✋');
    await expect(newestRow).toContainText('value');
  });

  // SPEC-step27.md §7 (e2e 2) — ↺ Khôi phục on the add-node row restores the
  // snapshot from right before it (an empty canvas, since add-node was the
  // very first change) and itself logs as a new "Khôi phục..." row.
  test('22. History tab: ↺ Khôi phục on the add-node row empties the canvas and logs a new row', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-conversation').click();
    await expect(page.getByTestId('chat-rename-btn')).toBeVisible();
    await openCanvasMode(page);

    await page.getByTestId('palette-input.text').click();
    await expect(page.getByTestId('node-card')).toHaveCount(1);

    await page.getByTestId('history-tab').click();
    await expect(page.getByTestId('history-item')).toHaveCount(1, { timeout: 10_000 });

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('history-revert').click();

    // adoptWorkflow() resets the right panel back to "Params" — the canvas
    // itself (FlowCanvas's node-card elements) is unrelated to which
    // right-panel tab is active, so this doesn't require switching back.
    await expect(page.getByTestId('node-card')).toHaveCount(0, { timeout: 10_000 });

    await page.getByTestId('history-tab').click();
    await expect(page.getByTestId('history-item')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByTestId('history-item').first()).toContainText(/Khôi phục về trước thay đổi #\d+/);
  });
});

/**
 * SPEC-step31.md — canvas UX fix pack from the 2026-07-13 visual audit.
 * Covers the 4 findings the "Nghiệm thu" section calls out for E2E (F1/F2/F3/
 * F4) — F5/F6/F7/F8 only need unit tests (already added by the implement
 * agents alongside their fixes) since they don't have a distinct browser-
 * observable interaction beyond what those unit tests already pin down.
 *
 * Own test.describe block (not appended to the block above) per the spec's
 * "thêm describe mới" instruction — still the SAME file, so Playwright's
 * default (non-`fullyParallel`) single-worker-per-file scheduling keeps every
 * test below strictly after the block above, in declaration order.
 */
test.describe('canvas UX (step 31)', () => {
  /**
   * SPEC-step31.md §F1 — reproduces the audit's exact symptom (open/switch a
   * conversation whose workflow's nodes sit outside the current viewport →
   * only a sliver, or nothing, is visible) deterministically instead of via
   * an actual sample: a synthetic workflow with 3 nodes placed thousands of
   * px away from the origin is PUT onto a real (renamed, so it survives
   * `newConversation()`'s F4 dedup guard below) conversation's own workflow
   * id, then a second, genuinely-different conversation is opened in between
   * to force the id change `adoptWorkflow` (store/flow.ts) keys its
   * `fitViewNonce` bump off. React Flow keeps every node's DOM element
   * mounted even far outside the viewport (only the *visual* pan/zoom moves),
   * so `node-card` bounding boxes are a direct, screenshot-free way to prove
   * the canvas actually re-centered.
   */
  test('F1: switching to a conversation whose workflow sits off-screen re-fits the viewport', async ({ page }) => {
    await page.goto('/');

    // Capture the freshly-created conversation's *workflow* id straight off
    // the wire (`GET /api/conversations/:id`, fired by `selectConversation`
    // inside `newConversation()`) — the same id a later JSON-view Apply +
    // Save must reuse so the far-off nodes below land on THIS conversation's
    // workflow row, not an orphaned one.
    const conversationResponse = page.waitForResponse(
      (res) => res.request().method() === 'GET' && /\/api\/conversations\/[^/]+$/.test(new URL(res.url()).pathname),
    );
    await page.getByTestId('new-conversation').click();
    const { workflow: initialWorkflow } = (await (await conversationResponse).json()) as {
      workflow: WorkflowLike;
    };

    const title = `e2e f1 fitview ${Date.now()}`;
    await page.getByTestId('chat-rename-btn').click();
    await page.getByTestId('chat-rename-input').fill(title);
    await page.getByTestId('chat-rename-input').press('Enter');
    await expect(page.getByTestId('chat-pane').getByText(title)).toBeVisible();

    await openCanvasMode(page);

    const farAwayWorkflow: WorkflowLike = {
      version: 1,
      id: initialWorkflow.id,
      name: title,
      nodes: [
        { id: 'input_1', type: 'input.text', params: { value: 'a' }, position: { x: 4000, y: 3000 } },
        { id: 'input_2', type: 'input.text', params: { value: 'b' }, position: { x: 4400, y: 3400 } },
        { id: 'input_3', type: 'input.text', params: { value: 'c' }, position: { x: 4800, y: 3800 } },
      ],
      edges: [],
    };
    await applyWorkflowViaJsonView(page, farAwayWorkflow);
    await expect(page.getByTestId('node-card')).toHaveCount(3);

    const putResponse = page.waitForResponse(
      (res) => res.request().method() === 'PUT' && /\/api\/workflows\/[^/]+$/.test(new URL(res.url()).pathname),
    );
    await page.getByTestId('save-btn').click();
    await putResponse;
    await expect(page.getByTestId('save-btn')).toBeDisabled();

    // Switch to a genuinely different (empty) conversation — this
    // conversation is now titled, so F4's "reuse the unused one" guard does
    // NOT kick in and a real new conversation+workflow pair is created.
    await page.getByTestId('new-conversation').click();
    await expect(page.getByTestId('node-card')).toHaveCount(0);

    // Switch back to the far-off-nodes conversation via the rail — this is
    // the exact "đổi conversation" path F1 fixes.
    const item = page.getByTestId('conversation-item').filter({ hasText: title });
    await item.getByRole('button').first().click();
    await expect(page.getByTestId('node-card')).toHaveCount(3);

    // fitView animates over 300ms (FlowCanvas.tsx's `fitViewNonce` effect) —
    // poll instead of asserting once.
    await expect
      .poll(
        async () => {
          const paneBox = await page.getByTestId('canvas-pane').boundingBox();
          if (!paneBox) return false;
          const cards = await page.getByTestId('node-card').all();
          if (cards.length !== 3) return false;
          for (const card of cards) {
            const box = await card.boundingBox();
            if (!box) return false;
            const withinX = box.x >= paneBox.x - 1 && box.x + box.width <= paneBox.x + paneBox.width + 1;
            const withinY = box.y >= paneBox.y - 1 && box.y + box.height <= paneBox.y + paneBox.height + 1;
            if (!withinX || !withinY) return false;
          }
          return true;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  /**
   * SPEC-step31.md §F1 follow-up (2026-07-13 bug report) — the F1 test above
   * only covers "canvas pane already visible, switch to a different
   * conversation". The audit's actual unresolved repro is opening a WIDE
   * workflow straight from the chat-only landing view: live Playwright
   * instrumentation of `.react-flow__viewport`'s transform showed every
   * `fitView()` retry (the `fitViewNonce` bump in `adoptWorkflow` + both of
   * CanvasPane's visible-effect calls) was already firing against the
   * correct, fully-settled 50/50-split canvas width — the transform
   * converged smoothly and then held, but at exactly `scale(0.5)`, React
   * Flow's default `minZoom`. A 50/50 split's actual usable canvas width
   * (Sidebar + right-panel are fixed-width, so a ~1660px container leaves
   * only ~300px for the graph itself) is too narrow for a horizontally wide
   * workflow to honestly fit at zoom >= 0.5, so the fit was silently clamped
   * and stayed clipped no matter how many times it retried. Fixed by
   * lowering `<ReactFlow minZoom>` in FlowCanvas.tsx (see its comment)
   * instead of adding more retries. This test reloads the app fresh (clears
   * the persisted `ff.splitRatio` first, so it lands exactly like a
   * brand-new browser tab: chat-only, canvas pane 0px/hidden,
   * `activeConversationId: null`) and opens a 3-node workflow spread across
   * 2000px of flow-space — same order of magnitude as the real sample that
   * triggered this bug.
   */
  test('F1 (mở từ landing): opening a wide workflow from the chat-only landing view re-fits without clamping to a stale zoom', async ({
    page,
  }) => {
    await page.goto('/');

    const conversationResponse = page.waitForResponse(
      (res) => res.request().method() === 'GET' && /\/api\/conversations\/[^/]+$/.test(new URL(res.url()).pathname),
    );
    await page.getByTestId('new-conversation').click();
    const { workflow: initialWorkflow } = (await (await conversationResponse).json()) as {
      workflow: WorkflowLike;
    };

    const title = `e2e f1 landing ${Date.now()}`;
    await page.getByTestId('chat-rename-btn').click();
    await page.getByTestId('chat-rename-input').fill(title);
    await page.getByTestId('chat-rename-input').press('Enter');
    await expect(page.getByTestId('chat-pane').getByText(title)).toBeVisible();

    await openCanvasMode(page);

    const wideWorkflow: WorkflowLike = {
      version: 1,
      id: initialWorkflow.id,
      name: title,
      nodes: [
        { id: 'input_1', type: 'input.text', params: { value: 'a' }, position: { x: 0, y: 0 } },
        { id: 'input_2', type: 'input.text', params: { value: 'b' }, position: { x: 1000, y: 150 } },
        { id: 'input_3', type: 'input.text', params: { value: 'c' }, position: { x: 2000, y: 0 } },
      ],
      edges: [],
    };
    await applyWorkflowViaJsonView(page, wideWorkflow);
    await expect(page.getByTestId('node-card')).toHaveCount(3);

    const putResponse = page.waitForResponse(
      (res) => res.request().method() === 'PUT' && /\/api\/workflows\/[^/]+$/.test(new URL(res.url()).pathname),
    );
    await page.getByTestId('save-btn').click();
    await putResponse;
    await expect(page.getByTestId('save-btn')).toBeDisabled();

    // Reload as a genuinely fresh landing: clear the persisted split ratio
    // (this same page already left it at 0 = canvas-only via `openCanvasMode`
    // above) so the reload lands exactly like a brand-new browser tab —
    // chat-only, canvas pane hidden, no active conversation.
    await page.evaluate(() => window.localStorage.removeItem('ff.splitRatio'));
    await page.goto('/');
    const canvasPane = page.getByTestId('canvas-pane');
    await expect(canvasPane).toHaveCSS('visibility', 'hidden');

    const item = page.getByTestId('conversation-item').filter({ hasText: title });
    await item.getByRole('button').first().click();
    await expect(canvasPane).toHaveCSS('visibility', 'visible');
    await expect(page.getByTestId('node-card')).toHaveCount(3);

    // fitView animates over 300ms, retried up to ~350ms later again
    // (CanvasPane's visible-effect) — poll instead of asserting once.
    await expect
      .poll(
        async () => {
          const paneBox = await canvasPane.boundingBox();
          if (!paneBox) return false;
          const cards = await page.getByTestId('node-card').all();
          if (cards.length !== 3) return false;
          for (const card of cards) {
            const box = await card.boundingBox();
            if (!box) return false;
            const withinX = box.x >= paneBox.x - 1 && box.x + box.width <= paneBox.x + paneBox.width + 1;
            const withinY = box.y >= paneBox.y - 1 && box.y + box.height <= paneBox.y + paneBox.height + 1;
            if (!withinX || !withinY) return false;
          }
          return true;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  /**
   * SPEC-step31.md §F2 — below the `2xl` (1536px) breakpoint the Toolbar's
   * secondary buttons drop their text label (icon-only), so at 1366×768
   * every listed control must still be visible with no horizontal scroll on
   * the header itself (the `overflow-x-auto` safety net from step 18 staying
   * unused, not the fix).
   */
  test('F2: at 1366×768 every toolbar control is visible with no header overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');

    for (const testId of [
      'validate-btn',
      'cost-estimate',
      'run-btn',
      'run-force-btn',
      'auto-layout-btn',
      'preview-toggle-btn',
      'json-view-btn',
      'settings-btn',
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    const header = page.locator('header');
    const { scrollWidth, clientWidth } = await header.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  /**
   * SPEC-step31.md §F3 — `ui/Popover.tsx`'s new `onClose` (outside-mousedown
   * / Escape) wired into the Toolbar's 💰 cost-estimate popover: clicking
   * anywhere else on the canvas must close it, without needing its own ✕.
   */
  test('F3: clicking outside the cost-estimate popover closes it', async ({ page }) => {
    await page.goto('/');
    await openCanvasMode(page);

    await page.getByTestId('cost-estimate').click();
    const popoverHeading = page.getByText('Ước tính chi phí', { exact: true });
    await expect(popoverHeading).toBeVisible({ timeout: 10_000 });

    // A point near the canvas's own top-left corner — definitely outside
    // both the popover panel (anchored under the toolbar's cost badge) and
    // the empty-canvas CTA card (centered, `pointer-events-auto` only on its
    // own button).
    const canvasBox = await page.getByTestId('flow-canvas').boundingBox();
    if (!canvasBox) throw new Error('flow-canvas not found');
    await page.mouse.click(canvasBox.x + 20, canvasBox.y + 20);

    await expect(popoverHeading).toHaveCount(0);
  });

  /**
   * SPEC-step31.md §F4 — `newConversation()` now reuses an existing unused
   * (`title === '' && nodeCount === 0`) conversation instead of POSTing a
   * fresh empty one every click, capping rack-up at 1 empty row regardless
   * of how many times "+" is clicked in a row.
   */
  test('F4: clicking "+ Cuộc trò chuyện mới" twice in a row does not add 2 empty conversations', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('new-conversation').click();
    await expect(page.getByTestId('chat-rename-btn')).toBeVisible();
    const countAfterFirstClick = await page.getByTestId('conversation-item').count();

    await page.getByTestId('new-conversation').click();
    await expect(page.getByTestId('chat-rename-btn')).toBeVisible();
    await expect
      .poll(() => page.getByTestId('conversation-item').count(), { timeout: 2_000 })
      .toBe(countAfterFirstClick);
  });
});
