/**
 * Node registration (SPEC-step2.md §7): wires all 15 node types onto a
 * NodeRegistry (13 through SPEC-step32.md, `video.transcribe` added by
 * SPEC-step33.md §33a, `llm.selectMoments` added by SPEC-step33.md §33b).
 * `createDefaultRegistry()` is the one-liner the server/agent layer and
 * scripts reach for; `registerAllNodes()` is exposed separately so tests
 * can register onto a registry that already has mock nodes on it.
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
import { llmSelectMomentsNode } from './llm.selectMoments.js';
import { llmTransformNode } from './llm.transform.js';
import { outputCollectNode } from './output.collect.js';
import { textTemplateNode } from './text.template.js';
import { vbeeTtsNode } from './vbee.tts.js';
import { videoComposeNode } from './video.compose.js';
import { videoTranscribeNode } from './video.transcribe.js';

export function registerAllNodes(registry: NodeRegistry): void {
  registry.register(inputTextNode);
  registry.register(inputFileNode);
  registry.register(inputImageNode);
  registry.register(inputPdfNode);
  registry.register(inputMarkdownNode);
  registry.register(textTemplateNode);
  registry.register(outputCollectNode);
  registry.register(llmGenerateNode);
  registry.register(llmSelectMomentsNode);
  registry.register(llmTransformNode);
  registry.register(falImageNode);
  registry.register(falVideoNode);
  registry.register(vbeeTtsNode);
  registry.register(videoComposeNode);
  registry.register(videoTranscribeNode);
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
  llmSelectMomentsNode,
  llmTransformNode,
  outputCollectNode,
  textTemplateNode,
  vbeeTtsNode,
  videoComposeNode,
  videoTranscribeNode,
};
