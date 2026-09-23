import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/graphql/app';
import { loadConfig } from '../src/config';
import { VehicleRepository } from '../src/domain/vehicle/model';
import { make } from './fixtures';
const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/test', NODE_ENV: 'test' });
const logger = pino({ level: 'silent' });
const repository: jest.Mocked<VehicleRepository> = { findById: jest.fn(), list: jest.fn(), status: jest.fn() };
let api: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => { api = await createApp(repository, logger, config); });
afterAll(async () => { await api.server.stop(); });
beforeEach(() => {
  repository.findById.mockResolvedValue(make);
  repository.list.mockResolvedValue({ items: [make], nextCursor: null });
  repository.status.mockResolvedValue({ makeCount: 1, lastSuccessfulIngestion: '2026-01-01T00:00:00.000Z' });
});
test('serves typed stored data with pagination', async () => {
  const res = await request(api.app).post('/graphql').send({ query: '{ makes(first: 1) { items { makeId makeName vehicleTypes { typeId typeName } } nextCursor } }' });
  expect(res.status).toBe(200);
  expect(res.body.data.makes.items).toEqual([make]);
  expect(res.headers['x-request-id']).toBeDefined();
  expect(repository.list).toHaveBeenCalledWith(1, undefined);
});
test.each(['{ makes(first: 101) { nextCursor } }', '{ makes(first: 0) { nextCursor } }', '{ makes(first: null) { nextCursor } }',
  '{ make(makeId: "abc") { makeId } }', '{ makes(after: "-1") { nextCursor } }'])('rejects invalid query arguments %s', async query => {
  const res = await request(api.app).post('/graphql').send({ query });
  expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
});
test('returns null for unknown IDs and masks database exceptions', async () => {
  repository.findById.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('postgresql://password-secret'));
  const query = '{ make(makeId: "440") { makeId } }';
  expect((await request(api.app).post('/graphql').send({ query })).body.data.make).toBeNull();
  const response = await request(api.app).post('/graphql').send({ query });
  expect(response.body.errors[0].message).toBe('Internal server error');
  expect(JSON.stringify(response.body)).not.toContain('password-secret');
});
test('rejects HTTP batching and malformed JSON', async () => {
  expect((await request(api.app).post('/graphql').send([{ query: '{ catalogStatus { makeCount } }' }])).status).toBe(400);
  expect((await request(api.app).post('/graphql').set('Content-Type', 'application/json').send('{')).status).toBe(400);
});
test('health reports that the HTTP service is running', async () => {
  const response = await request(api.app).get('/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(repository.status).not.toHaveBeenCalled();
});

test('production Apollo leaves signal handling to the application', async () => {
  const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  const production = await createApp(repository, logger, { ...config, NODE_ENV: 'production' });
  try {
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(before);
  } finally { await production.server.stop(); }
});

test('request logs retain the full route after Express mounts GraphQL', async () => {
  const log = jest.spyOn(logger, 'info');
  try {
    await request(api.app).post('/graphql').send({ query: '{ catalogStatus { makeCount } }' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'http_request', path: '/graphql', statusCode: 200 }));
  } finally { log.mockRestore(); }
});
