/**
 * FREE tier E2E (SPEC-step33.md §33e-2) — the "video → short + b-roll"
 * pipeline (`samples/sample-video-to-short.json`): `input.file` ->
 * `video.transcribe` -> `llm.selectMoments` -> `flow.approveGate` (human
 * review) -> `broll.generate` -> `video.assembleShort` -> `output.collect`.
 *
 * Zero cost: `video.transcribe`/`broll.generate` are redirected to
 * `e2e/mock-fal.ts` (playwright.config.ts's `FAL_QUEUE_BASE_URL`/
 * `FAL_REST_BASE_URL` override) and `llm.selectMoments` to
 * `e2e/mock-openrouter.ts` (existing `OPENROUTER_BASE_URL` override, extended
 * here with a dedicated branch — see that file's `isSelectMomentsRequest`).
 * `video.assembleShort`'s ffmpeg cut/concat runs for real, locally, on the
 * ~6s `samples/assets/talk.mp4` fixture — free (no network/API involved).
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Matches playwright.config.ts's `FLOWFORGE_ARTIFACTS_DIR` for the free tier
// (`path.join(e2e/.tmp, 'artifacts')`) — same pattern app.spec.ts's test 11
// uses to drop a fixture straight on disk for a zero-cost `input.file` node.
const artifactsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.tmp/artifacts');
const talkMp4Source = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../samples/assets/talk.mp4');

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

/** Same shape as `samples/sample-video-to-short.json`, but pointed at a
 * per-test fixture filename (avoids two tests racing on the same file). */
function videoToShortWorkflow(fixtureName: string): WorkflowLike {
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: `e2e video-to-short ${Date.now()}`,
    nodes: [
      { id: 'src', type: 'input.file', params: { path: fixtureName }, position: { x: 0, y: 0 } },
      { id: 'transcribe', type: 'video.transcribe', params: {}, position: { x: 300, y: 0 } },
      { id: 'moments', type: 'llm.selectMoments', params: { model: '', maxMoments: 2 }, position: { x: 600, y: 0 } },
      { id: 'gate', type: 'flow.approveGate', params: {}, position: { x: 900, y: 0 } },
      { id: 'broll', type: 'broll.generate', params: { model: 'fal-ai/flux/schnell' }, position: { x: 1200, y: 0 } },
      { id: 'assemble', type: 'video.assembleShort', params: {}, position: { x: 1500, y: 0 } },
      { id: 'out', type: 'output.collect', params: {}, position: { x: 1800, y: 0 } },
    ],
    edges: [
      { id: 'e1', from: { node: 'src', port: 'file' }, to: { node: 'transcribe', port: 'video' } },
      { id: 'e2', from: { node: 'transcribe', port: 'segments' }, to: { node: 'moments', port: 'segments' } },
      { id: 'e3', from: { node: 'moments', port: 'plan' }, to: { node: 'gate', port: 'plan' } },
      { id: 'e4', from: { node: 'gate', port: 'plan' }, to: { node: 'broll', port: 'plan' } },
      { id: 'e5', from: { node: 'broll', port: 'plan' }, to: { node: 'assemble', port: 'plan' } },
      { id: 'e6', from: { node: 'src', port: 'file' }, to: { node: 'assemble', port: 'video' } },
      { id: 'e7', from: { node: 'assemble', port: 'video' }, to: { node: 'out', port: 'in1' } },
    ],
  };
}

async function openCanvasMode(page: Page): Promise<void> {
  await page.getByTestId('mode-canvas').click();
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
  await page.mouse.click(5, 5);
}

/** Clicks ▶ Run and returns the runId the server just accepted, without
 * waiting for it to finish (same POST-capture idea as app.spec.ts's
 * `runAndWaitForSuccess`, split so this spec can inspect the run while it's
 * still parked at the `flow.approveGate` gate). */
async function startRun(page: Page): Promise<string> {
  const responsePromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/runs',
  );
  await page.getByTestId('run-btn').click();
  const response = await responsePromise;
  const { runId } = (await response.json()) as { runId: string };
  return runId;
}

async function pollRunStatus(page: Page, runId: string, expected: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const runRes = await page.request.get(`/api/runs/${runId}`);
        const snapshot = (await runRes.json()) as { run: { status: string } };
        return snapshot.run.status;
      },
      { timeout: timeoutMs },
    )
    .toBe(expected);
}

test.describe('FlowForge — video → short + b-roll (free tier, mocked fal + OpenRouter)', () => {
  test.beforeEach(() => {
    mkdirSync(artifactsDir, { recursive: true });
  });

  test('1. Run parks at the CutPlan gate with the mocked 2-moment plan; approving runs it through to a finished short', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const fixtureName = `${crypto.randomUUID()}.mp4`;
    copyFileSync(talkMp4Source, path.join(artifactsDir, fixtureName));

    await page.goto('/');
    await openCanvasMode(page);
    await applyWorkflowViaJsonView(page, videoToShortWorkflow(fixtureName));
    await page.getByTestId('save-btn').click();

    const runId = await startRun(page);

    // Parks at flow.approveGate: transcribe (mocked wizper) -> selectMoments
    // (mocked OpenRouter, 2-moment plan) -> gate. Generous timeout: real
    // ffmpeg audio extraction + a real HTTP round-trip to the mock fal/
    // OpenRouter servers, even though every provider call itself is instant.
    const review = page.getByTestId('cutplan-review');
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cutplan-moment-m1')).toBeVisible();
    await expect(page.getByTestId('cutplan-moment-m2')).toBeVisible();
    await expect(page.getByTestId('cutplan-title-m1')).toHaveValue('Đoạn một');
    await expect(page.getByTestId('cutplan-title-m2')).toHaveValue('Đoạn hai');

    const gateNodeCard = page.locator('[data-testid="node-card"][data-node-id="gate"]');
    await expect(gateNodeCard).toHaveAttribute('data-state', 'awaiting');

    await page.getByTestId('cutplan-approve').click();
    await expect(review).toHaveCount(0);

    // Resumed: broll.generate (mocked flux/schnell -> 1 PNG per moment) ->
    // video.assembleShort (real ffmpeg cut+concat on the 6s fixture) ->
    // output.collect. Generous timeout for the real ffmpeg work.
    await pollRunStatus(page, runId, 'success', 30_000);
    await expect(page.locator('header')).toContainText('status: success', { timeout: 10_000 });

    const resultsPanel = page.getByTestId('results-panel');
    await expect(resultsPanel).toBeVisible();
    await expect(resultsPanel.locator('video').first()).toBeVisible();
    await expect(page.getByTestId('result-download-link').first()).toHaveAttribute('href', /\?download=1$/);
  });

  test('2. Cancelling at the gate stops the run instead of continuing to b-roll/assemble', async ({ page }) => {
    test.setTimeout(60_000);

    const fixtureName = `${crypto.randomUUID()}.mp4`;
    copyFileSync(talkMp4Source, path.join(artifactsDir, fixtureName));

    await page.goto('/');
    await openCanvasMode(page);
    await applyWorkflowViaJsonView(page, videoToShortWorkflow(fixtureName));
    await page.getByTestId('save-btn').click();

    const runId = await startRun(page);

    const review = page.getByTestId('cutplan-review');
    await expect(review).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('cutplan-cancel').click();
    await expect(review).toHaveCount(0);

    // `cancelAwaiting` calls `POST /api/runs/:id/stop` — the run never
    // reaches broll.generate/video.assembleShort. RunStatus is only ever
    // 'running' | 'success' | 'error' (apps/server/src/engine/types.ts) — a
    // stopped run settles as 'error'.
    await pollRunStatus(page, runId, 'error', 15_000);
    await expect(page.locator('header')).toContainText('status: error', { timeout: 10_000 });
  });
});
