import { createRuntime } from './utils/runtime';

async function main() {
  const { config, logger, pool, ingestion, migrate } = createRuntime();
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    logger.info({ event: 'ingestion_shutdown_requested' });
    abort.abort(new Error('Ingestion shutting down'));
    timer ??= setTimeout(() => process.exit(1), config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await migrate(); await ingestion.run(abort.signal); }
  catch (error) { logger.error({ event: 'ingestion_command_failed', err: error }); process.exitCode = 1; }
  finally { await pool.end(); if (timer) clearTimeout(timer); logger.info({ event: 'ingestion_command_stopped' }); }
}
void main().catch(error => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', event: 'ingestion_command_failed', message: error instanceof Error ? error.message : 'Unknown error' })}\n`);
  process.exitCode = 1;
});
