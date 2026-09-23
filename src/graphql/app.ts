import { randomUUID } from 'node:crypto';
import express, { ErrorRequestHandler } from 'express';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { expressMiddleware } from '@as-integrations/express5';
import { GraphQLError } from 'graphql';
import { Logger } from 'pino';
import { Config } from '../config';
import { idSchema, VehicleRepository } from '../domain/vehicle/model';
import { typeDefs } from './schema';

interface Context { requestId: string }
function badInput(message: string): never { throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } }); }
function validId(value: string): string {
  if (!idSchema.safeParse(value).success) badInput('ID must be a positive numeric string of at most 15 digits');
  return value;
}

export async function createApp(repository: VehicleRepository, logger: Logger, config: Config) {
  const server = new ApolloServer<Context>({
    typeDefs,
    // index.ts closes HTTP, ingestion, Apollo, and the database in order.
    stopOnTerminationSignals: false,
    resolvers: { Query: {
      make: (_: unknown, { makeId }: { makeId: string }) => repository.findById(validId(makeId)),
      makes: (_: unknown, { first = 25, after }: { first?: number | null; after?: string | null }) => {
        if (first === null || !Number.isInteger(first) || first < 1 || first > 100) badInput('first must be between 1 and 100');
        return repository.list(first, after == null ? undefined : validId(after));
      },
      catalogStatus: () => repository.status(),
    } },
    introspection: config.NODE_ENV !== 'production',
    includeStacktraceInErrorResponses: false,
    allowBatchedHttpRequests: false,
    csrfPrevention: true,
    plugins: [ApolloServerPluginLandingPageDisabled(), {
      async requestDidStart() { return {
        async didEncounterErrors({ errors, contextValue }) {
          for (const error of errors) logger.error({ event: 'graphql_error', requestId: contextValue.requestId,
            code: error.extensions.code, err: error.originalError ?? error });
        },
      }; },
    }],
    formatError: formatted => {
      if (formatted.extensions?.code === 'INTERNAL_SERVER_ERROR') return {
        message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' },
      };
      return formatted;
    },
  });
  await server.start();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = Date.now();
    const path = req.path;
    res.on('finish', () => logger.info({ event: 'http_request', requestId, method: req.method,
      path, statusCode: res.statusCode, durationMs: Date.now() - started }));
    next();
  });
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/graphql', express.json({ limit: '32kb' }), expressMiddleware(server, {
    context: async ({ res }) => ({ requestId: res.locals.requestId as string }),
  }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof SyntaxError ? 400 : error?.type === 'entity.too.large' ? 413 : 500;
    logger.error({ event: 'http_error', requestId: res.locals.requestId, statusCode: status, err: error });
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request body' });
  };
  app.use(errors);
  return { app, server };
}
