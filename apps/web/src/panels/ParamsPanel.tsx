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
 *   - modelId on fal.image/fal.video  -> tiered <select> over the curated
 *                                         fal model catalog (SPEC-step13.md
 *                                         §3), with a "✏️ Tự nhập model id..."
 *                                         escape hatch that reveals a free
 *                                         text input (keeps the original
 *                                         free-form modelId param intact)
 *   - model on llm.generate/llm.transform -> same tiered <select> pattern,
 *                                         over the curated OpenRouter catalog
 *                                         (SPEC-step14.md §3), with an extra
 *                                         first option "🔧 Mặc định hệ thống"
 *                                         mapped to value '' (params.model
 *                                         '' already means "use
 *                                         OPENROUTER_DEFAULT_MODEL" server-side)
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { uploadFile } from '../api/client.ts';
import type { JsonSchemaProperty } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';

const CUSTOM_MODEL_OPTION = '__custom__';

type ModelTier = 'xin' | 'kha' | 're';

/** Fields `ModelIdField` needs — both `FalModelPreset` and `OpenRouterModelPreset` satisfy this. */
interface CatalogPresetLike {
  id: string;
  label: string;
  tier: ModelTier;
  cost: string;
  note?: string;
  kind?: string;
}

const TIER_GROUP_LABEL: Record<ModelTier, string> = {
  xin: '💎 Xịn',
  kha: '✅ Khá',
  re: '💸 Rẻ',
};

const TIER_ORDER: ModelTier[] = ['xin', 'kha', 're'];

interface ModelIdFieldProps {
  name: string;
  value: unknown;
  models: CatalogPresetLike[];
  /** fal.video with an edge into its "image" input: prioritize video-i2v within each tier (SPEC-step13.md §3). */
  preferI2V?: boolean;
  /**
   * llm.generate/llm.transform's `model` param (SPEC-step14.md §3): an extra
   * first option ABOVE the tier groups, e.g. "🔧 Mặc định hệ thống" -> ''.
   * Selecting it (or the field already holding this value) is treated as
   * neither "matched" nor "custom" — it's its own third select state.
   */
  defaultOption?: { label: string; value: string };
  onApply: (value: unknown) => void;
}

/**
 * fal.image/fal.video's `modelId` param AND llm.generate/llm.transform's
 * `model` param: tiered select + free-text escape hatch (+ optional
 * "mặc định hệ thống" leading option for the llm case).
 */
function ModelIdField({ name, value, models, preferI2V, defaultOption, onApply }: ModelIdFieldProps) {
  const stringValue = value === undefined || value === null ? '' : String(value);
  const isDefaultSelected = defaultOption !== undefined && stringValue === defaultOption.value;
  const matched = isDefaultSelected ? undefined : models.find((m) => m.id === stringValue);
  const isCustom = !isDefaultSelected && stringValue !== '' && !matched;

  // Explicitly picking "✏️ Tự nhập model id..." must switch the UI into
  // custom mode WITHOUT touching the (still-matched) store value — that
  // can't be derived from `value` alone, so it needs its own bit of state
  // (SPEC-step13.md §3: "đổi sang 'Tự nhập' giữ được value").
  const [manualCustom, setManualCustom] = useState(false);
  const showCustomInput = isCustom || manualCustom;
  const selectValue = showCustomInput ? CUSTOM_MODEL_OPTION : stringValue;

  function handleSelectChange(raw: string): void {
    if (raw === CUSTOM_MODEL_OPTION) {
      // Switching to "Tự nhập" keeps the current value untouched — the text
      // input below simply becomes editable for it (SPEC-step13.md §3).
      setManualCustom(true);
      return;
    }
    setManualCustom(false);
    onApply(raw);
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{name}</span>
      <select
        className="rounded border border-slate-300 px-2 py-1 text-xs"
        value={selectValue}
        onChange={(event) => handleSelectChange(event.target.value)}
      >
        {defaultOption && <option value={defaultOption.value}>{defaultOption.label}</option>}
        {TIER_ORDER.map((tier) => {
          const inTier = models
            .filter((m) => m.tier === tier)
            .sort((a, b) => {
              if (!preferI2V) return 0;
              const aFirst = a.kind === 'video-i2v' ? -1 : 0;
              const bFirst = b.kind === 'video-i2v' ? -1 : 0;
              return aFirst - bFirst;
            });
          if (inTier.length === 0) return null;
          return (
            <optgroup key={tier} label={TIER_GROUP_LABEL[tier]}>
              {inTier.map((model) => (
                <option key={model.id} value={model.id} title={[model.note, model.id].filter(Boolean).join(' — ')}>
                  {model.label} — {model.cost}
                </option>
              ))}
            </optgroup>
          );
        })}
        <option value={CUSTOM_MODEL_OPTION}>✏️ Tự nhập model id...</option>
      </select>
      {matched && (
        <span className="text-[10px] text-slate-400">
          {matched.cost}
          {matched.note ? ` — ${matched.note}` : ''}
        </span>
      )}
      {showCustomInput && (
        <input
          type="text"
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          value={stringValue}
          placeholder="fal-ai/..."
          onChange={(event) => onApply(event.target.value)}
        />
      )}
    </label>
  );
}

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
    <span className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-slate-600">{name}</span>
      {schema.description && <span className="text-[10px] text-slate-400">{schema.description}</span>}
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
        <select
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          value={current}
          onChange={(event) => onApply(event.target.value)}
        >
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
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onApply(event.target.checked)} />
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
          className={`rounded border px-2 py-1 text-xs ${numberError ? 'border-red-500' : 'border-slate-300'}`}
          value={displayValue}
          min={schema.minimum ?? schema.exclusiveMinimum}
          max={schema.maximum ?? schema.exclusiveMaximum}
          onChange={(event) => onNumberChange(event.target.value)}
        />
        {numberError && <span className="text-[10px] text-red-500">Out of range</span>}
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
          className={`rounded border px-2 py-1 font-mono text-[11px] ${jsonError ? 'border-red-500' : 'border-slate-300'}`}
          value={displayValue}
          onChange={(event) => onJsonChange(event.target.value)}
        />
        {jsonError && <span className="text-[10px] text-red-500">Invalid JSON</span>}
      </label>
    );
  }

  const stringValue = value === undefined || value === null ? '' : String(value);
  if (isMultilineField(name, schema)) {
    return (
      <label className="flex flex-col gap-1">
        <FieldLabel name={name} schema={schema} />
        <textarea
          rows={4}
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          value={stringValue}
          onChange={(event) => onApply(event.target.value)}
        />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <FieldLabel name={name} schema={schema} />
      <input
        type="text"
        className="rounded border border-slate-300 px-2 py-1 text-xs"
        value={stringValue}
        onChange={(event) => onApply(event.target.value)}
      />
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
    return <div className="p-3 text-xs text-slate-400">Chọn một node trên canvas để xem/sửa params.</div>;
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

  // SPEC-step13.md §3 — fal.image/fal.video's `modelId` gets the tiered
  // catalog select instead of a plain text input.
  const modelIdModels =
    node.type === 'fal.image' ? modelCatalog.image : node.type === 'fal.video' ? modelCatalog.video : undefined;
  const preferI2V =
    node.type === 'fal.video' && workflow.edges.some((e) => e.to.node === node.id && e.to.port === 'image');

  // SPEC-step14.md §3 — llm.generate/llm.transform's `model` param gets the
  // same tiered select over the curated OpenRouter catalog, plus a leading
  // "🔧 Mặc định hệ thống" option mapped to value '' (server resolves '' to
  // OPENROUTER_DEFAULT_MODEL — see nodes/llm.generate.ts / llm.transform.ts).
  const isLlmModelField = node.type === 'llm.generate' || node.type === 'llm.transform';
  const llmModels = isLlmModelField ? modelCatalog.llm : undefined;

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div>
        <h2 className="text-sm font-semibold">{spec?.title ?? node.type}</h2>
        <p className="text-[10px] text-slate-400">{node.id}</p>
        {spec?.description && <p className="mt-1 text-xs text-slate-500">{spec.description}</p>}
      </div>

      <div className="flex flex-col gap-2">
        {Object.entries(properties).map(([name, schema]) =>
          name === 'modelId' && modelIdModels && modelIdModels.length > 0 ? (
            <ModelIdField
              key={name}
              name={name}
              value={node.params[name]}
              models={modelIdModels}
              preferI2V={preferI2V}
              onApply={(value) => applyField(name, value)}
            />
          ) : name === 'model' && llmModels && llmModels.length > 0 ? (
            <ModelIdField
              key={name}
              name={name}
              value={node.params[name]}
              models={llmModels}
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
        {Object.keys(properties).length === 0 && <p className="text-xs text-slate-400">Node này không có params.</p>}
      </div>

      {canUpload && (
        <div className="flex flex-col gap-1 border-t border-slate-200 pt-2">
          <button
            type="button"
            data-testid="upload-file-btn"
            onClick={() => fileInputRef.current?.click()}
            className="w-fit rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            📤 Chọn file...
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-testid="upload-file-input"
            accept={uploadAccept}
            className="hidden"
            onChange={handleFileChange}
          />
          {uploading && <span className="text-[10px] text-slate-400">Đang tải lên...</span>}
          {uploadError && (
            <span data-testid="upload-error" className="text-[10px] text-red-500">
              {uploadError}
            </span>
          )}
          {uploadFilename && !uploadError && (
            <span className="text-[10px] text-slate-500">Đã chọn: {uploadFilename}</span>
          )}
          {showImageThumb && (
            <img
              src={`/artifacts/${currentPath}`}
              alt="preview"
              data-testid="upload-image-thumb"
              className="max-h-24 w-fit rounded border border-slate-200 object-contain"
            />
          )}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-slate-200 pt-2">
        <button
          type="button"
          onClick={() => toggleForceNode(node.id)}
          className={`rounded border px-2 py-1 text-xs ${
            isForced ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
          }`}
        >
          {isForced ? '⚡ Sẽ force re-run ở lần Run kế tiếp' : 'Force re-run node này'}
        </button>
        <button
          type="button"
          onClick={() => removeNode(node.id)}
          className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
        >
          Delete node
        </button>
      </div>
    </div>
  );
}
