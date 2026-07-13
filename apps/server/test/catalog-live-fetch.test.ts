/**
 * SPEC-step19.md §1.1/§4 — catalog-live-fetch.test.ts. `fetchOpenRouterCatalog`
 * and `fetchFalCatalog` against a fully injected `fetchImpl` mock (never
 * `globalThis.fetch`) — both are keyless public endpoints, no
 * OPENROUTER_API_KEY/FAL_KEY involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchFalCatalog } from '../src/catalog/live/fetchFal.js';
import { fetchOpenRouterCatalog } from '../src/catalog/live/fetchOpenRouter.js';
import type { FetchLike } from '../src/catalog/live/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('fetchOpenRouterCatalog', () => {
  it('GETs the public models endpoint and maps text-output models', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://openrouter.ai/api/v1/models');
      return jsonResponse(200, {
        data: [
          {
            id: 'anthropic/claude-sonnet-4.5',
            name: 'Claude Sonnet 4.5',
            pricing: { prompt: '0.000003', completion: '0.000015' },
            context_length: 200000,
            created: 1700000000,
            architecture: { modality: 'text->text' },
          },
        ],
      });
    });

    const result = await fetchOpenRouterCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(result).toEqual([
      {
        id: 'anthropic/claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5',
        per1MIn: 3,
        per1MOut: 15,
        contextLength: 200000,
        createdAt: 1700000000_000,
      },
    ]);
  });

  it('excludes embedding/moderation models (both architecture shapes)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          { id: 'openai/text-embedding-3-small', name: 'Embedding', architecture: { output_modalities: ['embedding'] } },
          { id: 'openai/omni-moderation', name: 'Moderation', architecture: { modality: 'text->moderation' } },
          { id: 'some/no-architecture-embed-model', name: 'No arch, embed in id' },
          { id: 'openai/gpt-5.2', name: 'GPT-5.2', architecture: { output_modalities: ['text'] } },
        ],
      }),
    );

    const result = await fetchOpenRouterCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(result.map((m) => m.id)).toEqual(['openai/gpt-5.2']);
  });

  it('defaults missing/unparseable pricing and context_length to 0/null', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { data: [{ id: 'some/free-model', architecture: { modality: 'text->text' } }] }),
    );

    const result = await fetchOpenRouterCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(result).toEqual([
      { id: 'some/free-model', label: 'some/free-model', per1MIn: 0, per1MOut: 0, contextLength: null, createdAt: null },
    ]);
  });

  it('tolerates a non-array/missing data field -> empty result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const result = await fetchOpenRouterCatalog({ fetchImpl: fetchMock as unknown as FetchLike });
    expect(result).toEqual([]);
  });

  // Post-review fix: OpenRouter's dynamic/auto-router models (e.g.
  // openrouter/auto) report pricing.prompt/completion as the literal string
  // "-1" — a sentinel meaning "varies by the routed-to model", not a real
  // negative price. Parsing it literally used to produce per1MIn/per1MOut of
  // -1,000,000, which then flowed into a large negative estUsd elsewhere.
  it('treats a negative pricing sentinel ("-1") as unknown (null), not a literal negative price', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'openrouter/auto',
            name: 'Auto Router',
            pricing: { prompt: '-1', completion: '-1' },
            architecture: { modality: 'text->text' },
          },
        ],
      }),
    );

    const result = await fetchOpenRouterCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(result).toEqual([
      { id: 'openrouter/auto', label: 'Auto Router', per1MIn: null, per1MOut: null, contextLength: null, createdAt: null },
    ]);
  });

  it('treats a negative price on only one side (prompt or completion) as unknown for that side only', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'vendor/half-dynamic',
            name: 'Half Dynamic',
            pricing: { prompt: '0.000001', completion: '-1' },
            architecture: { modality: 'text->text' },
          },
        ],
      }),
    );

    const result = await fetchOpenRouterCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(result[0]).toMatchObject({ per1MIn: 1, per1MOut: null });
  });
});

describe('fetchFalCatalog', () => {
  function falPage(page: number, pages: number, items: unknown[]): Response {
    return jsonResponse(200, { items, page, pages, size: items.length, total: items.length * pages });
  }

  it('fetches only page 1 when pages === 1', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://fal.ai/api/models?page=1');
      return falPage(1, 1, [
        {
          id: 'fal-ai/flux/dev',
          title: 'FLUX.1 [dev]',
          category: 'text-to-image',
          date: '2024-08-01T00:00:00.000Z',
          shortDescription: 'A'.repeat(200),
          pricingInfoOverride: '**$0.025** per megapixel',
        },
      ]);
    });

    const result = await fetchFalCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: 'fal-ai/flux/dev',
        label: 'FLUX.1 [dev]',
        kind: 'image',
        createdAt: Date.parse('2024-08-01T00:00:00.000Z'),
        note: 'A'.repeat(120),
        priceRaw: '**$0.025** per megapixel',
        // SPEC-step29.md §2 — category "text-to-image" -> imageKind 't2i'.
        imageKind: 't2i',
      },
    ]);
  });

  it('loops every page (1..pages), filters deprecated/removed and unmapped categories, maps category -> kind', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calledUrls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        return falPage(1, 3, [
          { id: 'fal-ai/veo3', title: 'Veo 3', category: 'text-to-video', date: '2025-01-01' },
          { id: 'fal-ai/deprecated-model', title: 'Old', category: 'text-to-image', deprecated: true },
        ]);
      }
      if (page === 2) {
        return falPage(2, 3, [
          { id: 'fal-ai/removed-model', title: 'Gone', category: 'text-to-video', removed: true },
          { id: 'fal-ai/img2img-tool', title: 'Img2Img', category: 'image-to-image', publishedAt: '2025-02-01' },
        ]);
      }
      return falPage(3, 3, [
        { id: 'fal-ai/kling/i2v', title: 'Kling I2V', category: 'image-to-video' },
        { id: 'fal-ai/some-lora', title: 'LoRA training', category: 'lora-training' },
      ]);
    });

    const result = await fetchFalCatalog({ fetchImpl: fetchMock as unknown as FetchLike, concurrency: 5 });

    expect(calledUrls.sort()).toEqual([
      'https://fal.ai/api/models?page=1',
      'https://fal.ai/api/models?page=2',
      'https://fal.ai/api/models?page=3',
    ]);
    expect(result.map((m) => m.id).sort()).toEqual(['fal-ai/img2img-tool', 'fal-ai/kling/i2v', 'fal-ai/veo3'].sort());
    expect(result.find((m) => m.id === 'fal-ai/veo3')?.kind).toBe('video-t2v');
    expect(result.find((m) => m.id === 'fal-ai/img2img-tool')?.kind).toBe('image');
    expect(result.find((m) => m.id === 'fal-ai/kling/i2v')?.kind).toBe('video-i2v');

    // SPEC-step29.md §2 — category "image-to-image" -> imageKind 'i2i';
    // video categories never get an imageKind (that split already lives in
    // `kind` itself for video-t2v/video-i2v).
    expect(result.find((m) => m.id === 'fal-ai/img2img-tool')?.imageKind).toBe('i2i');
    expect(result.find((m) => m.id === 'fal-ai/veo3')?.imageKind).toBeUndefined();
    expect(result.find((m) => m.id === 'fal-ai/kling/i2v')?.imageKind).toBeUndefined();
  });

  it('never runs more than `concurrency` page requests at once', async () => {
    let active = 0;
    let maxActive = 0;
    const totalPages = 12;
    const fetchMock = vi.fn(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const page = Number(new URL(url).searchParams.get('page'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return falPage(page, totalPages, []);
    });

    await fetchFalCatalog({ fetchImpl: fetchMock as unknown as FetchLike, concurrency: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(totalPages);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('falls back to publishedAt when date is absent, and to null createdAt when neither parses', async () => {
    const fetchMock = vi.fn(async () =>
      falPage(1, 1, [
        { id: 'a', title: 'A', category: 'text-to-image', publishedAt: '2023-05-05T00:00:00.000Z' },
        { id: 'b', title: 'B', category: 'text-to-image' },
      ]),
    );

    const result = await fetchFalCatalog({ fetchImpl: fetchMock as unknown as FetchLike });

    expect(result.find((m) => m.id === 'a')?.createdAt).toBe(Date.parse('2023-05-05T00:00:00.000Z'));
    expect(result.find((m) => m.id === 'b')?.createdAt).toBeNull();
  });

  it('rejects the whole call when any page request throws (e.g. timeout)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return falPage(1, 2, []);
      throw new Error('boom');
    });

    await expect(fetchFalCatalog({ fetchImpl: fetchMock as unknown as FetchLike })).rejects.toThrow('boom');
  });
});
