/** GET /api/registry (SPEC-step3.md §4). */
import type { FastifyInstance } from 'fastify';
import type { NodeRegistry } from '../engine/registry.js';

export function registerRegistryRoutes(app: FastifyInstance, registry: NodeRegistry): void {
  app.get('/api/registry', async () => ({ nodes: registry.describeForAgent() }));
}
