/**
 * FlowForge settings management (SPEC-step6.md §1).
 *
 * Reads/writes the small set of secrets the server needs from an env file
 * (default `.env.local` at the repo root, overridable per-call so tests can
 * point at a tmp fixture) and mirrors updates into `process.env` immediately
 * so the running server picks them up without a restart.
 *
 * NEVER log or return a full secret value — only a masked preview.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** The 5 keys the Settings UI manages. */
export const SETTINGS_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_DEFAULT_MODEL',
  'FAL_KEY',
  'VBEE_APP_ID',
  'VBEE_TOKEN',
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** Which keys hold secrets that must never be echoed back in full. */
const SECRET_KEYS: ReadonlySet<SettingsKey> = new Set([
  'OPENROUTER_API_KEY',
  'FAL_KEY',
  'VBEE_APP_ID',
  'VBEE_TOKEN',
]);

export function isSettingsKey(key: string): key is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

export interface SettingSummary {
  key: SettingsKey;
  isSet: boolean;
  preview: string | null;
  secret: boolean;
  /** Only present for non-secret keys, and only when set. */
  value?: string;
}

/**
 * `'••••' + last 4 chars`, or fully masked (no tail) when the value is short
 * enough that showing 4 trailing chars would reveal the whole secret.
 */
function maskPreview(value: string): string {
  if (value.length <= 4) {
    return '••••';
  }
  return `••••${value.slice(-4)}`;
}

function summarize(key: SettingsKey, rawValue: string | undefined): SettingSummary {
  const secret = SECRET_KEYS.has(key);
  const isSet = typeof rawValue === 'string' && rawValue !== '';

  if (secret) {
    return { key, isSet, preview: isSet ? maskPreview(rawValue as string) : null, secret: true };
  }

  return {
    key,
    isSet,
    preview: isSet ? maskPreview(rawValue as string) : null,
    secret: false,
    ...(isSet ? { value: rawValue as string } : {}),
  };
}

/** Reads all 5 settings from `process.env`, masked per SPEC-step6.md §1. */
export function readSettings(): SettingSummary[] {
  return SETTINGS_KEYS.map((key) => summarize(key, process.env[key]));
}

/**
 * Parses a `KEY=VALUE` env file's lines, preserving everything (comments,
 * blank lines, unrelated keys) verbatim except the keys we're updating.
 */
function findLineIndex(lines: string[], key: string): number {
  const prefix = `${key}=`;
  return lines.findIndex((line) => line.startsWith(prefix));
}

/**
 * Applies `updates` to the env file at `filePath` (creating it if absent),
 * keeping unrelated lines untouched: existing keys are replaced in place,
 * new keys are appended. Also mirrors every update into `process.env`
 * immediately.
 *
 * `updates` with an empty-string value are ignored entirely (per spec: "value
 * rỗng → bỏ qua key đó") — they update neither the file nor `process.env`.
 */
export function updateSettings(
  filePath: string,
  updates: Partial<Record<SettingsKey, string>>,
): SettingSummary[] {
  const entries = Object.entries(updates).filter(
    ([, value]) => typeof value === 'string' && value !== '',
  ) as Array<[SettingsKey, string]>;

  // Defense in depth: the route handler already rejects newline-bearing
  // values with 400 before calling this, but never write one to the env
  // file even if called directly — a bare newline can inject/overwrite an
  // unrelated key on the next dotenv parse (see SPEC-step6.md §1).
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`Giá trị của "${key}" không được chứa ký tự xuống dòng`);
    }
  }

  if (entries.length > 0) {
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    const hadTrailingNewline = existing === '' || existing.endsWith('\n');
    const lines = existing === '' ? [] : existing.split('\n');
    // split('\n') on a trailing-newline file yields a trailing '' entry —
    // drop it so we don't append after a phantom blank line.
    if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    for (const [key, value] of entries) {
      const line = `${key}=${value}`;
      const idx = findLineIndex(lines, key);
      if (idx >= 0) {
        lines[idx] = line;
      } else {
        lines.push(line);
      }
      process.env[key] = value;
    }

    writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  }

  return readSettings();
}
