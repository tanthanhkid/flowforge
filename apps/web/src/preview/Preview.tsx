/**
 * Renders a PortValue for inline display (SPEC-step4.md §4): image/video/
 * audio -> a media element with `src` resolved from MediaValue.path/url;
 * text -> clamped to 5 lines; number/boolean -> plain text; json/object ->
 * recursively rendered so `output.collect`'s `{ in1: ..., in2: ... }` shape
 * shows each gathered value (media, text, or nested json) without any
 * special-casing of that specific node type.
 */
import type { MediaValue, PortValue } from '../api/types.ts';

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** MediaValue.path -> `/artifacts/${basename}`; MediaValue.url (no path) -> url directly (spec §4). */
export function mediaSrc(media: MediaValue): string | undefined {
  if (media.path) return `/artifacts/${encodeURIComponent(basename(media.path))}`;
  return media.url;
}

function isMediaValue(value: unknown): value is MediaValue {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

export interface PreviewProps {
  value: PortValue;
}

export function Preview({ value }: PreviewProps) {
  if (value === undefined || value === null) return null;

  if (isMediaValue(value)) {
    const src = mediaSrc(value);
    if (!src) {
      return <p className="text-[10px] text-red-500">{value.kind}: missing path/url</p>;
    }
    if (value.kind === 'image') {
      return <img src={src} alt="" className="max-h-32 max-w-full rounded object-contain" />;
    }
    if (value.kind === 'video') {
      return <video src={src} controls className="max-h-32 max-w-full rounded" />;
    }
    return <audio src={src} controls className="w-full" />;
  }

  if (typeof value === 'string') {
    return <p className="line-clamp-5 whitespace-pre-wrap break-words text-xs">{value}</p>;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-xs">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(value, null, 2)}</pre>;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className="flex flex-col gap-1">
        {entries.map(([key, v]) => (
          <div key={key} className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] text-slate-400">{key}</span>
            <Preview value={v} />
          </div>
        ))}
      </div>
    );
  }

  return <pre className="text-[10px]">{JSON.stringify(value)}</pre>;
}
