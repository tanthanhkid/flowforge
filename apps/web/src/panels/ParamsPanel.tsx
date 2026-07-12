/**
 * Params form for the selected node, rendered from its NodeSpec's
 * paramsJsonSchema (SPEC-step4.md §4). Field types:
 *   - enum (schema.enum present)      -> <select>
 *   - boolean                         -> checkbox
 *   - number/integer                  -> number input, min/max from schema;
 *                                         out-of-range or unparsable input is
 *                                         NOT applied to the store (still
 *                                         shown so the user can fix it)
 *   - object (record/free-form JSON)  -> JSON textarea; a parse error is NOT
 *                                         applied (red border instead)
 *   - string (default)                -> text input, or a textarea when the
 *                                         field name is system/template/
 *                                         instruction or has a large maxLength
 *   - modelId on fal.image/fal.video  -> searchable combobox over the merged
 *                                         live+static fal catalog
 *                                         (SPEC-step19.md §2 — `ModelPicker`),
 *                                         always keeping a "✏️ Tự nhập model
 *                                         id..." escape hatch that reveals a
 *                                         free text input (free-form modelId
 *                                         param stays intact either way)
 *   - model on llm.generate/llm.transform -> same `ModelPicker`, over the
 *                                         merged OpenRouter catalog, with an
 *                                         extra first option "🔧 Mặc định hệ
 *                                         thống" mapped to value '' (params.model
 *                                         '' already means "use
 *                                         OPENROUTER_DEFAULT_MODEL" server-side)
 *
 * SPEC-step18.md §5.5 styling: mono uppercase labels (>=11px per §2 — the
 * mockup's 9.5px is a demo-only compromise, the spec's Vietnamese-text floor
 * overrides it), 2px black-border fields with a pink (cat-video) focus ring,
 * a hand-drawn checkbox (ink fill + accent ✓ when checked), and "Delete
 * node" pulled 24px + a divider away from the rest (destructive action must
 * not sit flush against routine ones — SPEC-step18.md §7 fix #7).
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { uploadFile } from '../api/client.ts';
import type { JsonSchemaProperty } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';
import { ModelPicker } from './ModelPicker.tsx';

// Shared field chrome (spec §5.5): 2px black border, 0 radius, pink focus
// ring; a "_MONO" variant for technical/JSON content (--font-mono-data), and
// an "_ERROR" variant (status-error border/ring) for invalid drafts.
const LABEL_CLASS = 'block font-mono-data text-[11px] font-bold uppercase tracking-wide text-ink-soft';
const FIELD_CLASS =
  'w-full border-2 border-ink bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)]';
const FIELD_ERROR_CLASS =
  'w-full border-2 border-status-error bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-status-error focus:shadow-[2px_2px_0_var(--color-status-error)]';
const FIELD_MONO_CLASS =
  'w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono-data text-[11px] text-ink focus:outline-none focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)]';
const FIELD_MONO_ERROR_CLASS =
  'w-full border-2 border-status-error bg-paper px-2 py-1.5 font-mono-data text-[11px] text-ink focus:outline-none focus:border-status-error focus:shadow-[2px_2px_0_var(--color-status-error)]';

// `content` (SPEC-step10.md §2): input.markdown's "type text directly" mode
// needs a big textarea just like system/template/instruction do.
const TEXTAREA_FIELD_NAMES = new Set(['system', 'template', 'instruction', 'content']);
const TEXTAREA_MAXLENGTH_THRESHOLD = 200;

// Node types whose `path` param can be filled by uploading a browser file
// (SPEC-step10.md §2) instead of typing a path by hand. `accept` is unset
// for `input.file` (any media extension it already supports).
const UPLOAD_ACCEPT_BY_TYPE: Record<string, string | undefined> = {
  'input.file': undefined,
  'input.image': 'image/*',
  'input.pdf': '.pdf',
  'input.markdown': '.md,.markdown,.txt',
};

function isMultilineField(name: string, schema: JsonSchemaProperty): boolean {
  return TEXTAREA_FIELD_NAMES.has(name) || (schema.maxLength !== undefined && schema.maxLength > TEXTAREA_MAXLENGTH_THRESHOLD);
}

function numberInRange(num: number, schema: JsonSchemaProperty): boolean {
  if (schema.minimum !== undefined && num < schema.minimum) return false;
  if (schema.maximum !== undefined && num > schema.maximum) return false;
  if (schema.exclusiveMinimum !== undefined && num <= schema.exclusiveMinimum) return false;
  if (schema.exclusiveMaximum !== undefined && num >= schema.exclusiveMaximum) return false;
  return true;
}

interface FieldLabelProps {
  name: string;
  schema: JsonSchemaProperty;
}

function FieldLabel({ name, schema }: FieldLabelProps) {
  return (
    <span className="flex flex-col gap-1">
      <span className={LABEL_CLASS}>{name}</span>
      {schema.description && <span className="text-[11px] text-ink-soft">{schema.description}</span>}
    </span>
  );
}

interface ParamFieldProps {
  name: string;
  schema: JsonSchemaProperty;
  value: unknown;
  numberDraft: string | undefined;
  numberError: boolean;
  jsonDraft: string | undefined;
  jsonError: boolean;
  onApply: (value: unknown) => void;
  onNumberChange: (raw: string) => void;
  onJsonChange: (raw: string) => void;
}

function ParamField({
  name,
  schema,
  value,
  numberDraft,
  numberError,
  jsonDraft,
  jsonError,
  onApply,
  onNumberChange,
  onJsonChange,
}: ParamFieldProps) {
  if (schema.enum) {
    const current = String(value ?? schema.default ?? schema.enum[0] ?? '');
    return (
      <label className="flex flex-col gap-1">
        <FieldLabel name={name} schema={schema} />
        <select className={FIELD_CLASS} value={current} onChange={(event) => onApply(event.target.value)}>
          {schema.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (schema.type === 'boolean') {
    const checked = Boolean(value);
    return (
      <label className="flex cursor-pointer select-none items-center gap-2">
        {/* Hand-drawn checkbox (spec §5.5): 16px square, ink border; checked
            = ink fill + accent "✓" drawn on top. The real <input> covers the
            whole box (appearance-none) so click/keyboard toggling and
            `role="checkbox"` stay native — the checkmark span just overlays
            it, `pointer-events-none` so clicks pass through. */}
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center border-2 border-ink bg-paper">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onApply(event.target.checked)}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none"
          />
          {checked && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink text-[11px] font-bold leading-none text-accent"
            >
              ✓
            </span>
          )}
        </span>
        <FieldLabel name={name} schema={schema} />
      </label>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    const displayValue = numberDraft ?? (value === undefined || value === null ? '' : String(value));
    return (
      <label className="flex flex-col gap-1">
        <FieldLabel name={name} schema={schema} />
        <input
          type="number"
          className={numberError ? FIELD_ERROR_CLASS : FIELD_CLASS}
          value={displayValue}
          min={schema.minimum ?? schema.exclusiveMinimum}
          max={schema.maximum ?? schema.exclusiveMaximum}
          onChange={(event) => onNumberChange(event.target.value)}
        />
        {numberError && <span className="font-mono-data text-[11px] text-status-error">Out of range</span>}
      </label>
    );
  }

  if (schema.type === 'object') {
    const displayValue = jsonDraft ?? JSON.stringify(value ?? {}, null, 2);
    return (
      <label className="flex flex-col gap-1">
        <FieldLabel name={name} schema={schema} />
        <textarea
          rows={3}
          className={jsonError ? FIELD_MONO_ERROR_CLASS : FIELD_MONO_CLASS}
          value={displayValue}
          onChange={(event) => onJsonChange(event.target.value)}
        />
        {jsonError && <span className="font-mono-data text-[11px] text-status-error">Invalid JSON</span>}
      </label>
    );
  }

  const stringValue = value === undefined || value === null ? '' : String(value);
  if (isMultilineField(name, schema)) {
    return (
      <label className="flex flex-col gap-1">
        <FieldLabel name={name} schema={schema} />
        <textarea rows={4} className={FIELD_CLASS} value={stringValue} onChange={(event) => onApply(event.target.value)} />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <FieldLabel name={name} schema={schema} />
      <input type="text" className={FIELD_CLASS} value={stringValue} onChange={(event) => onApply(event.target.value)} />
    </label>
  );
}

export function ParamsPanel() {
  const workflow = useFlowStore((s) => s.workflow);
  const selectedNodeId = useFlowStore((s) => s.selectedNodeId);
  const registry = useFlowStore((s) => s.registry);
  const modelCatalog = useFlowStore((s) => s.modelCatalog);
  const updateNodeParams = useFlowStore((s) => s.updateNodeParams);
  const removeNode = useFlowStore((s) => s.removeNode);
  const forceNodeIds = useFlowStore((s) => s.forceNodeIds);
  const toggleForceNode = useFlowStore((s) => s.toggleForceNode);

  const node = workflow.nodes.find((n) => n.id === selectedNodeId);
  const spec = node ? registry.find((s) => s.type === node.type) : undefined;

  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({});
  const [numberErrors, setNumberErrors] = useState<Record<string, boolean>>({});
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, boolean>>({});
  const [uploadFilename, setUploadFilename] = useState<string | undefined>();
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Switching to a different node (or its params changing externally, e.g.
  // via JSON view / openRun) drops any in-progress invalid drafts.
  useEffect(() => {
    setNumberDrafts({});
    setNumberErrors({});
    setJsonDrafts({});
    setJsonErrors({});
    setUploadFilename(undefined);
    setUploadError(undefined);
    setUploading(false);
  }, [selectedNodeId]);

  if (!node) {
    return <div className="p-4 text-xs text-ink-soft">Chọn một node trên canvas để xem/sửa params.</div>;
  }

  const properties = spec?.paramsJsonSchema.properties ?? {};

  function applyField(name: string, value: unknown): void {
    if (!node) return;
    updateNodeParams(node.id, { ...node.params, [name]: value });
  }

  function handleNumberChange(name: string, schema: JsonSchemaProperty, raw: string): void {
    setNumberDrafts((d) => ({ ...d, [name]: raw }));
    if (raw.trim() === '') {
      setNumberErrors((e) => ({ ...e, [name]: false }));
      return;
    }
    const parsed = schema.type === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    const valid = !Number.isNaN(parsed) && numberInRange(parsed, schema);
    setNumberErrors((e) => ({ ...e, [name]: !valid }));
    if (valid) applyField(name, parsed);
  }

  function handleJsonChange(name: string, raw: string): void {
    setJsonDrafts((d) => ({ ...d, [name]: raw }));
    try {
      const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
      setJsonErrors((e) => ({ ...e, [name]: false }));
      applyField(name, parsed);
    } catch {
      setJsonErrors((e) => ({ ...e, [name]: true }));
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Allow picking the same filename again later even after an error.
    event.target.value = '';
    if (!file) return;

    setUploading(true);
    setUploadError(undefined);
    try {
      const result = await uploadFile(file);
      applyField('path', result.path);
      setUploadFilename(result.filename);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const isForced = forceNodeIds.includes(node.id);
  const canUpload = node.type in UPLOAD_ACCEPT_BY_TYPE;
  const uploadAccept = UPLOAD_ACCEPT_BY_TYPE[node.type];
  const currentPath = node.params.path;
  const showImageThumb = node.type === 'input.image' && typeof currentPath === 'string' && currentPath.length > 0;

  // SPEC-step19.md §2 — fal.image/fal.video's `modelId` gets the searchable
  // ModelPicker over the merged live+static fal catalog instead of a plain
  // text input.
  const modelIdModels =
    node.type === 'fal.image' ? modelCatalog.falImage : node.type === 'fal.video' ? modelCatalog.falVideo : undefined;
  const hasImageEdge =
    node.type === 'fal.video' && workflow.edges.some((e) => e.to.node === node.id && e.to.port === 'image');
  const preferI2V = hasImageEdge;

  // SPEC-step17.md — fal.video: an image wired in but the selected preset is
  // text-to-video means fal.ai will silently ignore that image (and still
  // bill for the run). Warn inline with the same-family i2v suggestion when
  // the catalog has one; custom (non-catalog) model ids can't be checked.
  const t2vImageWarning = (() => {
    if (!hasImageEdge || node.type !== 'fal.video' || !modelIdModels) return undefined;
    const modelId = node.params.modelId;
    const preset = modelIdModels.find((m) => m.id === modelId);
    if (preset?.kind !== 'video-t2v') return undefined;
    // Same-family sibling: t2v/i2v catalog pairs share every path segment
    // except the last (SPEC-step17.md, mirrors server's findI2VSibling).
    const prefix = String(modelId).split('/').slice(0, -1).join('/');
    const sibling = modelIdModels.find(
      (m) => m.kind === 'video-i2v' && m.id.split('/').slice(0, -1).join('/') === prefix,
    );
    return `⚠ Ảnh nối vào sẽ bị bỏ qua — chọn model image-to-video${sibling ? ` (vd ${sibling.id})` : ''}`;
  })();

  // SPEC-step19.md §2 — llm.generate/llm.transform's `model` param gets the
  // same ModelPicker over the merged OpenRouter catalog, plus a leading
  // "🔧 Mặc định hệ thống" option mapped to value '' (server resolves '' to
  // OPENROUTER_DEFAULT_MODEL — see nodes/llm.generate.ts / llm.transform.ts).
  const isLlmModelField = node.type === 'llm.generate' || node.type === 'llm.transform';
  const llmModels = isLlmModelField ? modelCatalog.openrouter : undefined;

  return (
    <div className="flex flex-col gap-4 p-3 text-sm text-ink">
      <div className="border-b-2 border-ink pb-3">
        <h2 className="font-display text-sm uppercase leading-tight text-ink">{spec?.title ?? node.type}</h2>
        <p className="mt-1 font-mono-data text-[11px] text-ink-soft">{node.id}</p>
        {spec?.description && <p className="mt-1.5 text-xs text-ink-soft">{spec.description}</p>}
      </div>

      <div className="flex flex-col gap-3">
        {Object.entries(properties).map(([name, schema]) =>
          name === 'modelId' && modelIdModels && modelIdModels.length > 0 ? (
            <div key={name} className="flex flex-col gap-1">
              <ModelPicker
                name={name}
                value={node.params[name]}
                entries={modelIdModels}
                preferI2V={preferI2V}
                onApply={(value) => applyField(name, value)}
              />
              {t2vImageWarning && (
                <span data-testid="t2v-image-warning" className="text-[11px] font-medium text-status-error">
                  {t2vImageWarning}
                </span>
              )}
            </div>
          ) : name === 'model' && llmModels && llmModels.length > 0 ? (
            <ModelPicker
              key={name}
              name={name}
              value={node.params[name]}
              entries={llmModels}
              defaultOption={{ label: '🔧 Mặc định hệ thống', value: '' }}
              onApply={(value) => applyField(name, value)}
            />
          ) : (
            <ParamField
              key={name}
              name={name}
              schema={schema}
              value={node.params[name]}
              numberDraft={numberDrafts[name]}
              numberError={numberErrors[name] ?? false}
              jsonDraft={jsonDrafts[name]}
              jsonError={jsonErrors[name] ?? false}
              onApply={(value) => applyField(name, value)}
              onNumberChange={(raw) => handleNumberChange(name, schema, raw)}
              onJsonChange={(raw) => handleJsonChange(name, raw)}
            />
          ),
        )}
        {Object.keys(properties).length === 0 && <p className="text-xs text-ink-soft">Node này không có params.</p>}
      </div>

      {canUpload && (
        <div className="flex flex-col gap-2 border-t-2 border-ink pt-3">
          <Button
            type="button"
            variant="secondary"
            data-testid="upload-file-btn"
            onClick={() => fileInputRef.current?.click()}
            className="w-fit"
          >
            📤 Chọn file...
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            data-testid="upload-file-input"
            accept={uploadAccept}
            className="hidden"
            onChange={handleFileChange}
          />
          {uploading && <span className="font-mono-data text-[11px] text-ink-soft">Đang tải lên...</span>}
          {uploadError && (
            <span data-testid="upload-error" className="text-[11px] text-status-error">
              {uploadError}
            </span>
          )}
          {uploadFilename && !uploadError && (
            <span className="text-[11px] text-ink-soft">Đã chọn: {uploadFilename}</span>
          )}
          {showImageThumb && (
            <img
              src={`/artifacts/${currentPath}`}
              alt="preview"
              data-testid="upload-image-thumb"
              className="max-h-24 w-fit border-2 border-ink object-contain"
            />
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t-2 border-ink pt-3">
        <Button type="button" variant={isForced ? 'primary' : 'secondary'} onClick={() => toggleForceNode(node.id)} className="w-fit">
          {isForced ? '⚡ Sẽ force re-run ở lần Run kế tiếp' : 'Force re-run node này'}
        </Button>
      </div>

      {/* Destructive action: pulled 24px away + its own dashed divider so it
          never sits flush against routine actions above (SPEC-step18.md §7 fix #7). */}
      <div className="mt-6 flex flex-col gap-2 border-t-2 border-dashed border-ink pt-4">
        <Button type="button" variant="danger" onClick={() => removeNode(node.id)} className="w-fit">
          Delete node
        </Button>
      </div>
    </div>
  );
}
