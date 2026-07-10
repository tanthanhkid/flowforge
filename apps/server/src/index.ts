/** Entry point (SPEC-step3.md §5): loadEnv() -> buildServer() -> listen. */
import { loadEnv } from './config.js';
import { createDefaultRegistry } from './nodes/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  loadEnv();

  const registry = createDefaultRegistry();
  const app = await buildServer({ logger: true, registry });
  const port = Number(process.env.PORT ?? 3001);

  await app.listen({ port, host: '0.0.0.0' });

  app.log.info(`FlowForge server listening on port ${port} (${registry.list().length} node types registered)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start FlowForge server:', err);
  process.exitCode = 1;
});
