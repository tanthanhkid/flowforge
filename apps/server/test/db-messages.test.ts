/**
 * SPEC-step20.md §5.3 — MessagesRepo.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationsRepo } from '../src/db/conversations.js';
import { MessagesRepo } from '../src/db/messages.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';

function makeWorkflow(id: string): Workflow {
  return { version: 1, id, name: '', nodes: [], edges: [] };
}

describe('MessagesRepo', () => {
  let db: Database.Database;
  let repo: MessagesRepo;
  let clock: number;

  beforeEach(() => {
    db = openDb(':memory:');
    clock = 1000;
    new WorkflowsRepo(db, () => clock).create(makeWorkflow('wf-1'));
    new ConversationsRepo(db, () => clock).create({ id: 'c1', workflowId: 'wf-1' });
    repo = new MessagesRepo(db, () => clock);
  });

  afterEach(() => {
    db.close();
  });

  it('create() then get() round-trips, status defaults to done', () => {
    const msg = repo.create({ id: 'm1', conversationId: 'c1', role: 'user', content: 'hi' });
    expect(msg).toEqual({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'hi',
      status: 'done',
      error: undefined,
      changeId: undefined,
      createdAt: 1000,
    });
    expect(repo.get('m1')).toEqual(msg);
  });

  it('listByConversation returns messages ordered by created_at then rowid', () => {
    clock = 100;
    repo.create({ id: 'm1', conversationId: 'c1', role: 'user', content: 'first' });
    clock = 100; // same timestamp as m1 -> tie-broken by rowid (insertion order)
    repo.create({ id: 'm2', conversationId: 'c1', role: 'assistant', content: 'second', status: 'pending' });
    clock = 50; // earlier timestamp but inserted last
    repo.create({ id: 'm3', conversationId: 'c1', role: 'user', content: 'should sort before the others' });

    const list = repo.listByConversation('c1');
    expect(list.map((m) => m.id)).toEqual(['m3', 'm1', 'm2']);
  });

  it('update() carries a turn through pending -> streaming -> done, keeping unset fields', () => {
    repo.create({ id: 'm1', conversationId: 'c1', role: 'assistant', content: '', status: 'pending' });

    repo.update('m1', { status: 'streaming' });
    expect(repo.get('m1')).toMatchObject({ status: 'streaming', content: '' });

    repo.update('m1', { content: 'Đã xong', status: 'done', changeId: 7 });
    const done = repo.get('m1')!;
    expect(done.status).toBe('done');
    expect(done.content).toBe('Đã xong');
    expect(done.changeId).toBe(7);
    expect(done.error).toBeUndefined();
  });

  it('update() carries a turn through pending -> error, setting the error message', () => {
    repo.create({ id: 'm1', conversationId: 'c1', role: 'assistant', content: '', status: 'pending' });
    repo.update('m1', { status: 'error', error: 'OpenRouter timeout' });
    const failed = repo.get('m1')!;
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('OpenRouter timeout');
    expect(failed.changeId).toBeUndefined();
  });

  it('update() on an unknown id is a no-op', () => {
    expect(() => repo.update('missing', { status: 'done' })).not.toThrow();
  });

  it('create() accepts an initial changeId', () => {
    const msg = repo.create({ id: 'm1', conversationId: 'c1', role: 'assistant', content: 'ok', changeId: 3 });
    expect(msg.changeId).toBe(3);
  });
});
