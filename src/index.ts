import { createServer } from 'node:http';
import { createApp } from './graphql/app';
import { createRuntime } from './utils/runtime';

async function main() {
  const runtime = createRuntime();
  const { config, logger, pool, repository, ingestion } = runtime;
  const abort = new AbortController();
  let ingestionTask: Promise<unknown> = Promise.resolve();
  let stopping = false;
  const { app, server } = await createApp(repository, logger, config);
  const http = createServer(app);
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;

  const shutdown = async (reason: string, failed = false) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = failed ? 1 : 0;
    logger.info({ event: 'shutdown_started', reason });
    const timer = setTimeout(() => { logger.fatal({ event: 'shutdown_timeout' }); process.exit(1); }, config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    abort.abort(new Error('Service shutting down'));
    try {
      await new Promise<void>(resolve => http.close(() => resolve()));
      await ingestionTask;
      await server.stop();
      await pool.end();
      logger.info({ event: 'shutdown_completed' });
    } catch (error) { logger.error({ event: 'shutdown_failed', err: error }); process.exitCode = 1; }
    finally { clearTimeout(timer); }
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('uncaughtException', error => { logger.fatal({ event: 'uncaught_exception', err: error }); void shutdown('uncaughtException', true); });
  process.once('unhandledRejection', error => { logger.fatal({ event: 'unhandled_rejection', err: error }); void shutdown('unhandledRejection', true); });

  try {
    await runtime.migrate();
    if (stopping) return;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.PORT, config.HOST, () => { http.off('error', reject); resolve(); });
    });
    if (stopping) return;
    logger.info({ event: 'startup_completed', port: config.PORT });
    if (config.INGEST_ON_STARTUP) ingestionTask = ingestion.run(abort.signal).catch(() => undefined);
  } catch (error) {
    logger.fatal({ event: 'startup_failed', err: error });
    await shutdown('startupFailed', true);
  }
}

void main().catch(error => {
  // Config validation can fail before the logger is created.
  process.stderr.write(`${JSON.stringify({ level: 'fatal', event: 'startup_failed', message: error instanceof Error ? error.message : 'Unknown error' })}\n`);
  process.exitCode = 1;
});
