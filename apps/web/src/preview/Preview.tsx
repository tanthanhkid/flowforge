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
 *
 * Neo-brutalist pass (SPEC-step18.md §5.6): media (image/video/non-compact
 * audio) gets a black-bordered "polaroid" frame — a thin 2px frame in
 * `compact` mode so NodeCard's fixed 300px box never grows, a thicker 4px
 * frame with a hard shadow when `compact={false}` (ResultsPanel's full-size
 * use). Everything else swaps hand-rolled slate/red utility colors for the
 * shared design tokens (ink/ink-soft/status-error, mono-data font).
 */
import type { ReactNode } from 'react';
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

/** Black-bordered "polaroid" media frame (spec §5.6) — thin in compact mode so it never widens a 300px NodeCard. */
function PolaroidFrame({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <div
      className={
        compact
          ? 'inline-block max-w-full border-2 border-ink bg-paper p-0.5'
          : 'inline-block w-full border-4 border-ink bg-paper p-1.5 shadow-hard-3'
      }
    >
      {children}
    </div>
  );
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
      return (
        <p className="text-[11px] font-bold text-status-error">
          {value.kind}: missing path/url
        </p>
      );
    }
    if (value.kind === 'image') {
      return (
        <PolaroidFrame compact={compact}>
          <img
            src={src}
            alt=""
            className={compact ? 'max-h-20 max-w-full object-contain' : 'w-full object-contain'}
          />
        </PolaroidFrame>
      );
    }
    if (value.kind === 'video') {
      return (
        <PolaroidFrame compact={compact}>
          <video src={src} controls className={compact ? 'max-h-20 max-w-full' : 'w-full'} />
        </PolaroidFrame>
      );
    }
    // audio: compact mode skips the <audio> player entirely (spec §1 —
    // "audio chỉ hiện icon 🔊 + duration") to keep the node's height bounded.
    if (compact) {
      return <span className="font-mono-data text-[11px] font-bold text-ink-soft">{formatAudioLabel(value)}</span>;
    }
    return (
      <PolaroidFrame compact={compact}>
        <audio src={src} controls className="w-full" />
      </PolaroidFrame>
    );
  }

  if (typeof value === 'string') {
    return (
      <p
        className={`whitespace-pre-wrap break-all text-[11px] text-ink ${compact ? 'line-clamp-1 overflow-hidden' : 'line-clamp-5'}`}
      >
        {value}
      </p>
    );
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono-data text-[11px] text-ink">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <pre
        className={`overflow-auto whitespace-pre-wrap break-words border-2 border-ink bg-bg p-1 font-mono-data text-[10px] text-ink ${compact ? 'max-h-16' : 'max-h-64'}`}
      >
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
            <span className="font-mono-data text-[10px] text-ink-soft">{key}</span>
            <Preview value={v} compact={compact} />
          </div>
        ))}
      </div>
    );
  }

  return <pre className="text-[10px] text-ink">{JSON.stringify(value)}</pre>;
}
