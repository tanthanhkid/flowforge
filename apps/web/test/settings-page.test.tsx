/**
 * SPEC-step6.md §4 — SettingsPage.tsx: renders masked secrets (never the
 * full value), and Save only PUTs the fields the user actually typed into.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingSummary } from '../src/api/types.ts';
import { SettingsPage } from '../src/panels/SettingsPage.tsx';

afterEach(() => {
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const initialSettings: SettingSummary[] = [
  { key: 'OPENROUTER_API_KEY', isSet: true, preview: '••••cf40', secret: true },
  { key: 'FAL_KEY', isSet: false, preview: null, secret: true },
  { key: 'VBEE_APP_ID', isSet: true, preview: '••••abcd', secret: true },
  { key: 'VBEE_TOKEN', isSet: false, preview: null, secret: true },
  { key: 'OPENROUTER_DEFAULT_MODEL', isSet: true, preview: '••••4.5', secret: false, value: 'x-ai/grok-4.5' },
];

describe('SettingsPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function lastCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    if (!call) throw new Error('fetch was not called');
    return call as [string, RequestInit];
  }

  it('renders masked previews for secret keys and never the full value anywhere in the DOM', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ settings: initialSettings }));
    render(<SettingsPage onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('OPENROUTER_API_KEY')).toBeInTheDocument();
    });

    // The masked preview shows up as a placeholder, never as a real value.
    const apiKeyInput = screen.getByPlaceholderText('••••cf40') as HTMLInputElement;
    expect(apiKeyInput.type).toBe('password');
    expect(apiKeyInput.value).toBe('');

    expect(screen.getAllByText('đã set').length).toBeGreaterThan(0);
    expect(screen.getAllByText('chưa set').length).toBeGreaterThan(0);

    // The non-secret key shows its full current value in a plain text input.
    const modelInput = screen.getByDisplayValue('x-ai/grok-4.5') as HTMLInputElement;
    expect(modelInput.type).toBe('text');

    // No fake "full secret" string ever appears in the rendered DOM.
    expect(document.body.textContent).not.toMatch(/sk-[a-zA-Z0-9]+/);
  });

  it('Save only PUTs fields the user actually typed into (untouched secret fields are omitted)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ settings: initialSettings }));
    render(<SettingsPage onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('OPENROUTER_API_KEY')).toBeInTheDocument();
    });

    const falKeyLabel = screen.getByText('FAL_KEY').closest('label');
    if (!falKeyLabel) throw new Error('FAL_KEY label not found');
    const falKeyInput = falKeyLabel.querySelector('input') as HTMLInputElement;
    fireEvent.change(falKeyInput, { target: { value: 'fake_new_fal_key_value' } });

    fetchMock.mockResolvedValueOnce(jsonResponse({ settings: initialSettings }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ settings: initialSettings }));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' }));
    });

    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ FAL_KEY: 'fake_new_fal_key_value' });
  });
});
