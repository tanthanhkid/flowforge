/**
 * Renders a PortValue for inline display (SPEC-step4.md §4, compacted by
 * SPEC-step9.md §1): image/video/audio -> a media element with `src`
 * resolved from MediaValue.path/url; text -> clamped; number/boolean -> plain
 * text; json/object -> recursively rendered so `output.collect`'s
 * `{ in1: ..., in2: ... }` shape shows each gathered value (media, text, or
 * nested json) without any special-casing of that specific node type.
 *
 * `compact` (default true) governs sizing only, not which value kinds are
 * supported: NodeCard's inline preview uses the default (spec §1 — "thumbnail
 * ảnh/video max 80px cao, audio chỉ hiện icon + duration, text chỉ 1 dòng
 * đầu") so the node's height stays bounded and edges stay stable.
 * ResultsPanel passes `compact={false}` for its "Kết quả cuối" media/text —
 * this component still isn't used there for text directly (that block wants
 * a monospace scroll box + Copy button, which lives in ResultsPanel itself)
 * but is reused for the collapsed "Tất cả node" listing and for full-size
 * media rendering.
 */
import type { MediaValue, PortValue } from '../api/types.ts';

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** MediaValue.path -> `/artifacts/${basename}`; MediaValue.url (no path) -> url directly (spec §4). */
export function mediaSrc(media: MediaValue): string | undefined {
  if (media.path) return `/artifacts/${encodeURIComponent(basename(media.path))}`;
  return media.url;
}

export function isMediaValue(value: unknown): value is MediaValue {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

function formatAudioLabel(value: MediaValue): string {
  const duration = value.meta?.duration;
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    const minutes = Math.floor(duration / 60);
    const seconds = Math.round(duration % 60)
      .toString()
      .padStart(2, '0');
    return `🔊 ${minutes}:${seconds}`;
  }
  return '🔊 audio';
}

export interface PreviewProps {
  value: PortValue;
  /** Sizing only — see module doc. Defaults to true (NodeCard's inline use). */
  compact?: boolean;
}

export function Preview({ value, compact = true }: PreviewProps) {
  if (value === undefined || value === null) return null;

  if (isMediaValue(value)) {
    const src = mediaSrc(value);
    if (!src) {
      return <p className="text-[10px] text-red-500">{value.kind}: missing path/url</p>;
    }
    if (value.kind === 'image') {
      return (
        <img
          src={src}
          alt=""
          className={compact ? 'max-h-20 max-w-full rounded object-contain' : 'w-full rounded object-contain'}
        />
      );
    }
    if (value.kind === 'video') {
      return (
        <video src={src} controls className={compact ? 'max-h-20 max-w-full rounded' : 'w-full rounded'} />
      );
    }
    // audio: compact mode skips the <audio> player entirely (spec §1 —
    // "audio chỉ hiện icon 🔊 + duration") to keep the node's height bounded.
    if (compact) {
      return <span className="text-[10px] text-slate-500">{formatAudioLabel(value)}</span>;
    }
    return <audio src={src} controls className="w-full" />;
  }

  if (typeof value === 'string') {
    return (
      <p
        className={`whitespace-pre-wrap break-all text-xs ${compact ? 'line-clamp-1 overflow-hidden' : 'line-clamp-5'}`}
      >
        {value}
      </p>
    );
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-xs">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <pre className={`overflow-auto whitespace-pre-wrap break-words text-[10px] ${compact ? 'max-h-16' : 'max-h-64'}`}>
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className="flex flex-col gap-1">
        {entries.map(([key, v]) => (
          <div key={key} className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] text-slate-400">{key}</span>
            <Preview value={v} compact={compact} />
          </div>
        ))}
      </div>
    );
  }

  return <pre className="text-[10px]">{JSON.stringify(value)}</pre>;
}
