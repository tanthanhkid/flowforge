/**
 * SPEC-step10.md §1.3 — api-upload.test.ts.
 * `POST /api/upload`: happy path (multipart, small fixture) -> 201 with a
 * `path` that's actually servable via `GET /artifacts/uploads/<file>`;
 * missing file -> 400; over the 50MB cap -> 413; traversal attempts through
 * the newly-opened `uploads/` prefix on the artifacts route are still 400.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { buildServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function rawRequest(
  port: number,
  method: string,
  rawPath: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Hand-rolled multipart/form-data body — no need for a client library for one file field. */
function buildMultipartBody(
  boundary: string,
  fields: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
    if (field.filename) head += `; filename="${field.filename}"`;
    head += '\r\n';
    if (field.contentType) head += `Content-Type: ${field.contentType}\r\n`;
    head += '\r\n';
    parts.push(Buffer.from(head, 'utf-8'), field.data, Buffer.from('\r\n', 'utf-8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  return Buffer.concat(parts);
}

function uploadFile(port: number, filename: string, data: Buffer, contentType = 'application/octet-stream'): Promise<RawResponse> {
  const boundary = '----ff-test-boundary';
  const body = buildMultipartBody(boundary, [{ name: 'file', filename, contentType, data }]);
  return rawRequest(
    port,
    'POST',
    '/api/upload',
    { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
    body,
  );
}

describe('api-upload', () => {
  let app: FastifyInstance;
  let tmp: string;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-upload-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry: new NodeRegistry() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads a small file -> 201 with path/filename/mime/size/kind, and the path is servable via /artifacts', async () => {
    const fixture = readFileSync(path.join(fixturesDir, 'tiny.pdf'));
    const res = await uploadFile(port, 'my-doc.pdf', fixture, 'application/pdf');
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body.toString('utf-8')) as {
      path: string;
      filename: string;
      mime: string;
      size: number;
      kind: string;
    };
    expect(body.path).toMatch(/^uploads\/[^/]+\.pdf$/);
    expect(body.filename).toBe('my-doc.pdf');
    expect(body.size).toBe(fixture.length);
    expect(body.kind).toBe('pdf');

    const served = await rawRequest(port, 'GET', `/artifacts/${body.path}`, {}, Buffer.alloc(0));
    expect(served.status).toBe(200);
    expect(served.body.equals(fixture)).toBe(true);
  });

  it('classifies an image upload as kind "image"', async () => {
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const res = await uploadFile(port, 'pic.png', tinyPng, 'image/png');
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body.toString('utf-8')) as { kind: string; path: string };
    expect(body.kind).toBe('image');
    expect(body.path).toMatch(/^uploads\/[^/]+\.png$/);
  });

  it('sanitizes an unsafe/uppercase extension down to [a-z0-9]{1,8} or falls back to "bin"', async () => {
    const res = await uploadFile(port, 'weird.PnG', Buffer.from([1, 2, 3]), 'application/octet-stream');
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body.toString('utf-8')) as { path: string };
    expect(body.path).toMatch(/^uploads\/[^/]+\.png$/);
  });

  it('rejects a request with no file part with 400', async () => {
    const boundary = '----ff-test-boundary-nofile';
    const body = buildMultipartBody(boundary, [{ name: 'notfile', data: Buffer.from('hi') }]);
    const res = await rawRequest(
      port,
      'POST',
      '/api/upload',
      { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
      body,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-multipart request with 400', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/api/upload',
      { 'Content-Type': 'application/json', 'Content-Length': '2' },
      Buffer.from('{}'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a file over the 50MB cap with 413', async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 1, 1);
    const res = await uploadFile(port, 'big.bin', big);
    expect(res.status).toBe(413);
  }, 30_000);

  it('rejects an encoded-slash traversal attempt through uploads/ with 400', async () => {
    const res = await rawRequest(port, 'GET', '/artifacts/uploads%2F..%2Fsecret', {}, Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('rejects a literal ../ traversal attempt through uploads/ with 400', async () => {
    const res = await rawRequest(port, 'GET', '/artifacts/uploads/../secret', {}, Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('rejects an empty uploads/ filename with 400', async () => {
    const res = await rawRequest(port, 'GET', '/artifacts/uploads/', {}, Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('still rejects a plain (non-uploads) traversal attempt with 400', async () => {
    const res = await rawRequest(port, 'GET', '/artifacts/../x', {}, Buffer.alloc(0));
    expect(res.status).toBe(400);
  });
});
