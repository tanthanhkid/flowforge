/**
 * Settings page (SPEC-step6.md §4): opened from the Toolbar's ⚙ button.
 * Renders `GET /api/settings` — secret keys as a password input
 * (placeholder = masked preview, e.g. `••••cf40`) plus an "đã set"/"chưa
 * set" label; the non-secret key (OPENROUTER_DEFAULT_MODEL) as a plain text
 * input pre-filled with its current full value.
 *
 * Save only sends the fields the user actually typed into (non-empty
 * drafts) — untouched fields are omitted from the PUT body entirely, so an
 * empty secret field never clears an already-set key.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { SettingSummary } from '../api/types.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export interface SettingsPageProps {
  onClose: () => void;
}

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [settings, setSettings] = useState<SettingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setSettings(await api.getSettings());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function handleChange(key: string, value: string): void {
    setDrafts((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  async function handleSave(): Promise<void> {
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(drafts)) {
      if (value !== '') updates[key] = value;
    }
    if (Object.keys(updates).length === 0) return;

    setSaving(true);
    setError(null);
    try {
      await api.putSettings(updates);
      setDrafts({});
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="max-h-[80vh] w-[480px] overflow-y-auto rounded bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">⚙ Settings</h2>
          <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        {loading && <p className="text-xs text-slate-400">Loading…</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        {!loading && (
          <div className="flex flex-col gap-3">
            {settings.map((setting) => (
              <label key={setting.key} className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-xs font-medium text-slate-600">
                  <span>{setting.key}</span>
                  {setting.secret && (
                    <span className={`text-[10px] ${setting.isSet ? 'text-green-600' : 'text-slate-400'}`}>
                      {setting.isSet ? 'đã set' : 'chưa set'}
                    </span>
                  )}
                </span>
                <input
                  type={setting.secret ? 'password' : 'text'}
                  value={setting.secret ? (drafts[setting.key] ?? '') : (drafts[setting.key] ?? setting.value ?? '')}
                  placeholder={setting.secret ? (setting.preview ?? 'chưa set') : undefined}
                  onChange={(event) => handleChange(setting.key, event.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </label>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 border-t border-slate-200 pt-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || Object.values(drafts).every((v) => v === '')}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-xs text-green-600">Đã lưu</span>}
        </div>
      </div>
    </div>
  );
}
