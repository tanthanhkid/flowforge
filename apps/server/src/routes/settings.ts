/** GET/PUT /api/settings (SPEC-step6.md §1). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isSettingsKey, readSettings, updateSettings, type SettingsKey } from '../settings.js';

export interface SettingsRouteOpts {
  /** Env file to read/write. Default: repo-root `.env.local`. */
  envFilePath: string;
}

export function registerSettingsRoutes(app: FastifyInstance, opts: SettingsRouteOpts): void {
  app.get('/api/settings', async () => ({ settings: readSettings() }));

  app.put('/api/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      reply.code(400).send({ error: 'Body phải là object { [key]: string }' });
      return;
    }

    const entries = Object.entries(body as Record<string, unknown>);
    const updates: Partial<Record<SettingsKey, string>> = {};

    for (const [key, value] of entries) {
      if (!isSettingsKey(key)) {
        reply.code(400).send({ error: `Key không hợp lệ: "${key}"` });
        return;
      }
      if (typeof value !== 'string') {
        reply.code(400).send({ error: `Giá trị của "${key}" phải là string` });
        return;
      }
      if (/[\r\n]/.test(value)) {
        reply.code(400).send({ error: `Giá trị của "${key}" không được chứa ký tự xuống dòng` });
        return;
      }
      updates[key] = value;
    }

    const settings = updateSettings(opts.envFilePath, updates);
    return { settings };
  });
}
