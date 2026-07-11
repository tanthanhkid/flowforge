/** GET /api/model-catalog (SPEC-step13.md §2, + `llm` key from SPEC-step14.md §2). */
import type { FastifyInstance } from 'fastify';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../catalog/falModels.js';
import { OPENROUTER_LLM_MODELS } from '../catalog/openrouterModels.js';

export function registerModelCatalogRoutes(app: FastifyInstance): void {
  app.get('/api/model-catalog', async () => ({
    video: FAL_VIDEO_MODELS,
    image: FAL_IMAGE_MODELS,
    llm: OPENROUTER_LLM_MODELS,
  }));
}
