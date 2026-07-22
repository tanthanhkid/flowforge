/**
 * `packages/shared` public entry point (SPEC-step25.md §1). Re-exports the
 * PatchOp domain (`agent/patch.ts` moved here) plus the `CutPlan`/transcript
 * contract added by SPEC-step33.md §33a — one place so `apps/server` and
 * `apps/web` both import from `'shared'` (see `exports['.']` in
 * package.json, which points straight at this TS source — no build step).
 */
export * from './patch.js';
export * from './cutPlan.js';
