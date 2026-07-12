/**
 * GET /api/model-catalog + POST /api/catalog/refresh (SPEC-step19.md
 * §1.4/§1.6, replacing the SPEC-step13.md/SPEC-step14.md static-only
 * `{ video, image, llm }` shape).
 *
 * GET /api/model-catalog now returns the unified live+static catalog
 * (`{ falVideo, falImage, openrouter, meta }`, from `catalog/live/index.ts`'s
 * `getCatalog()`) directly — the web picker (SPEC-step19.md §2,
 * `apps/web/src/panels/ModelPicker.tsx`) reads exactly this shape (mirrored
 * field-for-field in `apps/web/src/api/types.ts`), so there is no legacy
 * `video`/`image`/`llm` shape left to keep serving alongside it.
 *
 * `publishCatalog` is this route's other job: every time it fetches/
 * refreshes the unified catalog, it pushes the result into the 3 other
 * SPEC-step19.md §1.6 consumers this step owns (`engine/costEstimate.ts`,
 * `nodes/fal.video.ts`, `agent/promptBuilder.ts`) via their own module-level
 * setters — see each file's own doc comment for why a push-based snapshot
 * (rather than threading `db`/async through their call sites) was the
 * chosen shape: it keeps every one of those 3 modules' existing sync
 * signatures and default (static-only) behavior 100% unchanged for any
 * caller that never touches this route.
 */
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { setPromptBuilderCatalog } from '../agent/promptBuilder.js';
import { getCatalog, refreshCatalog, type UnifiedCatalog } from '../catalog/live/index.js';
import { setLiveCatalogForCostEstimate } from '../engine/costEstimate.js';
import { setFalVideoLiveCatalog } from '../nodes/fal.video.js';

export interface ModelCatalogRouteDeps {
  db: Database.Database;
}

function publishCatalog(catalog: UnifiedCatalog): void {
  setLiveCatalogForCostEstimate(catalog);
  setFalVideoLiveCatalog(catalog.falVideo);
  setPromptBuilderCatalog(catalog);
}

export function registerModelCatalogRoutes(app: FastifyInstance, deps: ModelCatalogRouteDeps): void {
  const { db } = deps;

  app.get('/api/model-catalog', async () => {
    const catalog = await getCatalog(db);
    publishCatalog(catalog);
    return catalog;
  });

  // SPEC-step19.md §1.4: force refetch both providers regardless of TTL. No
  // stale-safe fallback exists for an explicit "refresh now" request — a
  // provider fetch failure here is surfaced as a 502 (relayed message is
  // already safe: fetch errors here never carry secrets, both providers are
  // keyless).
  //
  // `refreshCatalog()` itself honors the `CATALOG_LIVE=0`/`liveEnabled:
  // false` gate (post-review fix) — an explicit refresh is still live/
  // network access, so this route must never bypass it. When disabled it
  // returns immediately with the static-only counts and no fetch attempted;
  // this handler doesn't need its own env check.
  app.post('/api/catalog/refresh', async (_request, reply) => {
    try {
      const result = await refreshCatalog(db);
      const catalog = await getCatalog(db);
      publishCatalog(catalog);
      reply.code(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(502).send({ error: message });
    }
  });
}
