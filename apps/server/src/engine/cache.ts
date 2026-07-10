import { createHash } from 'node:crypto';
import type { PortValue } from './types.js';

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      sorted[key] = sortForCanonicalJson(val);
    }
    return sorted;
  }
  return value;
}

/**
 * Round-trips through standard JSON.stringify/parse first so values with
 * `toJSON()` (Date, etc.) — or other non-plain-object shapes — normalize the
 * same way they would when actually persisted (e.g. SqliteCacheStore's plain
 * JSON.stringify), instead of being destroyed by the Object.entries rebuild
 * in sortForCanonicalJson (which ignores toJSON and turns e.g. any Date into
 * '{}', causing cache-key collisions between distinct values).
 */
function toPlainJsonValue(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : JSON.parse(json);
}

/** JSON.stringify with recursively sorted object keys; array order is preserved as-is. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(toPlainJsonValue(value)));
}

export function cacheKey(nodeType: string, params: unknown, inputs: Record<string, PortValue>): string {
  const canonical = canonicalJson({ nodeType, params, inputs });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface CacheStore {
  get(key: string): Record<string, PortValue> | undefined;
  set(key: string, nodeType: string, outputs: Record<string, PortValue>): void;
}

export class InMemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, Record<string, PortValue>>();

  get(key: string): Record<string, PortValue> | undefined {
    return this.store.get(key);
  }

  set(key: string, _nodeType: string, outputs: Record<string, PortValue>): void {
    this.store.set(key, outputs);
  }
}
