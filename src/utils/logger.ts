import pino from 'pino';
import { Config } from '../config';
export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>) {
  return pino({ level: config.LOG_LEVEL, base: { service: 'vehicle-catalog', environment: config.NODE_ENV },
    redact: ['password', 'DATABASE_URL', 'headers.authorization', 'headers.cookie'],
  });
}
