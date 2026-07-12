/**
 * SPEC-step20.md §5.5 — WorkflowsRepo.saveVersioned() optimistic concurrency.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/sqlite.js';
import { VersionConflictError, WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';

function makeWorkflow(id: string, name = ''): Workflow {
  return { version: 1, id, name, nodes: [], edges: [] };
}

describe('WorkflowsRepo.saveVersioned', () => {
  let db: Database.Database;
  let repo: WorkflowsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = new WorkflowsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('bumps version 0 -> 1 -> 2 across successive saves on a brand-new workflow', () => {
    const wf = makeWorkflow('wf-1');
    expect(repo.getVersion('wf-1')).toBeUndefined();

    const v1 = repo.saveVersioned(wf);
    expect(v1).toBe(1);
    expect(repo.getVersion('wf-1')).toBe(1);

    const v2 = repo.saveVersioned(wf);
    expect(v2).toBe(2);
    expect(repo.getVersion('wf-1')).toBe(2);
  });

  it('getWithVersion returns the workflow and its current version', () => {
    const wf = makeWorkflow('wf-1', 'Named');
    repo.saveVersioned(wf);
    const result = repo.getWithVersion('wf-1');
    expect(result?.version).toBe(1);
    expect(result?.workflow).toEqual(wf);
    expect(repo.getWithVersion('missing')).toBeUndefined();
  });

  it('accepts a matching expectedVersion (including 0 for a not-yet-existing workflow)', () => {
    const wf = makeWorkflow('wf-1');
    expect(repo.saveVersioned(wf, 0)).toBe(1);
    expect(repo.saveVersioned(wf, 1)).toBe(2);
  });

  it('throws VersionConflictError carrying currentVersion when expectedVersion is stale, and leaves the DB untouched', () => {
    const wf = makeWorkflow('wf-1', 'Original');
    repo.saveVersioned(wf); // version -> 1

    const staleWrite = { ...wf, name: 'Stale write' };
    expect(() => repo.saveVersioned(staleWrite, 0)).toThrow(VersionConflictError);

    try {
      repo.saveVersioned(staleWrite, 0);
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      expect((err as VersionConflictError).currentVersion).toBe(1);
    }

    // DB unchanged: still version 1, name still the original write.
    const current = repo.getWithVersion('wf-1');
    expect(current?.version).toBe(1);
    expect(current?.workflow.name).toBe('Original');
  });

  it('conflict against a not-yet-existing workflow (expectedVersion != 0) does not create it', () => {
    const wf = makeWorkflow('wf-new');
    expect(() => repo.saveVersioned(wf, 5)).toThrow(VersionConflictError);
    expect(repo.exists('wf-new')).toBe(false);
  });

  it('upsert()/create() do not bump version (unchanged legacy semantics)', () => {
    const wf = makeWorkflow('wf-1');
    repo.create(wf);
    expect(repo.getVersion('wf-1')).toBe(0);
    repo.upsert({ ...wf, name: 'Renamed' });
    expect(repo.getVersion('wf-1')).toBe(0);
  });
});
