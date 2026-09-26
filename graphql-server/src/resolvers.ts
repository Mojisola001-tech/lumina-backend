import type { Pool } from 'pg';
import {
  getAccountFromDb,
  getAccountOperations,
  getAccountTransactions,
  getEventsByContract,
  getLatestLedgerFromDb,
  getLedgerBySequence,
  getOperations,
  getOperationsByTransactionHash,
  getTransactionByHash,
  getTransactions,
  mapAccount,
} from './db';
import { createLoaders, type RequestLoaders } from './loaders';
import { getAccount as getAccountFromHorizon, getLatestLedger as getLatestLedgerFromHorizon } from './horizon';
import { createSubscriptionResolvers } from './subscriptions';
import { getContractSchema, getCustomEvents, type CustomEventFilter } from './customEvents';
import { getAssetDetail } from './assets';
import { getOperationsByAsset, searchTransactions } from './search';
import type { LedgerNotifier } from './pubsub';
import { ANONYMOUS_CALLER, type ApiCaller } from './auth';

export interface BaseContext {
  pool: Pool;
  loaders?: RequestLoaders;
  /** Present for websocket connections; absent for plain HTTP queries. */
  notifier?: LedgerNotifier;
  /**
   * Who this request is attributed to, resolved once by the auth middleware.
   *
   * Websocket connections are not authenticated — they cannot carry a header —
   * so they are always the anonymous caller until that path is built out.
   */
  caller?: ApiCaller;
}

export function createContext(
  pool: Pool,
  extra: Partial<Omit<Context, 'pool' | 'loaders'>> = {}
): Context {
  return { pool, loaders: createLoaders(pool), caller: ANONYMOUS_CALLER, ...extra };
}

/**
 * Lumina GraphQL resolvers — backed by PostgreSQL (populated by indexer/).
 * Horizon is used only as an explicit fallback: an account that hasn't been
 * indexed yet (indexer only writes accounts it's seen activity for), or a
 * fresh database with no ledgers indexed yet.
 */
async function resolveAccount(address: string, pool: Pool, loaders?: RequestLoaders) {
  if (loaders) return loaders.account.load(address);
  const fromDb = await getAccountFromDb(pool, address);
  if (fromDb) return fromDb;

  const horizonAccount = await getAccountFromHorizon(address);
  if (!horizonAccount) return null;
  return mapAccount({
    address: horizonAccount.account_id,
    sequence: horizonAccount.sequence,
    subentry_count: horizonAccount.subentry_count,
    last_modified_ledger: horizonAccount.last_modified_ledger,
    num_sponsored: horizonAccount.num_sponsored,
    num_sponsoring: horizonAccount.num_sponsoring,
    balances: horizonAccount.balances,
    flags: horizonAccount.flags,
    thresholds: horizonAccount.thresholds,
  });
}

export const resolvers = {
  Subscription: createSubscriptionResolvers(),

  Query: {
    async transactions(_: unknown, args: { limit?: number; cursor?: string }, { pool }: Context) {
      const limit = args.limit ?? 20;
      const items = await getTransactions(pool, limit, args.cursor);
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.hash ?? null,
        },
      };
    },

    async transaction(_: unknown, args: { hash: string }, { pool }: Context) {
      return getTransactionByHash(pool, args.hash);
    },

    async account(_: unknown, args: { address: string }, { pool, loaders }: Context) {
      return resolveAccount(args.address, pool, loaders);
    },

    async operations(
      _: unknown,
      args: { account?: string; type?: string; asset?: string; limit?: number; cursor?: string },
      { pool }: Context
    ) {
      const limit = args.limit ?? 20;

      // The asset filter needs its own query: an asset can appear as the
      // payment asset or either side of an offer, which the generic operations
      // query has no notion of.
      const items = args.asset
        ? await getOperationsByAsset(pool, {
            asset: args.asset,
            account: args.account,
            type: args.type,
            limit,
            cursor: args.cursor,
          })
        : await getOperations(pool, { account: args.account, type: args.type, limit, cursor: args.cursor });

      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.id ?? null,
        },
      };
    },

    async search(
      _: unknown,
      args: { query: string; limit?: number; cursor?: string },
      { pool }: Context
    ) {
      const limit = args.limit ?? 20;
      const { items, nextCursor } = await searchTransactions(pool, {
        query: args.query,
        limit,
        cursor: args.cursor,
      });
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          // The search cursor encodes the ranking tuple, not just a row id.
          cursor: nextCursor,
        },
      };
    },

    async events(
      _: unknown,
      args: { contractId: string; topic?: string; limit?: number; cursor?: string },
      { pool }: Context
    ) {
      const limit = args.limit ?? 20;
      const items = await getEventsByContract(pool, { contractId: args.contractId, topic: args.topic, limit, cursor: args.cursor });
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.id ?? null,
        },
      };
    },

    async latestLedger(_: unknown, __: unknown, { pool }: Context) {
      const fromDb = await getLatestLedgerFromDb(pool);
      if (fromDb) return fromDb;

      const horizonLedger = await getLatestLedgerFromHorizon();
      if (!horizonLedger) return null;
      return {
        sequence: horizonLedger.sequence,
        closedAt: horizonLedger.closed_at,
        transactionCount: horizonLedger.successful_transaction_count + horizonLedger.failed_transaction_count,
        operationCount: horizonLedger.operation_count,
        baseFee: 100,
        baseReserve: 5000000,
      };
    },

    async ledger(_: unknown, args: { sequence: number }, { pool }: Context) {
      return getLedgerBySequence(pool, args.sequence);
    },

    async customEvents(
      _: unknown,
      args: { contractId: string; event: string; where?: CustomEventFilter[] | null; limit?: number; cursor?: string },
      { pool }: Context
    ) {
      const limit = args.limit ?? 20;
      const items = await getCustomEvents(pool, {
        contractId: args.contractId,
        event: args.event,
        where: args.where,
        limit,
        cursor: args.cursor,
      });
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.eventId ?? null,
        },
      };
    },

    async contractSchema(_: unknown, args: { contractId: string }, { pool }: Context) {
      const schema = await getContractSchema(pool, args.contractId);
      if (!schema) return null;
      return {
        ...schema,
        events: schema.events.map(event => ({
          ...event,
          fields: event.fields.map(field => ({ ...field, optional: field.optional ?? false })),
        })),
      };
    },

    async asset(
      _: unknown,
      args: { asset: string; from?: string | null; to?: string | null; bucketSeconds?: number | null },
      { pool }: Context
    ) {
      return getAssetDetail(pool, {
        asset: args.asset,
        from: args.from,
        to: args.to,
        bucketSeconds: args.bucketSeconds,
      });
    },
  },

  Account: {
    async transactions(parent: { address: string }, args: { limit?: number }, { pool }: Context) {
      return getAccountTransactions(pool, parent.address, args.limit ?? 10);
    },
    async operations(parent: { address: string }, args: { limit?: number }, { pool }: Context) {
      return getAccountOperations(pool, parent.address, args.limit ?? 10);
    },
  },

  Transaction: {
    async ledgerData(parent: { ledger: number }, _: unknown, { pool, loaders }: Context) {
      return loaders ? loaders.ledger.load(parent.ledger) : getLedgerBySequence(pool, parent.ledger);
    },
    async account(parent: { sourceAccount: string }, _: unknown, { pool, loaders }: Context) {
      return resolveAccount(parent.sourceAccount, pool, loaders);
    },
    async operations(parent: { hash: string }, _: unknown, { pool, loaders }: Context) {
      return loaders ? loaders.operationsByTransactionHash.load(parent.hash) : getOperationsByTransactionHash(pool, parent.hash);
    },
  },

  Operation: {
    async transaction(parent: { transactionHash: string }, _: unknown, { pool, loaders }: Context) {
      return loaders ? loaders.transaction.load(parent.transactionHash) : getTransactionByHash(pool, parent.transactionHash);
    },
    async account(parent: { sourceAccount: string }, _: unknown, { pool, loaders }: Context) {
      return resolveAccount(parent.sourceAccount, pool, loaders);
    },
  },
};
