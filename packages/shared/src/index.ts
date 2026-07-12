/**
 * `packages/shared` public entry point (SPEC-step25.md §1). Currently just
 * the PatchOp domain (`agent/patch.ts` moved here) — re-exported from one
 * place so `apps/server` and `apps/web` both import from `'shared'` (see
 * `exports['.']` in package.json, which points straight at this TS source —
 * no build step).
 */
export * from './patch.js';
