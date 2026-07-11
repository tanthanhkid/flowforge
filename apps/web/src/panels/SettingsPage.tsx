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
 *
 * Neo-brutalist pass (SPEC-step18.md §5.6): shares `ui/Modal.tsx` for the
 * shell; each field gets a mono service-color chip (OpenRouter=cat-llm,
 * fal.ai=cat-video, Vbee=cat-audio) so the 5 keys read as grouped by
 * provider at a glance, and every input uses the mono data font.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { SettingSummary } from '../api/types.ts';
import { Badge } from '../ui/Badge.tsx';
import { Button } from '../ui/Button.tsx';
import { Modal } from '../ui/Modal.tsx';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

/** Provider a settings key belongs to, for the service-color chip (spec §5.6). */
function serviceOf(key: string): { label: string; color: string; textColor: string } | null {
  if (key.startsWith('OPENROUTER')) return { label: 'OpenRouter', color: 'var(--color-cat-llm)', textColor: '#FFFFFF' };
  if (key.startsWith('FAL')) return { label: 'fal.ai', color: 'var(--color-cat-video)', textColor: '#0D0D0D' };
  if (key.startsWith('VBEE')) return { label: 'Vbee', color: 'var(--color-cat-audio)', textColor: '#0D0D0D' };
  return null;
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
    <Modal title="⚙ Settings" onClose={onClose} className="w-[480px] max-w-[92vw]" data-testid="settings-modal">
      {loading && <p className="text-[11px] font-bold text-ink-soft">Loading…</p>}
      {error && <p className="text-[11px] font-bold text-status-error">{error}</p>}

      {!loading && (
        <div className="flex flex-col gap-3">
          {settings.map((setting) => {
            const service = serviceOf(setting.key);
            return (
              <label key={setting.key} className="flex flex-col gap-1.5 border-2 border-ink bg-bg p-2 shadow-hard-2">
                <span className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="flex items-center gap-1.5">
                    {service && (
                      <Badge color={service.color} textColor={service.textColor}>
                        {service.label}
                      </Badge>
                    )}
                    <span className="font-mono-data text-[11px] font-bold text-ink">{setting.key}</span>
                  </span>
                  {setting.secret && (
                    <span
                      className={`font-mono-data text-[11px] font-bold ${
                        setting.isSet ? 'text-status-success' : 'text-ink-soft'
                      }`}
                    >
                      {setting.isSet ? 'đã set' : 'chưa set'}
                    </span>
                  )}
                </span>
                <input
                  type={setting.secret ? 'password' : 'text'}
                  data-testid={`settings-field-${setting.key}`}
                  value={setting.secret ? (drafts[setting.key] ?? '') : (drafts[setting.key] ?? setting.value ?? '')}
                  placeholder={setting.secret ? (setting.preview ?? 'chưa set') : undefined}
                  onChange={(event) => handleChange(setting.key, event.target.value)}
                  className="border-2 border-ink bg-paper px-2 py-1.5 font-mono-data text-[11px] font-bold text-ink focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)] focus:outline-none"
                />
              </label>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 border-t-2 border-ink pt-3">
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving || Object.values(drafts).every((v) => v === '')}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saved && <span className="font-mono-data text-[11px] font-bold text-status-success">Đã lưu</span>}
      </div>
    </Modal>
  );
}
