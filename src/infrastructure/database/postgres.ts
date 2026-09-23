import { Pool, PoolClient } from 'pg';
import { Logger } from 'pino';
import { Config } from '../../config';
import { CatalogPage, CatalogStatus, SnapshotWriter, VehicleMake, VehicleRepository, makeSchema } from '../../domain/vehicle/model';

export function createPool(config: Config, logger: Logger): Pool {
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 30000,
    application_name: 'vehicle-catalog' });
  pool.on('error', error => logger.error({ event: 'database_pool_error', err: error }));
  return pool;
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    `);
    const applied = await client.query('SELECT version FROM schema_migrations WHERE version = 1');
    if (applied.rowCount === 0) {
      await client.query(`
        CREATE TABLE vehicle_makes (
          make_id bigint PRIMARY KEY CHECK (make_id > 0),
          payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
          CHECK (payload->>'makeId' = make_id::text),
          CHECK (jsonb_typeof(payload->'vehicleTypes') = 'array')
        );
        CREATE TABLE catalog_state (
          id boolean PRIMARY KEY DEFAULT true CHECK (id),
          make_count integer NOT NULL CHECK (make_count >= 0),
          last_successful_ingestion timestamptz NOT NULL
        );
        INSERT INTO schema_migrations(version) VALUES (1);
      `);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function replaceSnapshot(client: PoolClient, makes: VehicleMake[]): Promise<void> {
  if (!makes.length) throw new Error('Refusing empty snapshot');
  // Check here too, since callers can write without going through ingestion.
  const validated = makes.map(make => makeSchema.parse(make));
  await client.query('BEGIN');
  try {
    await client.query('CREATE TEMP TABLE staged_makes (LIKE vehicle_makes INCLUDING ALL) ON COMMIT DROP');
    for (let offset = 0; offset < validated.length; offset += 500) {
      await client.query(`INSERT INTO staged_makes(make_id, payload)
        SELECT (item->>'makeId')::bigint, item FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(validated.slice(offset, offset + 500))]);
    }
    // Readers see the previous catalog until this transaction commits.
    await client.query('DELETE FROM vehicle_makes');
    await client.query('INSERT INTO vehicle_makes SELECT * FROM staged_makes');
    await client.query(`INSERT INTO catalog_state(id, make_count, last_successful_ingestion)
      VALUES (true, $1, now()) ON CONFLICT(id) DO UPDATE
      SET make_count = EXCLUDED.make_count, last_successful_ingestion = EXCLUDED.last_successful_ingestion`, [validated.length]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export class PostgresVehicleRepository implements VehicleRepository, SnapshotWriter {
  constructor(private readonly pool: Pool) {}

  async replace(makes: VehicleMake[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await replaceSnapshot(client, makes);
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<VehicleMake | null> {
    const result = await this.pool.query<{ payload: VehicleMake }>('SELECT payload FROM vehicle_makes WHERE make_id = $1', [id]);
    return result.rows[0]?.payload ?? null;
  }
  async list(first: number, after = '0'): Promise<CatalogPage> {
    const result = await this.pool.query<{ payload: VehicleMake }>(
      'SELECT payload FROM vehicle_makes WHERE make_id > $1 ORDER BY make_id LIMIT $2', [after, first + 1]);
    const items = result.rows.slice(0, first).map(row => row.payload);
    return { items, nextCursor: result.rows.length > first ? items.at(-1)!.makeId : null };
  }
  async status(): Promise<CatalogStatus> {
    const result = await this.pool.query<{ make_count: number; last_successful_ingestion: Date }>(
      'SELECT make_count, last_successful_ingestion FROM catalog_state WHERE id = true');
    const state = result.rows[0];
    return { makeCount: state?.make_count ?? 0, lastSuccessfulIngestion: state?.last_successful_ingestion.toISOString() ?? null };
  }
}
