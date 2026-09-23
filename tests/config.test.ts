import { loadConfig } from '../src/config';
const env = { DATABASE_URL: 'postgresql://user:secret@localhost/vehicles' };
test('configuration defaults and strict boolean parsing', () => {
  expect(loadConfig(env)).toMatchObject({ PORT: 3000, INGEST_CONCURRENCY: 4, INGEST_ON_STARTUP: true });
  expect(loadConfig({ ...env, INGEST_ON_STARTUP: 'false' }).INGEST_ON_STARTUP).toBe(false);
  expect(loadConfig({ ...env, NHTSA_BASE_URL: 'http://localhost/api' }).NHTSA_BASE_URL).toBe('http://localhost/api/');
});
test.each([{ PORT: 'bad' }, { INGEST_CONCURRENCY: '0' }, { NODE_ENV: 'invalid' }, { INGEST_ON_STARTUP: 'yes' },
  { DATABASE_URL: 'http://user:secret@localhost' }, { NHTSA_BASE_URL: 'ftp://localhost' }])('rejects invalid config %o', override => {
  expect(() => loadConfig({ ...env, ...override })).toThrow('Invalid configuration');
});
test('errors do not leak environment values', () => {
  expect(() => loadConfig({ DATABASE_URL: 'secret-password' })).toThrow('DATABASE_URL');
  try { loadConfig({ DATABASE_URL: 'secret-password' }); } catch (error) { expect(String(error)).not.toContain('secret-password'); }
});
