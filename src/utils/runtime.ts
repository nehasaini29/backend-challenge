import { loadConfig } from '../config';
import { createPool, migrate, PostgresVehicleRepository } from '../infrastructure/database/postgres';
import { NhtsaClient } from '../infrastructure/nhtsa/client';
import { IngestionService } from '../services/ingestion';
import { createLogger } from './logger';

export function createRuntime() {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const repository = new PostgresVehicleRepository(pool);
  const ingestion = new IngestionService(new NhtsaClient(config, logger), repository, config.INGEST_CONCURRENCY, logger);
  return { config, logger, pool, repository, ingestion, migrate: () => migrate(pool) };
}
