/**
 * PatchOp schema + `applyPatch` (SPEC-step5.md §3) — moved to
 * `packages/shared` by SPEC-step25.md §1 so `apps/web` can depend on the
 * same domain logic. This file is now a thin re-export so every existing
 * caller's import path (`../agent/patch.js` / `./patch.js`) keeps working
 * unchanged — see `packages/shared/src/patch.ts` for the actual
 * implementation and doc comments.
 */
export {
  applyPatch,
  changeScope,
  opScope,
  PatchError,
  PatchOpArraySchema,
  PatchOpSchema,
  type PatchEdgeShape,
  type PatchNodeShape,
  type PatchOp,
  type WorkflowShape,
} from 'shared';
