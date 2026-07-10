/**
 * REAL tier E2E (SPEC-step7.md §4) — gated behind `E2E_REAL=1`.
 *
 * COST WARNING: this suite calls real provider APIs (OpenRouter, Vbee,
 * fal.ai) with the cheapest possible configuration (tiny LLM maxTokens,
 * ≤40-char TTS text, `fal-ai/flux/schnell` for a single image). Estimated
 * cost: ~$0.01-0.05 per full run. Deliberately does NOT test `fal.video`
 * (expensive). NEVER run this automatically in CI — orchestrator-only,
 * manually invoked via `pnpm e2e:real` / `pnpm --filter e2e test:real`.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.serial('FlowForge — real tier (paid provider calls, E2E_REAL=1 only)', () => {
  test.skip(!process.env.E2E_REAL, 'set E2E_REAL=1 để chạy tier tốn phí');
  test.setTimeout(240_000);

  async function applyWorkflowViaJsonView(page: Page, wf: unknown): Promise<void> {
    await page.getByTestId('json-view-btn').click();
    const textarea = page.getByTestId('json-view-textarea');
    await textarea.click();
    await textarea.fill(JSON.stringify(wf, null, 2));
    await page.getByTestId('json-view-apply').click();
    await expect(page.getByTestId('json-view-error')).toHaveCount(0);
    await page.mouse.click(5, 5);
  }

  test('1. Agent generate: description -> workflow with llm.generate + vbee.tts', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('describe-btn').click();
    await page
      .getByTestId('describe-input')
      .fill('Viết đúng 1 câu chào ngắn gọn rồi chuyển thành giọng nói nữ');
    await page.getByTestId('describe-generate').click();

    await expect(page.getByTestId('node-card')).not.toHaveCount(0, { timeout: 120_000 });
    const cardCount = await page.getByTestId('node-card').count();
    expect(cardCount).toBeGreaterThanOrEqual(3);

    await page.getByTestId('json-view-btn').click();
    const jsonText = await page.getByTestId('json-view-textarea').inputValue();
    expect(jsonText).toContain('"llm.generate"');
    expect(jsonText).toContain('"vbee.tts"');
  });

  test('2. LLM + TTS chain run: input.text -> llm.generate -> vbee.tts', async ({ page }) => {
    await page.goto('/');
    const wf = {
      version: 1,
      id: crypto.randomUUID(),
      name: 'e2e real: llm+tts',
      nodes: [
        { id: 'input_1', type: 'input.text', params: { value: 'Trả lời đúng 1 từ: OK' }, position: { x: 40, y: 40 } },
        { id: 'llm_generate_1', type: 'llm.generate', params: { maxTokens: 16 }, position: { x: 320, y: 40 } },
        { id: 'vbee_tts_1', type: 'vbee.tts', params: {}, position: { x: 600, y: 40 } },
      ],
      edges: [
        { id: 'e_1', from: { node: 'input_1', port: 'text' }, to: { node: 'llm_generate_1', port: 'prompt' } },
        { id: 'e_2', from: { node: 'llm_generate_1', port: 'text' }, to: { node: 'vbee_tts_1', port: 'text' } },
      ],
    };
    await applyWorkflowViaJsonView(page, wf);
    await page.getByTestId('save-btn').click();
    await page.getByTestId('run-btn').click();

    const vbeeCard = page.locator('[data-testid="node-card"][data-node-id="vbee_tts_1"]');
    await expect(vbeeCard).toHaveAttribute('data-state', 'success', { timeout: 240_000 });
    await expect(vbeeCard.locator('audio')).toHaveCount(1);
  });

  test('3. fal.image: input.text -> fal.image (fal-ai/flux/schnell)', async ({ page }) => {
    await page.goto('/');
    const wf = {
      version: 1,
      id: crypto.randomUUID(),
      name: 'e2e real: fal.image',
      nodes: [
        {
          id: 'input_1',
          type: 'input.text',
          params: { value: 'tiny cute robot icon, flat' },
          position: { x: 40, y: 40 },
        },
        {
          id: 'fal_image_1',
          type: 'fal.image',
          params: { modelId: 'fal-ai/flux/schnell' },
          position: { x: 320, y: 40 },
        },
      ],
      edges: [{ id: 'e_1', from: { node: 'input_1', port: 'text' }, to: { node: 'fal_image_1', port: 'prompt' } }],
    };
    await applyWorkflowViaJsonView(page, wf);
    await page.getByTestId('save-btn').click();
    await page.getByTestId('run-btn').click();

    const falCard = page.locator('[data-testid="node-card"][data-node-id="fal_image_1"]');
    await expect(falCard).toHaveAttribute('data-state', 'success', { timeout: 240_000 });
    const img = falCard.locator('img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', /\/artifacts\//);
    const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });
});
