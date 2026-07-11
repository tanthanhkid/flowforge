/**
 * FREE tier E2E (SPEC-step7.md §3): only utility nodes (`input.text`,
 * `text.template`, `output.collect`) — zero API cost, safe to run anytime.
 * Must pass 100% reliably, twice in a row.
 */
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

test.describe('FlowForge — free tier (utility nodes only)', () => {
  test('1. App load: sidebar shows all 9 node types, toolbar has its buttons', async ({ page }) => {
    await page.goto('/');
    for (const type of PALETTE_TYPES) {
      await expect(page.getByTestId(`palette-${type}`)).toBeVisible();
    }
    await expect(page.getByTestId('save-btn')).toBeVisible();
    await expect(page.getByTestId('validate-btn')).toBeVisible();
    await expect(page.getByTestId('run-btn')).toBeVisible();
    await expect(page.getByTestId('run-force-btn')).toBeVisible();
    await expect(page.getByTestId('describe-btn')).toBeVisible();
    await expect(page.getByTestId('json-view-btn')).toBeVisible();
    await expect(page.getByTestId('settings-btn')).toBeVisible();
  });

  test('2. Add node from palette: clicking a palette entry adds one node-card', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('node-card')).toHaveCount(0);
    await page.getByTestId('palette-input.text').click();
    await expect(page.getByTestId('node-card')).toHaveCount(1);
  });

  test('3. Params edit: editing a value in ParamsPanel is reflected in the JSON view', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('palette-input.text').click();
    await page.getByTestId('node-card').click();

    const valueInput = page.locator('input[type="text"]').first();
    await valueInput.fill('hello from e2e');

    await page.getByTestId('json-view-btn').click();
    await expect(page.getByTestId('json-view-textarea')).toContainText('hello from e2e');
  });

  test('4. Happy run: sample workflow runs to success with the expected preview text', async ({ page }) => {
    await page.goto('/');
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

    const selectedCard = page.locator('[data-testid="node-card"].ring-2, [data-testid="node-card"][class*="ring-blue"]');
    await expect(selectedCard).toHaveCount(1);
  });

  test('8. Persistence: saved workflow survives a page reload', async ({ page }) => {
    await page.goto('/');
    const wf = sampleWorkflow();
    await applyWorkflowViaJsonView(page, wf);
    await page.getByTestId('save-btn').click();
    await expect(page.getByTestId('save-btn')).toBeDisabled();

    await page.reload();
    await page.getByTestId('palette-input.text').waitFor();

    await page.getByRole('button', { name: 'Workflows' }).click();
    await page.getByRole('button', { name: wf.name }).click();

    await expect(page.getByTestId('node-card')).toHaveCount(3);
  });

  test('9. Runs history: the Runs tab lists at least 2 runs; opening an old one shows its states', async ({ page }) => {
    await page.goto('/');
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
});
