import type { ZodType } from 'zod';

export type PortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'number' | 'any';

export interface MediaValue {
  kind: 'image' | 'video' | 'audio';
  path?: string; // relative path trong data/artifacts
  url?: string;
  mime?: string;
  meta?: Record<string, unknown>;
}

// text=string, number=number, image/video/audio=MediaValue, json/any=unknown
export type PortValue = unknown;

export interface PortSpec {
  type: PortType;
  required?: boolean;
  description?: string;
}

export interface ExecutionContext {
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  artifactsDir: string;
  log(message: string): void;
  // ghi file <hash-or-uuid>.<ext> vào artifactsDir, trả relative path
  saveArtifact(data: Buffer, ext: string): Promise<string>;
  poll<T>(
    check: () => Promise<{ done: boolean; value?: T }>,
    opts?: { initialDelayMs?: number; maxDelayMs?: number; factor?: number; timeoutMs?: number },
  ): Promise<T>;
}

export interface NodeDefinition<P = unknown> {
  type: string; // 'llm.generate'
  category: string; // 'llm' | 'image' | 'video' | 'audio' | 'utility'
  title: string;
  description?: string;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  paramsSchema: ZodType<P>;
  cacheable?: boolean; // default true
  execute(args: {
    inputs: Record<string, PortValue>;
    params: P;
    ctx: ExecutionContext;
  }): Promise<Record<string, PortValue>>;
}

export type NodeState = 'pending' | 'running' | 'success' | 'error' | 'skipped';
export type RunStatus = 'running' | 'success' | 'error';
