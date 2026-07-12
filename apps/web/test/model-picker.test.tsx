/**
 * ModelPicker.tsx (SPEC-step19.md §2) — the searchable combobox that
 * replaced ParamsPanel's old plain tiered <select> now that the catalog can
 * hold hundreds of live models. Exercised standalone here (params-panel.test
 * .tsx covers its wiring into fal.image/fal.video/llm.generate specifically);
 * this file covers the picker's own behavior: search filtering, tier
 * grouping, the ⭐/MỚI badges, the 60-row render cap + overflow counter, and
 * the "↻" refresh button.
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

// Imported after vi.mock (hoisted above these imports by Vitest) so `api.*`
// below refers to the mocked functions.
import * as api from '../src/api/client.ts';
import type { CatalogFalEntry, CatalogLlmEntry } from '../src/api/types.ts';
import { ModelPicker, type ModelCatalogEntry } from '../src/panels/ModelPicker.tsx';
import { useFlowStore } from '../src/store/flow.ts';

// See node-card.test.tsx for why an explicit cleanup() is required here
// (vitest.config.ts doesn't set test.globals: true).
afterEach(() => {
  cleanup();
});

const DAY_MS = 24 * 60 * 60 * 1000;

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

beforeEach(() => {
  vi.mocked(api.refreshCatalog).mockReset();
  vi.mocked(api.getModelCatalog).mockReset();
});

describe('ModelPicker — tier groups + badges', () => {
  const entries: CatalogFalEntry[] = [
    falEntry({ id: 'fal-ai/a', label: 'Model A', tier: 'xin', estUsd: 0.08, featured: true, createdAt: Date.now() - 10 * DAY_MS }),
    falEntry({ id: 'fal-ai/b', label: 'Model B', tier: 'kha', estUsd: 0.02, createdAt: Date.now() - 200 * DAY_MS }),
    falEntry({ id: 'fal-ai/c', label: 'Model C', tier: 're', estUsd: 0.002 }),
    falEntry({ id: 'fal-ai/d', label: 'Model D', tier: 'unknown', estUsd: null }),
  ];

  it('renders one header per tier that actually has visible entries, in xin/kha/re/unknown order', () => {
    render(<ModelPicker name="modelId" value="fal-ai/a" entries={entries} onApply={() => undefined} />);
    openPicker();
    const headers = screen.getAllByText(/Xịn|Khá|Rẻ|Chưa rõ giá/);
    expect(headers.map((h) => h.textContent)).toEqual(['💎 Xịn', '✅ Khá', '💸 Rẻ', '❓ Chưa rõ giá']);
  });

  it('shows a "?" price and puts an unpriced entry in the ❓ group', () => {
    render(<ModelPicker name="modelId" value="fal-ai/a" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-tier-unknown')).toBeInTheDocument();
    expect(screen.getByTestId('model-picker-option-fal-ai/d')).toHaveTextContent('?');
  });

  it('shows a ⭐ prefix only for featured entries', () => {
    render(<ModelPicker name="modelId" value="fal-ai/a" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-fal-ai/a')).toHaveTextContent('⭐');
    expect(screen.getByTestId('model-picker-option-fal-ai/b')).not.toHaveTextContent('⭐');
  });

  it('shows a "MỚI" badge only for entries created within the last 60 days', () => {
    render(<ModelPicker name="modelId" value="fal-ai/a" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-fal-ai/a')).toHaveTextContent('MỚI');
    expect(screen.getByTestId('model-picker-option-fal-ai/b')).not.toHaveTextContent('MỚI');
    expect(screen.getByTestId('model-picker-option-fal-ai/c')).not.toHaveTextContent('MỚI');
  });

  it('formats fal image prices as "$X/ảnh" and video prices as "$X/5s"', () => {
    const videoEntries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/vid', label: 'Vid', tier: 'xin', kind: 'video-t2v', estUsd: 0.28 }),
    ];
    render(<ModelPicker name="modelId" value="" entries={videoEntries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-fal-ai/vid')).toHaveTextContent('$0.28/5s');
    cleanup();
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-fal-ai/c')).toHaveTextContent('$0.002/ảnh');
  });

  it('formats llm prices with live per-token pricing as "$X + $Y /1M" when available', () => {
    const llmEntries: CatalogLlmEntry[] = [
      { id: 'a/b', label: 'A B', tier: 'xin', estUsd: 0.01, estBasis: 'per call', createdAt: null, featured: false, per1MIn: 3, per1MOut: 15 },
      { id: 'c/d', label: 'C D', tier: 'kha', estUsd: 0.002, estBasis: 'per call', createdAt: null, featured: false },
    ];
    render(<ModelPicker name="model" value="" entries={llmEntries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-option-a/b')).toHaveTextContent('$3 + $15 /1M');
    // No live per-token pricing on this one (featured preset with no live match) -> falls back to the estUsd-per-call figure.
    expect(screen.getByTestId('model-picker-option-c/d')).toHaveTextContent('~$0.002/call');
  });
});

describe('ModelPicker — search filter + 60-row cap', () => {
  function manyEntries(n: number): CatalogFalEntry[] {
    return Array.from({ length: n }, (_, i) =>
      falEntry({ id: `fal-ai/model-${i}`, label: `Model ${i}`, tier: 're', estUsd: 0.001 }),
    );
  }

  it('filters rows by id or label substring, case-insensitively', () => {
    const entries: CatalogFalEntry[] = [
      falEntry({ id: 'fal-ai/flux/dev', label: 'FLUX.1 dev', tier: 'kha' }),
      falEntry({ id: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell', tier: 're' }),
      falEntry({ id: 'fal-ai/kling-video/t2v', label: 'Kling', tier: 'xin' }),
    ];
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'SCHNELL' } });
    expect(screen.getByTestId('model-picker-option-fal-ai/flux/schnell')).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-option-fal-ai/flux/dev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-option-fal-ai/kling-video/t2v')).not.toBeInTheDocument();
  });

  it('renders at most 60 rows and shows "…còn N model" for the rest', () => {
    const entries = manyEntries(75);
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const rendered = entries.filter((e) => screen.queryByTestId(`model-picker-option-${e.id}`) !== null);
    expect(rendered.length).toBe(60);
    expect(screen.getByText('…còn 15 model — gõ để lọc thêm')).toBeInTheDocument();
  });

  it('narrowing the search below the 60-row cap removes the overflow line', () => {
    const entries = manyEntries(75);
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'model-7' } });
    expect(screen.queryByText(/…còn/)).not.toBeInTheDocument();
  });

  it('the "✏️ Tự nhập" row stays present and unfiltered even when the search matches nothing', () => {
    const entries = manyEntries(5);
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'zzz-no-match' } });
    expect(screen.queryByTestId(/model-picker-option-/)).not.toBeInTheDocument();
    expect(screen.getByTestId('model-picker-custom')).toBeInTheDocument();
  });
});

describe('ModelPicker — llm "Mặc định hệ thống" default option', () => {
  const entries: CatalogLlmEntry[] = [
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'xin', estUsd: 0.0099, estBasis: 'per call', createdAt: null, featured: true },
  ];

  it('shows the default option pinned above the tier groups, selecting it applies its value', () => {
    const onApply = vi.fn();
    render(
      <ModelPicker
        name="model"
        value=""
        entries={entries}
        defaultOption={{ label: '🔧 Mặc định hệ thống', value: '' }}
        onApply={onApply}
      />,
    );
    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('Mặc định hệ thống');
    openPicker();
    fireEvent.click(screen.getByTestId('model-picker-default'));
    expect(onApply).toHaveBeenCalledWith('');
  });
});

describe('ModelPicker — "↻" refresh button', () => {
  const entries: ModelCatalogEntry[] = [
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'xin', estUsd: 0.0099, estBasis: 'per call', createdAt: null, featured: true },
  ];

  it('calls store.refreshModelCatalog() (POST /api/catalog/refresh then GET /api/model-catalog) on click', async () => {
    vi.mocked(api.refreshCatalog).mockResolvedValue({
      counts: { falVideo: 1, falImage: 1, openrouter: 1 },
      fetchedAt: Date.now(),
      source: 'live',
    });
    vi.mocked(api.getModelCatalog).mockResolvedValue({
      falVideo: [],
      falImage: [],
      openrouter: [],
      meta: { source: 'live', fetchedAt: Date.now(), counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
    });
    render(<ModelPicker name="model" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    fireEvent.click(screen.getByTestId('model-picker-refresh'));
    await vi.waitFor(() => expect(api.refreshCatalog).toHaveBeenCalledTimes(1));
    expect(api.getModelCatalog).toHaveBeenCalled();
  });

  it('shows an inline error message when the refresh fails', async () => {
    vi.mocked(api.refreshCatalog).mockRejectedValue(new Error('network down'));
    render(<ModelPicker name="model" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    fireEvent.click(screen.getByTestId('model-picker-refresh'));
    await screen.findByText('network down');
  });
});

describe('ModelPicker — closing behavior', () => {
  const entries: CatalogFalEntry[] = [falEntry({ id: 'fal-ai/a', label: 'Model A', tier: 'xin' })];

  it('Escape closes the dropdown', () => {
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    expect(screen.getByTestId('model-picker-search')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('model-picker-search')).not.toBeInTheDocument();
  });

  it('clicking outside the trigger/panel closes the dropdown', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />
      </div>,
    );
    openPicker();
    expect(screen.getByTestId('model-picker-search')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('model-picker-search')).not.toBeInTheDocument();
  });

  // Post-review fix: the click-outside/Escape close paths previously only
  // called setOpen(false), NOT the same closePanel() an explicit selection
  // uses — leaving a typed search query behind for the next reopen, despite
  // this effect's own comment promising "reset on close for a clean reopen".
  it('Escape resets the search query, so reopening shows an empty search box', () => {
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'model a' } });
    expect(screen.getByTestId('model-picker-search')).toHaveValue('model a');
    fireEvent.keyDown(document, { key: 'Escape' });
    openPicker();
    expect(screen.getByTestId('model-picker-search')).toHaveValue('');
  });

  it('clicking outside resets the search query, so reopening shows an empty search box', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />
      </div>,
    );
    openPicker();
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'model a' } });
    fireEvent.mouseDown(screen.getByTestId('outside'));
    openPicker();
    expect(screen.getByTestId('model-picker-search')).toHaveValue('');
  });
});

describe('ModelPicker — keyboard navigation + ARIA (post-review fix)', () => {
  const entries: CatalogFalEntry[] = [
    falEntry({ id: 'fal-ai/a', label: 'Model A', tier: 'xin' }),
    falEntry({ id: 'fal-ai/b', label: 'Model B', tier: 'kha' }),
  ];

  it('the search input exposes combobox ARIA wired to the listbox', () => {
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const search = screen.getByTestId('model-picker-search');
    expect(search).toHaveAttribute('role', 'combobox');
    expect(search).toHaveAttribute('aria-expanded', 'true');
    const listboxId = search.getAttribute('aria-controls');
    expect(listboxId).toBeTruthy();
    expect(document.getElementById(listboxId!)).toHaveAttribute('role', 'listbox');
  });

  it('every rendered option row has role="option" and aria-selected', () => {
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const optionA = screen.getByTestId('model-picker-option-fal-ai/a');
    expect(optionA).toHaveAttribute('role', 'option');
    expect(optionA).toHaveAttribute('aria-selected');
    expect(screen.getByTestId('model-picker-custom')).toHaveAttribute('role', 'option');
  });

  it('ArrowDown moves aria-activedescendant to the next option (starting at the first)', () => {
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const search = screen.getByTestId('model-picker-search');
    const optionA = screen.getByTestId('model-picker-option-fal-ai/a');
    const optionB = screen.getByTestId('model-picker-option-fal-ai/b');

    expect(search.getAttribute('aria-activedescendant')).toBe(optionA.id);
    expect(optionA).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(optionB.id);
    expect(optionB).toHaveAttribute('aria-selected', 'true');
    expect(optionA).toHaveAttribute('aria-selected', 'false');
  });

  it('ArrowUp from the first option wraps to the last option ("✏️ Tự nhập")', () => {
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={() => undefined} />);
    openPicker();
    const search = screen.getByTestId('model-picker-search');
    const custom = screen.getByTestId('model-picker-custom');

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(search.getAttribute('aria-activedescendant')).toBe(custom.id);
  });

  it('Enter selects the active option, applying its id and closing the panel', () => {
    const onApply = vi.fn();
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={onApply} />);
    openPicker();
    const search = screen.getByTestId('model-picker-search');

    fireEvent.keyDown(search, { key: 'ArrowDown' }); // Model A -> Model B
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onApply).toHaveBeenCalledWith('fal-ai/b');
    expect(screen.queryByTestId('model-picker-search')).not.toBeInTheDocument();
  });

  it('Enter with no navigation selects the first (top) option', () => {
    const onApply = vi.fn();
    render(<ModelPicker name="modelId" value="" entries={entries} onApply={onApply} />);
    openPicker();
    fireEvent.keyDown(screen.getByTestId('model-picker-search'), { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith('fal-ai/a');
  });
});

// Ensures the store's own plumbing (SPEC-step19.md §2 "refreshModelCatalog")
// is wired the way ModelPicker's refresh button assumes.
describe('store.refreshModelCatalog', () => {
  it('calls refreshCatalog then re-fetches getModelCatalog into state.modelCatalog', async () => {
    const fresh = {
      falVideo: [],
      falImage: [],
      openrouter: [{ id: 'x/y', label: 'X Y', tier: 'xin' as const, estUsd: 1, estBasis: 'per call', createdAt: null, featured: false }],
      meta: { source: 'live' as const, fetchedAt: 123, counts: { falVideo: 0, falImage: 0, openrouter: 1 } },
    };
    vi.mocked(api.refreshCatalog).mockResolvedValue({
      counts: { falVideo: 0, falImage: 0, openrouter: 1 },
      fetchedAt: 123,
      source: 'live',
    });
    vi.mocked(api.getModelCatalog).mockResolvedValue(fresh);

    await useFlowStore.getState().refreshModelCatalog();

    expect(api.refreshCatalog).toHaveBeenCalled();
    expect(api.getModelCatalog).toHaveBeenCalled();
    expect(useFlowStore.getState().modelCatalog).toEqual(fresh);
  });
});
