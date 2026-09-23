import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integer(3000, 1, 65535),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().url().refine(v => /^postgres(ql)?:\/\//.test(v), 'Must be a PostgreSQL URL'),
  DATABASE_POOL_MAX: integer(10, 2, 100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NHTSA_BASE_URL: z.string().url().refine(v => /^https?:\/\//.test(v), 'Must use HTTP(S)')
    .default('https://vpic.nhtsa.dot.gov/api/vehicles/').transform(v => v.endsWith('/') ? v : `${v}/`),
  HTTP_TIMEOUT_MS: integer(15000, 100, 120000),
  HTTP_MAX_ATTEMPTS: integer(4, 1, 8),
  INGEST_CONCURRENCY: integer(4, 1, 16),
  INGEST_ON_STARTUP: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  SHUTDOWN_TIMEOUT_MS: integer(30000, 1000, 120000),
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report field names only; the database URL may contain a password.
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}
