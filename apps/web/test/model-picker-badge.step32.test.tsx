/**
 * SPEC-step32.md §B5 — [i2i]/[t2i] badge on ModelPicker's fal.image option
 * rows. Standalone coverage alongside model-picker.test.tsx's ⭐/MỚI badge
 * tests; doesn't touch flatIds/ARIA/keyboard nav (untouched by this change).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    refreshCatalog: vi.fn(),
    getModelCatalog: vi.fn(),
  };
});

import * as api from '../src/api/client.ts';
import type { CatalogFalEntry, CatalogLlmEntry } from '../src/api/types.ts';
import { ModelPicker } from '../src/panels/ModelPicker.tsx';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.mocked(api.refreshCatalog).mockReset();
  vi.mocked(api.getModelCatalog).mockReset();
});

function falEntry(overrides: Partial<CatalogFalEntry> & Pick<CatalogFalEntry, 'id' | 'label' | 'tier'>): CatalogFalEntry {
  return {
    kind: 'image',
    estUsd: 0.01,
    estBasis: 'per image',
    createdAt: null,
    featured: false,
    ...overrides,
  };
}

function openPicker(): void {
  fireEvent.click(screen.getByTestId('model-picker-trigger'));
}

describe('ModelPicker — [i2i]/[t2i] badge (SPEC-step32.md §B5)', () => {
  it('shows a [t2i] badge on a fal.image entry with imageKind: "t2i"', () => {
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/flux/dev', label: 'FLUX.1 dev', tier: 'kha', imageKind: 't2i' }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-fal-ai/flux/dev')).toHaveTextContent('[t2i]');
  });

  it('shows an [i2i] badge on a fal.image entry with imageKind: "i2i"', () => {
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/flux-pro/kontext', label: 'FLUX.1 Kontext', tier: 'xin', imageKind: 'i2i' }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-fal-ai/flux-pro/kontext')).toHaveTextContent('[i2i]');
  });

  it('shows no badge when imageKind is unset (unknown classification)', () => {
    const entries: CatalogFalEntry[] = [falEntry({ id: 'fal-ai/mystery', label: 'Mystery', tier: 're' })];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const row = screen.getByTestId('model-picker-option-fal-ai/mystery');
    expect(row).not.toHaveTextContent('[t2i]');
    expect(row).not.toHaveTextContent('[i2i]');
    expect(screen.queryByTestId('model-picker-imagekind-fal-ai/mystery')).not.toBeInTheDocument();
  });

  it('shows no badge for fal.video entries even when imageKind happens to be set (only meaningful for kind: "image")', () => {
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/kling-video/t2v', label: 'Kling', tier: 'xin', kind: 'video-t2v', imageKind: 't2i' }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const row = screen.getByTestId('model-picker-option-fal-ai/kling-video/t2v');
    expect(row).not.toHaveTextContent('[t2i]');
  });

  it('shows no badge for llm entries (no imageKind on that union member)', () => {
    const entries: CatalogLlmEntry[] = [
      { id: 'a/b', label: 'A B', tier: 'xin', estUsd: 0.01, estBasis: 'per call', createdAt: null, featured: false },
    ];
    render(<ModelPicker name="model" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const row = screen.getByTestId('model-picker-option-a/b');
    expect(row).not.toHaveTextContent('[t2i]');
    expect(row).not.toHaveTextContent('[i2i]');
  });

  it('includes the [i2i]/[t2i] tag in the row title tooltip alongside note/id', () => {
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/flux-pro/kontext', label: 'FLUX.1 Kontext', tier: 'xin', imageKind: 'i2i', note: 'ảnh vào ảnh ra' }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const row = screen.getByTestId('model-picker-option-fal-ai/flux-pro/kontext');
    expect(row).toHaveAttribute('title', 'ảnh vào ảnh ra — [i2i] — fal-ai/flux-pro/kontext');
  });

  it('the badge uses a bg color distinct from the "MỚI" badge (bg-cat-image) so the two remain visually distinguishable', () => {
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/new-i2i', label: 'New I2I', tier: 'xin', imageKind: 'i2i', createdAt: Date.now() }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const row = screen.getByTestId('model-picker-option-fal-ai/new-i2i');
    expect(row).toHaveTextContent('MỚI');
    expect(row).toHaveTextContent('[i2i]');
    const badge = screen.getByTestId('model-picker-imagekind-fal-ai/new-i2i');
    expect(badge.className).not.toContain('bg-cat-image');
  });

  it('does not break flatIds/keyboard nav: Enter with no navigation still selects the first (top) row even with a badge present', () => {
    const onApply = vi.fn();
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/a', label: 'Model A', tier: 'xin', imageKind: 't2i' }),
      falEntry({ id: 'fal-ai/b', label: 'Model B', tier: 'kha', imageKind: 'i2i' }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={onApply} />);
    openPicker();
    fireEvent.keyDown(screen.getByTestId('model-picker-search'), { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith('fal-ai/a');
  });
});
