import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import pino from 'pino';
import { migrate, PostgresVehicleRepository } from '../src/infrastructure/database/postgres';
import { NhtsaClient } from '../src/infrastructure/nhtsa/client';
import { IngestionService } from '../src/services/ingestion';
import { createApp } from '../src/graphql/app';
import { loadConfig } from '../src/config';
import { emptyTypesXml, make, makesXml, typesXml } from './fixtures';

// These tests need PostgreSQL for transaction behavior.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL test database');
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
const repository = new PostgresVehicleRepository(pool);
const config = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: 'test' });
const logger = pino({ level: 'silent' });
let api: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await migrate(pool); // A second startup should leave the schema unchanged.
  api = await createApp(repository, logger, config);
});
beforeEach(async () => { await pool.query('TRUNCATE vehicle_makes, catalog_state'); });
afterAll(async () => {
  await api?.server.stop();
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('mocked upstream XML → real PostgreSQL → GraphQL, including persistence across connections', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    return new Response(path.endsWith('getallmakes') ? makesXml : path.endsWith('/440') ? typesXml : emptyTypesXml);
  });
  await new IngestionService(new NhtsaClient(config, logger, fetcher), repository, 2, logger).run();
  const response = await request(api.app).post('/graphql').send({ query: '{ makes(first: 1) { items { makeId makeName vehicleTypes { typeId typeName } } nextCursor } catalogStatus { makeCount lastSuccessfulIngestion } }' });
  expect(response.body.errors).toBeUndefined();
  expect(response.body.data.makes).toEqual({ items: [make], nextCursor: '440' });
  expect(response.body.data.catalogStatus.makeCount).toBe(2);
  expect(response.body.data.catalogStatus.lastSuccessfulIngestion).not.toBeNull();
  expect((await repository.list(1, '440')).items[0]).toEqual({ makeId: '441', makeName: 'TESLA', vehicleTypes: [] });
  const freshPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try { expect(await new PostgresVehicleRepository(freshPool).findById('440')).toEqual(make); }
  finally { await freshPool.end(); }
  // Makes missing from the next import should be removed.
  await repository.replace([make]);
  expect(await repository.findById('441')).toBeNull();
  expect((await repository.status()).makeCount).toBe(1);
});

test('a database insert failure after DELETE rolls back both catalog and metadata', async () => {
  await repository.replace([make]);
  const before = await repository.status();
  await pool.query(`CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Simulated disk/write failure'; END $$;
    CREATE TRIGGER fail_write BEFORE INSERT ON vehicle_makes FOR EACH ROW EXECUTE FUNCTION fail_insert();`);
  try {
    await expect(repository.replace([{ ...make, makeName: 'Changed' }])).rejects.toThrow('Simulated');
    expect(await repository.findById('440')).toEqual(make);
    expect(await repository.status()).toEqual(before);
  } finally { await pool.query('DROP TRIGGER fail_write ON vehicle_makes; DROP FUNCTION fail_insert()'); }
});

test('an upstream failure retains the previous snapshot', async () => {
  await repository.replace([make]);
  const source = { getMakes: async () => [{ makeId: '440', makeName: 'Changed' }], getVehicleTypes: async () => { throw new Error('offline'); } };
  await expect(new IngestionService(source, repository, 2, logger).run()).rejects.toThrow('offline');
  expect(await repository.findById('440')).toEqual(make);
});


test('numeric keyset pagination handles IDs with different lengths', async () => {
  await repository.replace(['10', '2', '100'].map(makeId => ({ ...make, makeId })));
  const first = await repository.list(2);
  expect(first.items.map(item => item.makeId)).toEqual(['2', '10']);
  expect(first.nextCursor).toBe('10');
  const second = await repository.list(2, first.nextCursor!);
  expect(second.items.map(item => item.makeId)).toEqual(['100']);
  expect(second.nextCursor).toBeNull();
});
