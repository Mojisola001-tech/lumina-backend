import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import cors from 'cors';
import express from 'express';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import { to as copyTo } from 'pg-copy-streams';
import { Context, createContext, resolvers } from './resolvers';
import { LedgerNotifier, SubscriberLimitError } from './pubsub';
import { subsystem } from './logger';
import {
  DEFAULT_API_KEY_HEADER,
  apiKeyAuthMiddleware,
  callerFromLocals,
  parseAllowAnonymous,
} from './auth';
import { buildServerHealth, metricsPlugin, samplePool, serverHealthStatusCode } from './observability';
import { v4 as uuidv4 } from 'uuid'; // TODO: Ensure 'uuid' is a dependency

interface Context extends BaseContext {
  correlationId: string;
  requestLogger: ReturnType<typeof subsystem>;
}
import {
  dbPoolErrors,
  listenerConnected,
  metricsContentType,
  renderMetrics,
  subscriptionsActive,
  subscriptionsRejected,
} from './metrics';
import { initTracing, shutdownTracing } from './tracing';
import { initErrorTracking, shutdownErrorTracking } from './errorTracking';
import { scheduledExportOptions, startScheduledExports } from './scheduledExport';

const log = subsystem('server');
const startedAt = Date.now();

// Read version from package.json for logging and API reporting
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const VERSION = packageJson.version;

const typeDefs = readFileSync(join(__dirname, 'schema.graphql'), 'utf-8');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina';
const PORT = parseInt(process.env.PORT ?? '4000', 10);
const MAX_SUBSCRIPTIONS = parseInt(process.env.MAX_SUBSCRIPTIONS ?? '500', 10);
const SUBSCRIPTION_QUEUE_LIMIT = parseInt(process.env.SUBSCRIPTION_QUEUE_LIMIT ?? '64', 10);
const API_KEY_HEADER = (process.env.API_KEY_HEADER ?? DEFAULT_API_KEY_HEADER).toLowerCase();
const ALLOW_ANONYMOUS_ACCESS = parseAllowAnonymous(process.env.ALLOW_ANONYMOUS_ACCESS);

const pool = new Pool({ 
  connectionString: DATABASE_URL,
  max: DB_POOL_MAX,
  idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT,
  connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT,
});
const schema = makeExecutableSchema({ typeDefs, resolvers });

const notifier = new LedgerNotifier({
  connectionString: DATABASE_URL,
  maxSubscribers: MAX_SUBSCRIPTIONS,
  queueLimit: SUBSCRIPTION_QUEUE_LIMIT,
  log: (message, detail) => subsystem('pubsub').info({ detail }, message),
});
let stopScheduledExports: () => Promise<void> = async () => {};

async function main() {
  if (process.env.RUN_MIGRATIONS_ON_STARTUP === 'true') {
    const status = await runMigrations(pool, loadMigrations());
    log.info({ applied: status.applied, pending: status.pending }, 'database migrations ready');
  }
  initErrorTracking();
  initTracing();

  const app = express();
  const httpServer = createServer(app);

  // Subscriptions need a real HTTP server to upgrade from, which
  // `startStandaloneServer` does not expose — hence Express here. The GraphQL
  // endpoint is mounted at both paths the previous standalone server answered
  // on, so no existing client has to change its URL.
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });

  const wsCleanup = useServer(
    {
      schema,
      // Subscriptions connect over a websocket and cannot present an HTTP
      // header, so they are always the anonymous caller. They are deliberately
      // not authenticated yet; when `ALLOW_ANONYMOUS_ACCESS=false` this is the
      // path that will need a key, and it is why that switch is documented as
      // covering queries only until then.
      context: async (): Promise<Context> => createContext(pool, { notifier }),
      onError: (_ctx: unknown, _message: unknown, errors: readonly Error[]) => {
        for (const error of errors) {
          log.error({ err: error.message }, 'subscription error');
        }
      },
      // A subscription refused for being over the cap should close cleanly with
      // a reason, not surface as an unhandled server error.
      onComplete: () => {
        subscriptionsActive.set(notifier.subscriberCount);
      },
      onSubscribe: () => {
        subscriptionsActive.set(notifier.subscriberCount);
        if (notifier.subscriberCount >= MAX_SUBSCRIPTIONS) {
          subscriptionsRejected.inc();
          log.warn({ limit: MAX_SUBSCRIPTIONS }, 'subscription refused at concurrency ceiling');
          // Returned as a GraphQLError so graphql-ws sends the client a proper
          // `error` message and closes the operation, rather than the
          // subscription failing later as an unhandled server error.
          return [new GraphQLError(new SubscriberLimitError(MAX_SUBSCRIPTIONS).message)];
        }
        return undefined;
      },
    },
    wsServer
  );

  const server = new ApolloServer<Context>({
    schema,
    plugins: [
      metricsPlugin(),
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        // Draining the websocket layer on shutdown as well, so a deploy does
        // not leave sockets hanging.
        async serverWillStart() {
          return {
            async drainServer() {
              await stopScheduledExports();
              await wsCleanup.dispose();
              await notifier.stop();
            },
          };
        },
      },
    ],
  });

  await server.start();
  await notifier.start();
  const exportOptions = scheduledExportOptions();
  if (exportOptions) {
    stopScheduledExports = startScheduledExports(pool, exportOptions);
    log.info({ bucket: exportOptions.bucket, intervalMs: exportOptions.intervalMs }, 'scheduled exports enabled');
  }

  // Ahead of the GraphQL middleware so an operator can always reach them, even
  // while the schema layer is unhappy.
  app.get('/health', (_req, res) => {
    buildServerHealth({
      pool,
      startedAt,
      listenerConnected: notifier.connected,
      subscriptionCount: notifier.subscriberCount,
    })
      .then(report => {
        listenerConnected.set(notifier.connected ? 1 : 0);
        res.status(serverHealthStatusCode(report)).json(report);
      })
      .catch(err => {
        log.error({ err: err instanceof Error ? err.message : err }, 'health check failed');
        res.status(500).json({ status: 'degraded', error: 'health check failed' });
      });
  });

  app.get('/metrics', (_req, res) => {
    // Sampled at scrape time so the numbers describe this instant rather than
    // whenever a background timer last fired.
    samplePool(pool);
    subscriptionsActive.set(notifier.subscriberCount);
    listenerConnected.set(notifier.connected ? 1 : 0);

    renderMetrics()
      .then(body => res.set('Content-Type', metricsContentType()).send(body))
      .catch(err => {
        log.error({ err: err instanceof Error ? err.message : err }, 'failed to render metrics');
        res.status(500).send('metrics unavailable');
      });
  });

  app.get('/export/:table', async (req, res) => {
    const table = req.params.table;
    if (!['transactions', 'operations', 'ledgers'].includes(table)) {
      res.status(400).send('Invalid table');
      return;
    }

    const { min_ledger, max_ledger, min_date, max_date } = req.query;

    const whereClauses: string[] = [];
    const ledgerCol = table === 'ledgers' ? 'sequence' : 'ledger';
    const dateCol = table === 'ledgers' ? 'closed_at' : 'created_at';

    if (min_ledger) {
      const parsed = parseInt(min_ledger as string, 10);
      if (!isNaN(parsed)) whereClauses.push(`${ledgerCol} >= ${parsed}`);
    }
    if (max_ledger) {
      const parsed = parseInt(max_ledger as string, 10);
      if (!isNaN(parsed)) whereClauses.push(`${ledgerCol} <= ${parsed}`);
    }
    if (min_date) {
      const parsed = new Date(min_date as string);
      if (!isNaN(parsed.getTime())) whereClauses.push(`${dateCol} >= '${parsed.toISOString()}'`);
    }
    if (max_date) {
      const parsed = new Date(max_date as string);
      if (!isNaN(parsed.getTime())) whereClauses.push(`${dateCol} <= '${parsed.toISOString()}'`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
      const client = await pool.connect();
      const query = `COPY (SELECT * FROM ${table} ${whereStr}) TO STDOUT WITH CSV HEADER`;
      const stream = client.query(copyTo(query));
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
      
      stream.pipe(res);
      stream.on('end', () => {
        client.release();
      });
      stream.on('error', (err) => {
        client.release();
        log.error({ err }, 'export stream error');
        if (!res.headersSent) res.status(500).send('export failed');
      });
    } catch (err) {
      log.error({ err }, 'export setup error');
      res.status(500).send('export failed');
    }
  });

  const middleware = [
    // CORS first so a 401 from the auth layer still carries the headers a
    // browser needs to read the error body.
    cors(),
    // Ahead of the body parser and the GraphQL layer both. The parser is
    // skipped for an unauthenticated request, so an anonymous caller cannot
    // make the server buffer an arbitrary payload, and a request that cannot be
    // attributed to a caller never reaches a resolver.
    apiKeyAuthMiddleware({ pool, allowAnonymous: ALLOW_ANONYMOUS_ACCESS, headerName: API_KEY_HEADER }),
    express.json(),
    expressMiddleware(server, {
      context: async ({ res }): Promise<Context> => {
        const caller = callerFromLocals(res.locals);
        if (!caller) {
          // The auth middleware always publishes a caller — anonymous included.
          // Absent here means it was not mounted on this route, and falling
          // back to the anonymous identity would quietly serve an API that was
          // configured to require keys.
          throw new Error('API key auth middleware did not run for this route');
        }
        return createContext(pool, { caller });
      },
    }),
  ];
  app.use('/graphql', ...middleware);
  app.use('/', ...middleware);

  await new Promise<void>(resolve => httpServer.listen({ port: PORT }, resolve));

  log.info(
    {
      version: VERSION,
      graphql: `http://localhost:${PORT}/graphql`,
      subscriptions: `ws://localhost:${PORT}/graphql`,
      health: `http://localhost:${PORT}/health`,
      metrics: `http://localhost:${PORT}/metrics`,
      apiKeyHeader: API_KEY_HEADER,
      anonymousAccess: ALLOW_ANONYMOUS_ACCESS,
      database: redactUrl(DATABASE_URL),
      dbPoolMax: DB_POOL_MAX ?? 10,
      dbPoolIdleTimeout: DB_POOL_IDLE_TIMEOUT ?? 10000,
      dbPoolConnectionTimeout: DB_POOL_CONNECTION_TIMEOUT ?? 0,
    },
    'lumina graphql server listening'
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      void server.stop()
        .then(() => shutdownTracing())
        .then(() => shutdownErrorTracking())
        .then(() => process.exit(0));
    });
  }
}

main().catch(err => {
  log.fatal({ err: err instanceof Error ? err.message : err }, 'failed to start graphql server');
  process.exit(1);
});

/** Never log a database URL with its password in it. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable)';
  }
}
