/**
 * SPEC-step3.md §6 — api-artifacts.test.ts.
 * A file written into artifactsDir is served with the right content-type;
 * `..%2Fsecret` and `../x` are rejected with 400 (path traversal); a missing
 * file is 404.
 *
 * Uses a raw `node:http` request against a real listening server rather than
 * `app.inject()` or `fetch()`: both of those construct a WHATWG URL under
 * the hood, which *resolves* `../` dot-segments client-side before the
 * request line is ever built (`new URL('/artifacts/../x', base).pathname`
 * is `/x`) — so a literal `../x` would never even reach the route handler
 * were it sent that way, silently making the traversal guard untestable (and
 * masking a real difference between "our guard didn't fire" and "no
 * traversal payload was ever sent"). A raw request preserves the literal
 * `..` in the request line, exercising the guard for real, the way a
 * non-browser HTTP client actually could.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { buildServer } from '../src/server.js';

function rawGet(port: number, rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('api-artifacts', () => {
  let app: FastifyInstance;
  let tmp: string;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-artifacts-serve-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry: new NodeRegistry() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves a file with the content-type for its extension', async () => {
    writeFileSync(path.join(tmp, 'hello.mp3'), Buffer.from([1, 2, 3, 4]));

    const res = await rawGet(port, '/artifacts/hello.mp3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.body.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it('serves other known extensions with their content-type', async () => {
    writeFileSync(path.join(tmp, 'pic.png'), Buffer.from([9, 9]));
    const res = await rawGet(port, '/artifacts/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('rejects an encoded-slash traversal attempt with 400', async () => {
    const res = await rawGet(port, '/artifacts/..%2Fsecret');
    expect(res.status).toBe(400);
  });

  it('rejects a literal ../ traversal attempt with 400', async () => {
    const res = await rawGet(port, '/artifacts/../x');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a file that does not exist', async () => {
    const res = await rawGet(port, '/artifacts/nope.mp3');
    expect(res.status).toBe(404);
  });

  // SPEC-step9.md §3: `?download=1` adds Content-Disposition: attachment so
  // the ResultsPanel's ⬇ Tải về link saves the file under its own name.
  it('adds Content-Disposition: attachment when ?download=1 is present', async () => {
    writeFileSync(path.join(tmp, 'hello.mp3'), Buffer.from([1, 2, 3, 4]));

    const res = await rawGet(port, '/artifacts/hello.mp3?download=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="hello.mp3"');
    expect(res.body.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it('does not add Content-Disposition by default (inline)', async () => {
    writeFileSync(path.join(tmp, 'hello.mp3'), Buffer.from([1, 2, 3, 4]));

    const res = await rawGet(port, '/artifacts/hello.mp3');
    expect(res.headers['content-disposition']).toBeUndefined();
  });
});
