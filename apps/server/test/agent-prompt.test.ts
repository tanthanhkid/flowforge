/**
 * SPEC-step5.md §7 — agent-prompt.test.ts.
 * System prompts embed the full node catalog (all 9 real node types +
 * port names + paramsJsonSchema) and the 2 hard-coded few-shots parse to a
 * real Workflow and pass validateWorkflow() against the real registry.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEditSystemPrompt,
  buildGenerateSystemPrompt,
  GENERATE_FEWSHOT_CAPTION_IMAGE,
  GENERATE_FEWSHOT_SCRIPT_VBEE,
} from '../src/agent/promptBuilder.js';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
import { OPENROUTER_LLM_MODELS } from '../src/catalog/openrouterModels.js';
import { createDefaultRegistry } from '../src/nodes/index.js';
import { WorkflowSchema, validateWorkflow } from '../src/engine/schema.js';

const ALL_NODE_TYPES = [
  'input.text',
  'input.file',
  'text.template',
  'output.collect',
  'llm.generate',
  'llm.transform',
  'fal.image',
  'fal.video',
  'vbee.tts',
];

describe('buildGenerateSystemPrompt', () => {
  const registry = createDefaultRegistry();
  const prompt = buildGenerateSystemPrompt(registry);

  it('contains all 9 real node types', () => {
    for (const type of ALL_NODE_TYPES) {
      expect(prompt).toContain(type);
    }
  });

  it('contains the port names of each node type', () => {
    for (const def of registry.list()) {
      for (const portName of Object.keys(def.inputs)) {
        expect(prompt).toContain(portName);
      }
      for (const portName of Object.keys(def.outputs)) {
        expect(prompt).toContain(portName);
      }
    }
  });

  it('contains each node paramsJsonSchema (property names) serialized into the catalog', () => {
    for (const def of registry.describeForAgent()) {
      const schema = def.paramsJsonSchema as { properties?: Record<string, unknown> };
      for (const propName of Object.keys(schema.properties ?? {})) {
        expect(prompt).toContain(`"${propName}"`);
      }
    }
  });

  it('instructs the model to return ONLY JSON', () => {
    expect(prompt).toMatch(/DUY NHẤT JSON/);
  });

  it('few-shot (a) caption+image parses as a real Workflow and passes validateWorkflow()', () => {
    const parsed = WorkflowSchema.parse(GENERATE_FEWSHOT_CAPTION_IMAGE);
    const result = validateWorkflow(parsed, registry);
    expect(result.ok).toBe(true);
  });

  it('few-shot (b) script+vbee parses as a real Workflow and passes validateWorkflow()', () => {
    const parsed = WorkflowSchema.parse(GENERATE_FEWSHOT_SCRIPT_VBEE);
    const result = validateWorkflow(parsed, registry);
    expect(result.ok).toBe(true);
  });

  it('embeds both few-shots serialized into the prompt text', () => {
    expect(prompt).toContain(GENERATE_FEWSHOT_CAPTION_IMAGE.id);
    expect(prompt).toContain(GENERATE_FEWSHOT_SCRIPT_VBEE.id);
  });

  // SPEC-step13.md §2/§4 — the "MODEL CATALOG (fal)" section + the
  // tier-selection rule.
  it('contains the MODEL CATALOG (fal) section with a xịn-tier id and the tier-selection rule', () => {
    expect(prompt).toContain('MODEL CATALOG (fal)');
    const xinModel = [...FAL_VIDEO_MODELS, ...FAL_IMAGE_MODELS].find((m) => m.tier === 'xin');
    expect(xinModel).toBeDefined();
    expect(prompt).toContain(xinModel!.id);
    expect(prompt).toMatch(/mặc định chọn tier "kha"/);
  });

  // SPEC-step14.md §2/§3/§4 — the "MODEL CATALOG (OpenRouter LLM)" section +
  // the "params.model = ''" default rule.
  it('contains the MODEL CATALOG (OpenRouter LLM) section with an id + the default-"" rule', () => {
    expect(prompt).toContain('MODEL CATALOG (OpenRouter LLM)');
    expect(prompt).toContain(OPENROUTER_LLM_MODELS[0]!.id);
    expect(prompt).toMatch(/params\.model = ""/);
  });
});

describe('buildEditSystemPrompt', () => {
  const registry = createDefaultRegistry();
  const workflow = {
    version: 1 as const,
    id: 'wf-x',
    name: 'x',
    nodes: [{ id: 'a', type: 'input.text', params: { value: 'hi' } }],
    edges: [],
  };

  it('contains the node catalog, the current workflow JSON, the target nodeId, and the patch op list', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    for (const type of ALL_NODE_TYPES) {
      expect(prompt).toContain(type);
    }
    expect(prompt).toContain('"id": "wf-x"');
    expect(prompt).toContain('"a"');
    expect(prompt).toContain('update-node');
    expect(prompt).toContain('add-node');
    expect(prompt).toContain('remove-node');
    expect(prompt).toContain('add-edge');
    expect(prompt).toContain('remove-edge');
  });

  it('instructs the model to return ONLY a JSON array', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toMatch(/JSON array|MẢNG/);
  });

  it('also contains the MODEL CATALOG (fal) section', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toContain('MODEL CATALOG (fal)');
  });

  it('also contains the MODEL CATALOG (OpenRouter LLM) section', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toContain('MODEL CATALOG (OpenRouter LLM)');
  });
});
