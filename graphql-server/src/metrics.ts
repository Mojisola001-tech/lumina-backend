/**
 * GraphQL server metrics.
 *
 * Latency is recorded per *operation name* rather than per HTTP route, because
 * every GraphQL request is a POST to the same path — a route histogram would
 * average a cheap `latestLedger` together with a deep `account` traversal and
 * tell you nothing about either.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'lumina_graphql_' });

export const graphqlOperations = new Counter({
  name: 'lumina_graphql_operations_total',
  help: 'GraphQL operations by name, type and outcome.',
  labelNames: ['operation', 'type', 'outcome'] as const,
  registers: [registry],
});

export const graphqlOperationDuration = new Histogram({
  name: 'lumina_graphql_operation_duration_seconds',
  help: 'GraphQL operation latency by name.',
  labelNames: ['operation', 'type'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const subscriptionsActive = new Gauge({
  name: 'lumina_graphql_subscriptions_active',
  help: 'Currently open GraphQL subscriptions.',
  registers: [registry],
});

export const subscriptionsRejected = new Counter({
  name: 'lumina_graphql_subscriptions_rejected_total',
  help: 'Subscriptions refused because the server was at its concurrency ceiling.',
  registers: [registry],
});

export const listenerConnected = new Gauge({
  name: 'lumina_graphql_listener_connected',
  help: 'Whether the Postgres LISTEN connection is currently established (1 or 0).',
  registers: [registry],
});

export const authAttempts = new Counter({
  name: 'lumina_graphql_auth_total',
  help: 'GraphQL requests by presented credential and authentication outcome.',
  labelNames: ['caller', 'outcome'] as const,
  registers: [registry],
});

// Pool saturation is the metric that explains a latency cliff nothing else
// accounts for: queries queue invisibly once every connection is checked out.
export const dbPoolTotal = new Gauge({
  name: 'lumina_db_pool_connections_total',
  help: 'Connections currently held by the pool.',
  registers: [registry],
});

export const dbPoolIdle = new Gauge({
  name: 'lumina_db_pool_connections_idle',
  help: 'Idle connections in the pool.',
  registers: [registry],
});

export const dbPoolWaiting = new Gauge({
  name: 'lumina_db_pool_waiting',
  help: 'Requests queued waiting for a pool connection.',
  registers: [registry],
});

export const dbPoolErrors = new Counter({
  name: 'lumina_graphql_db_pool_errors_total',
  help: 'Unexpected idle PostgreSQL pool client errors.',
  registers: [registry],
});

export const exportRuns = new Counter({
  name: 'lumina_scheduled_exports_total',
  help: 'Scheduled object-storage exports by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const exportRunDuration = new Histogram({
  name: 'lumina_scheduled_export_duration_seconds',
  help: 'Duration of scheduled object-storage exports.',
  buckets: [1, 5, 15, 30, 60, 120, 300, 900],
  registers: [registry],
});

export function metricsContentType(): string {
  return registry.contentType;
}

export function renderMetrics(): Promise<string> {
  return registry.metrics();
}
