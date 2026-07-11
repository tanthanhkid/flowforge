/**
 * Node registration (SPEC-step2.md §7): wires all 9 MVP node types onto a
 * NodeRegistry. `createDefaultRegistry()` is the one-liner the server/agent
 * layer and scripts reach for; `registerAllNodes()` is exposed separately so
 * tests can register onto a registry that already has mock nodes on it.
 */
import { NodeRegistry } from '../engine/registry.js';
import { falImageNode } from './fal.image.js';
import { falVideoNode } from './fal.video.js';
import { inputFileNode } from './input.file.js';
import { inputImageNode } from './input.image.js';
import { inputMarkdownNode } from './input.markdown.js';
import { inputPdfNode } from './input.pdf.js';
import { inputTextNode } from './input.text.js';
import { llmGenerateNode } from './llm.generate.js';
import { llmTransformNode } from './llm.transform.js';
import { outputCollectNode } from './output.collect.js';
import { textTemplateNode } from './text.template.js';
import { vbeeTtsNode } from './vbee.tts.js';
import { videoComposeNode } from './video.compose.js';

export function registerAllNodes(registry: NodeRegistry): void {
  registry.register(inputTextNode);
  registry.register(inputFileNode);
  registry.register(inputImageNode);
  registry.register(inputPdfNode);
  registry.register(inputMarkdownNode);
  registry.register(textTemplateNode);
  registry.register(outputCollectNode);
  registry.register(llmGenerateNode);
  registry.register(llmTransformNode);
  registry.register(falImageNode);
  registry.register(falVideoNode);
  registry.register(vbeeTtsNode);
  registry.register(videoComposeNode);
}

export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerAllNodes(registry);
  return registry;
}

export {
  falImageNode,
  falVideoNode,
  inputFileNode,
  inputImageNode,
  inputMarkdownNode,
  inputPdfNode,
  inputTextNode,
  llmGenerateNode,
  llmTransformNode,
  outputCollectNode,
  textTemplateNode,
  vbeeTtsNode,
  videoComposeNode,
};
