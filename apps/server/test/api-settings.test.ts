/**
 * SPEC-step6.md §1 — api-settings.test.ts.
 *
 * Uses ONLY a tmp fixture env file with fake values — never touches the real
 * repo-root `.env.local`. Asserts GET/PUT responses never contain a full
 * secret value.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { buildServer } from '../src/server.js';

const FAKE_OPENROUTER_KEY = 'sk-or-fake-abcd1234';
const FAKE_FAL_KEY = 'fake_id:fake_secret_wxyz';
const FAKE_VBEE_APP_ID = 'fake-app-id-0099';
const FAKE_VBEE_TOKEN = 'fake-vbee-token-7788';

describe('api-settings', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let envFilePath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ff-settings-'));
    envFilePath = path.join(tmpDir, '.env.local');
    writeFileSync(
      envFilePath,
      [
        '# fixture env file — fake values only',
        `OPENROUTER_API_KEY=${FAKE_OPENROUTER_KEY}`,
        'OPENROUTER_DEFAULT_MODEL=x-ai/grok-4.5',
        `FAL_KEY=${FAKE_FAL_KEY}`,
        'UNRELATED_KEY=keep-me',
        '',
      ].join('\n'),
      'utf8',
    );

    app = await buildServer({
      dbPath: ':memory:',
      artifactsDir: mkdtempSync(path.join(os.tmpdir(), 'ff-settings-artifacts-')),
      registry: new NodeRegistry(),
      envFilePath,
    });

    // buildServer doesn't load the fixture file into process.env by itself
    // (that's config.ts's job, wired to the real repo-root file) — mirror
    // what a real PUT would have already done, so GET reflects the fixture.
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;
    process.env.OPENROUTER_DEFAULT_MODEL = 'x-ai/grok-4.5';
    process.env.FAL_KEY = FAKE_FAL_KEY;
    delete process.env.VBEE_APP_ID;
    delete process.env.VBEE_TOKEN;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET masks secrets and shows non-secret value in full', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { settings: Array<Record<string, unknown>> };

    const byKey = Object.fromEntries(body.settings.map((s) => [s.key, s]));

    expect(byKey.OPENROUTER_API_KEY).toMatchObject({
      isSet: true,
      secret: true,
      preview: '••••1234',
    });
    expect(byKey.OPENROUTER_API_KEY.value).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(FAKE_OPENROUTER_KEY);
    expect(JSON.stringify(body)).not.toContain(FAKE_FAL_KEY);

    expect(byKey.OPENROUTER_DEFAULT_MODEL).toMatchObject({
      isSet: true,
      secret: false,
      value: 'x-ai/grok-4.5',
    });

    expect(byKey.VBEE_APP_ID).toMatchObject({ isSet: false, secret: true, preview: null });
    expect(byKey.VBEE_TOKEN).toMatchObject({ isSet: false, secret: true, preview: null });
  });

  it('PUT updates process.env immediately and writes the file, preserving unrelated lines', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { VBEE_APP_ID: FAKE_VBEE_APP_ID, VBEE_TOKEN: FAKE_VBEE_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { settings: Array<Record<string, unknown>> };
    expect(JSON.stringify(body)).not.toContain(FAKE_VBEE_APP_ID);
    expect(JSON.stringify(body)).not.toContain(FAKE_VBEE_TOKEN);

    // process.env updated immediately.
    expect(process.env.VBEE_APP_ID).toBe(FAKE_VBEE_APP_ID);
    expect(process.env.VBEE_TOKEN).toBe(FAKE_VBEE_TOKEN);

    // File updated: unrelated lines/comments preserved, new keys appended.
    const written = readFileSync(envFilePath, 'utf8');
    expect(written).toContain('# fixture env file — fake values only');
    expect(written).toContain('UNRELATED_KEY=keep-me');
    expect(written).toContain(`OPENROUTER_API_KEY=${FAKE_OPENROUTER_KEY}`);
    expect(written).toContain(`VBEE_APP_ID=${FAKE_VBEE_APP_ID}`);
    expect(written).toContain(`VBEE_TOKEN=${FAKE_VBEE_TOKEN}`);
  });

  it('PUT replaces an existing key in place rather than duplicating it', async () => {
    const updated = 'sk-or-fake-NEWVALUE';
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { OPENROUTER_API_KEY: updated },
    });
    expect(res.statusCode).toBe(200);

    const written = readFileSync(envFilePath, 'utf8');
    const matches = written.split('\n').filter((l) => l.startsWith('OPENROUTER_API_KEY='));
    expect(matches).toEqual([`OPENROUTER_API_KEY=${updated}`]);
    expect(process.env.OPENROUTER_API_KEY).toBe(updated);
  });

  it('PUT ignores empty-string values for a key', async () => {
    const before = readFileSync(envFilePath, 'utf8');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { VBEE_TOKEN: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(envFilePath, 'utf8')).toBe(before);
    expect(process.env.VBEE_TOKEN).toBeUndefined();
  });

  it('PUT rejects an unknown key with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { NOT_A_REAL_KEY: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT rejects a value containing a newline with 400 and leaves the file untouched', async () => {
    const before = readFileSync(envFilePath, 'utf8');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { VBEE_APP_ID: 'fake-id\nOPENROUTER_API_KEY=injected' },
    });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(envFilePath, 'utf8')).toBe(before);
    expect(process.env.VBEE_APP_ID).toBeUndefined();
  });

  it('PUT rejects a value containing a carriage return with 400 and leaves the file untouched', async () => {
    const before = readFileSync(envFilePath, 'utf8');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { VBEE_TOKEN: 'abc\r\nEXTRA=1' },
    });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(envFilePath, 'utf8')).toBe(before);
    expect(process.env.VBEE_TOKEN).toBeUndefined();
  });

  it('GET fully masks a short secret (<=4 chars) instead of revealing it in the preview', async () => {
    const shortSecret = '7788';
    const res1 = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { VBEE_APP_ID: shortSecret },
    });
    expect(res1.statusCode).toBe(200);
    expect(JSON.stringify(res1.json())).not.toContain(shortSecret);

    const res2 = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = res2.json() as { settings: Array<Record<string, unknown>> };
    const byKey = Object.fromEntries(body.settings.map((s) => [s.key, s]));
    expect(byKey.VBEE_APP_ID).toMatchObject({ isSet: true, secret: true, preview: '••••' });
    expect(JSON.stringify(body)).not.toContain(shortSecret);
  });
});
