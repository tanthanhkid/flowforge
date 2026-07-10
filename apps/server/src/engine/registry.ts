import { z } from 'zod';
import type { NodeDefinition, PortSpec, PortType } from './types.js';

export interface AgentPortSchema {
  type: PortType;
  required?: boolean;
  description?: string;
}

export interface AgentNodeSchema {
  type: string;
  category: string;
  title: string;
  description?: string;
  inputs: Record<string, AgentPortSchema>;
  outputs: Record<string, AgentPortSchema>;
  paramsJsonSchema: unknown;
}

function describePorts(ports: Record<string, PortSpec>): Record<string, AgentPortSchema> {
  const result: Record<string, AgentPortSchema> = {};
  for (const [name, spec] of Object.entries(ports)) {
    result[name] = { type: spec.type, required: spec.required, description: spec.description };
  }
  return result;
}

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition<any>>();

  register(def: NodeDefinition<any>): void {
    if (this.defs.has(def.type)) {
      throw new Error(`Node type already registered: ${def.type}`);
    }
    this.defs.set(def.type, def);
  }

  get(type: string): NodeDefinition | undefined {
    return this.defs.get(type);
  }

  list(): NodeDefinition[] {
    return Array.from(this.defs.values());
  }

  describeForAgent(): AgentNodeSchema[] {
    return this.list().map((def) => ({
      type: def.type,
      category: def.category,
      title: def.title,
      description: def.description,
      inputs: describePorts(def.inputs),
      outputs: describePorts(def.outputs),
      paramsJsonSchema: z.toJSONSchema(def.paramsSchema as z.ZodType),
    }));
  }
}
