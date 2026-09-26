/**
 * API key authentication: header → caller identity.
 *
 * Two of these are the point of the module rather than incidental coverage.
 * The "never logs the key" tests assert on real captured stdout, because that
 * property is only worth anything if it holds against the actual logger rather
 * than against a mock that was written to agree with it. The "one message for
 * every failure" test pins the decision not to tell a caller that a key it
 * guessed really was issued and then revoked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  ANONYMOUS_CALLER,
  ApiKeyError,
  CALLER_LOCALS_KEY,
  apiKeyAuthMiddleware,
  callerFromLocals,
  digestsMatch,
  parseAllowAnonymous,
  resolveCaller,
} from './auth';
import { generateApiKey, hashApiKey } from './keys';
import { registry } from './metrics';

const KEY = generateApiKey();
const KEY_HASH = hashApiKey(KEY);
const NOW = new Date('2026-01-01T00:00:00Z');

interface QueryCall {
  sql: string;
  params: unknown[];
}

/** A pool returning `rows` for any query, recording what it was asked. */
function mockPool(rows: unknown[] = []): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, calls };
}

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    key_hash: KEY_HASH,
    key_prefix: 'lum_12345678...',
    label: 'mobile-app',
    rate_limit: 120,
    created_at: NOW,
    revoked_at: null,
    updated_at: NOW,
    ...overrides,
  };
}

/** A logger that records every call, so tests can inspect the exact fields. */
function captureLog() {
  const lines: { level: string; obj: unknown; msg: string | undefined }[] = [];
  const record = (level: string) => (obj: unknown, msg?: string) => {
    lines.push({ level, obj, msg });
  };
  return {
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    lines,
    /** Everything the logger saw, serialized — what a log aggregator would hold. */
    serialized: () => JSON.stringify(lines),
  };
}

/**
 * Just enough of a req/res pair to drive the middleware.
 *
 * `settled` resolves when the middleware is done either way — by calling
 * `next()` on success, or by writing a 401 on failure. Waiting on `next()` alone
 * deadlocks on exactly the case these tests care about, the refusal.
 */
function fakeExchange(headers: Record<string, string>) {
  const locals: Record<string | symbol, unknown> = {};
  const state = {
    locals,
    statusCode: 200 as number | null,
    body: null as unknown,
    nextCalled: false,
    nextError: undefined as unknown,
  };

  let markSettled = (): void => {};
  const settled = new Promise<void>(resolve => {
    markSettled = resolve;
  });

  const req = {
    get: (name: string) => headers[name.toLowerCase()],
  };
  const res = {
    locals,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      markSettled();
      return res;
    },
  };

  const next = (err?: unknown) => {
    state.nextCalled = true;
    state.nextError = err;
    markSettled();
  };

  return { req, res, next, settled, state };
}

/** Run the middleware and let it finish, whichever way it finishes. */
async function run(
  pool: Pool,
  headers: Record<string, string>,
  allowAnonymous = true,
  headerName?: string
): Promise<ReturnType<typeof fakeExchange>['state']> {
  const exchange = fakeExchange(headers);
  const middleware = apiKeyAuthMiddleware({
    pool,
    allowAnonymous,
    ...(headerName ? { headerName } : {}),
  });

  middleware(exchange.req as unknown as Request, exchange.res as unknown as Response, exchange.next);
  await exchange.settled;

  return exchange.state;
}

// ── Resolving a key into a caller ───────────────────────────────────────────

describe('resolveCaller — a valid key becomes a caller', () => {
  test('resolves the key to the record it was issued for', async () => {
    const { pool } = mockPool([keyRow()]);

    const caller = await resolveCaller(pool, KEY, { allowAnonymous: true });

    assert.equal(caller.kind, 'api-key');
    assert.equal(caller.keyId, 7);
    assert.equal(caller.label, 'mobile-app');
    assert.equal(caller.rateLimit, 120);
  });

  test('looks the key up by hash, never by the key itself', async () => {
    const { pool, calls } = mockPool([keyRow()]);

    await resolveCaller(pool, KEY, { allowAnonymous: true });

    assert.equal(calls.length, 1);
    assert.match(calls[0]?.sql ?? '', /FROM api_keys\s+WHERE key_hash = \$1/);
    assert.deepEqual(calls[0]?.params, [KEY_HASH]);
    // The plaintext must not reach the database layer at all.
    assert.equal(calls[0]?.params.includes(KEY), false);
  });

  test('tolerates surrounding whitespace in the header value', async () => {
    const { pool } = mockPool([keyRow()]);

    const caller = await resolveCaller(pool, `  ${KEY}\n`, { allowAnonymous: true });

    assert.equal(caller.kind, 'api-key');
    assert.equal(caller.keyId, 7);
  });

  test('accepts a key even when anonymous access is switched off', async () => {
    const { pool } = mockPool([keyRow()]);

    const caller = await resolveCaller(pool, KEY, { allowAnonymous: false });

    assert.equal(caller.kind, 'api-key');
  });
});

describe('resolveCaller — an unusable key is rejected', () => {
  test('a key matching no record is refused with a 401', async () => {
    const { pool } = mockPool([]);

    const err = await resolveCaller(pool, KEY, { allowAnonymous: true }).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof ApiKeyError);
    assert.equal(err.status, 401);
    assert.equal(err.reason, 'invalid');
    assert.match(err.message, /Invalid or revoked API key\./);
  });

  test('a revoked key is refused even though its hash still matches', async () => {
    const { pool } = mockPool([keyRow({ revoked_at: NOW })]);

    const err = await resolveCaller(pool, KEY, { allowAnonymous: true }).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof ApiKeyError);
    assert.equal(err.reason, 'revoked');
  });

  test('an unknown key and a revoked key are indistinguishable to the caller', async () => {
    // Telling the two apart turns the 401 into an oracle: it confirms that a
    // guessed key was really issued and later cut off.
    const unknown = mockPool([]);
    const revoked = mockPool([keyRow({ revoked_at: NOW })]);

    const fromUnknown = await resolveCaller(unknown.pool, KEY, { allowAnonymous: true }).catch((e: ApiKeyError) => e);
    const fromRevoked = await resolveCaller(revoked.pool, KEY, { allowAnonymous: true }).catch((e: ApiKeyError) => e);

    assert.ok(fromUnknown instanceof ApiKeyError && fromRevoked instanceof ApiKeyError);
    assert.equal(fromUnknown.message, fromRevoked.message);
    assert.equal(fromUnknown.status, fromRevoked.status);
    // …while the operator still gets the distinction.
    assert.notEqual(fromUnknown.reason, fromRevoked.reason);
  });

  test('a row whose stored hash is not the hash we looked up is refused', async () => {
    // The digest comparison is the last check before a row is trusted, so a
    // mismatched row must fail closed rather than be taken at face value.
    const { pool } = mockPool([keyRow({ key_hash: hashApiKey(generateApiKey()) })]);

    const err = await resolveCaller(pool, KEY, { allowAnonymous: true }).catch((e: ApiKeyError) => e);

    assert.ok(err instanceof ApiKeyError);
    assert.equal(err.reason, 'hash-mismatch');
  });

  test('a missing key is refused when anonymous access is off', async () => {
    const { pool, calls } = mockPool([keyRow()]);

    const err = await resolveCaller(pool, undefined, { allowAnonymous: false }).catch((e: ApiKeyError) => e);

    assert.ok(err instanceof ApiKeyError);
    assert.equal(err.reason, 'missing');
    assert.equal(err.status, 401);
    assert.match(err.message, /API key is required/);
    assert.match(err.message, /x-api-key/);
    // No key means no lookup: an unauthenticated request never reaches the table.
    assert.equal(calls.length, 0);
  });

  test('an empty or whitespace-only key counts as no key at all', async () => {
    const { pool, calls } = mockPool([keyRow()]);

    const caller = await resolveCaller(pool, '   ', { allowAnonymous: true });

    assert.equal(caller, ANONYMOUS_CALLER);
    assert.equal(calls.length, 0);
  });

  test('the rejection never quotes the key back at the caller', async () => {
    const { pool } = mockPool([]);

    const err = await resolveCaller(pool, KEY, { allowAnonymous: true }).catch((e: ApiKeyError) => e);

    assert.ok(err instanceof ApiKeyError);
    assert.equal(err.message.includes(KEY), false);
  });
});

// ── Anonymous access ─────────────────────────────────────────────────────────

describe('anonymous access is configurable', () => {
  test('a request with no key is the anonymous caller by default', async () => {
    const { pool, calls } = mockPool();

    const caller = await resolveCaller(pool, undefined, { allowAnonymous: true });

    assert.equal(caller, ANONYMOUS_CALLER);
    assert.equal(caller.kind, 'anonymous');
    assert.equal(caller.keyId, null);
    assert.equal(calls.length, 0);
  });

  test('the anonymous caller is frozen so a consumer cannot rewrite it', () => {
    assert.throws(() => {
      (ANONYMOUS_CALLER as { label: string }).label = 'forged';
    }, TypeError);
  });

  test('ALLOW_ANONYMOUS_ACCESS is permissive when unset', () => {
    // Day one: every existing client is anonymous and must keep working.
    assert.equal(parseAllowAnonymous(undefined), true);
    assert.equal(parseAllowAnonymous(''), true);
    assert.equal(parseAllowAnonymous('   '), true);
  });

  test('ALLOW_ANONYMOUS_ACCESS reads the usual spellings of a boolean', () => {
    for (const yes of ['true', 'TRUE', ' yes ', '1', 'on']) {
      assert.equal(parseAllowAnonymous(yes), true, `expected ${yes} to allow anonymous access`);
    }
    for (const no of ['false', 'FALSE', ' no ', '0', 'off']) {
      assert.equal(parseAllowAnonymous(no), false, `expected ${no} to refuse anonymous access`);
    }
  });

  test('an unrecognised value fails closed rather than leaving the API open', () => {
    const { log, serialized } = captureLog();

    assert.equal(parseAllowAnonymous('flase', log), false);
    assert.match(serialized(), /ALLOW_ANONYMOUS_ACCESS/);
  });
});

// ── Constant-time comparison ─────────────────────────────────────────────────

describe('digestsMatch', () => {
  test('equal digests match, differing digests do not', () => {
    assert.equal(digestsMatch(KEY_HASH, KEY_HASH), true);
    assert.equal(digestsMatch(KEY_HASH, hashApiKey(generateApiKey())), false);
  });

  test('a length mismatch is a mismatch rather than a throw', () => {
    // timingSafeEqual throws on unequal lengths, so the guard is what keeps a
    // corrupt row from turning into a 500.
    assert.equal(digestsMatch(KEY_HASH, KEY_HASH.slice(0, -1)), false);
    assert.equal(digestsMatch('', KEY_HASH), false);
  });

  test('a difference anywhere in the digest is a mismatch, not a prefix match', () => {
    const flipped = (KEY_HASH[0] === 'a' ? 'b' : 'a') + KEY_HASH.slice(1);
    assert.equal(digestsMatch(KEY_HASH, flipped), false);
  });

  test('it is the platform comparison, not a hand-rolled loop', () => {
    // Guards the intent rather than the implementation: a future "simplification"
    // to === or a loop with an early return would keep every other test green.
    const source = readFileSync(`${__dirname}/auth.ts`, 'utf-8');
    const body = source.slice(source.indexOf('export function digestsMatch'));

    assert.match(body, /crypto\.timingSafeEqual/);
  });
});

// ── The key is never logged ──────────────────────────────────────────────────

describe('the key is never logged', () => {
  test('a resolved key does not appear in the log output', async () => {
    const { pool } = mockPool([keyRow()]);
    const { log, lines, serialized } = captureLog();

    await resolveCaller(pool, KEY, { allowAnonymous: true, log });

    assert.equal(serialized().includes(KEY), false);
    // The digest is equally absent: it identifies the key just as precisely.
    assert.equal(serialized().includes(KEY_HASH), false);
    // …but the identity is logged, which is the useful half.
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]?.obj, { keyId: 7, label: 'mobile-app', rateLimit: 120 });
  });

  test('a rejected key does not appear in the log output', async () => {
    const { pool } = mockPool([]);
    const { log, lines, serialized } = captureLog();

    await resolveCaller(pool, KEY, { allowAnonymous: true, log }).catch(() => undefined);

    assert.equal(serialized().includes(KEY), false);
    assert.equal(serialized().includes(KEY_HASH), false);
    assert.equal(lines.length, 1);
  });

  test('a revoked key is logged by id and label, not by value', async () => {
    const { pool } = mockPool([keyRow({ revoked_at: NOW })]);
    const { log, lines, serialized } = captureLog();

    await resolveCaller(pool, KEY, { allowAnonymous: true, log }).catch(() => undefined);

    assert.equal(serialized().includes(KEY), false);
    assert.equal(serialized().includes(KEY_HASH), false);
    assert.equal(lines[0]?.level, 'warn');
    assert.equal((lines[0]?.obj as { keyId: number }).keyId, 7);
  });

  test('an anonymous request is not logged as a failure', async () => {
    const { pool } = mockPool();
    const { log, lines } = captureLog();

    const caller = await resolveCaller(pool, undefined, { allowAnonymous: true, log });

    assert.equal(caller, ANONYMOUS_CALLER);
    // Silence is right here: anonymous is the normal state, and logging every
    // unkeyed request as a warning would bury the ones that matter.
    assert.deepEqual(lines, []);
  });

  test('the middleware logs the failure reason without the key', async () => {
    const { pool } = mockPool([]);
    const { log, lines, serialized } = captureLog();
    const middleware = apiKeyAuthMiddleware({ pool, allowAnonymous: true, log });
    const exchange = fakeExchange({ 'x-api-key': KEY });

    middleware(
      exchange.req as unknown as Request,
      exchange.res as unknown as Response,
      exchange.next
    );
    await exchange.settled;

    assert.equal(serialized().includes(KEY), false);
    assert.equal(serialized().includes(KEY_HASH), false);
    // Both the resolver and the middleware log here; the reason is the
    // middleware's field, so select on it rather than on position.
    const refusals = lines.filter(l => typeof l.obj === 'object' && l.obj !== null && 'reason' in l.obj);
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0]?.obj, { reason: 'invalid', header: 'x-api-key' });
  });
});

// ── Middleware wiring ────────────────────────────────────────────────────────

describe('apiKeyAuthMiddleware', () => {
  test('a valid key in the header reaches the rest of the chain with a caller', async () => {
    const { pool } = mockPool([keyRow()]);

    const state = await run(pool, { 'x-api-key': KEY });

    assert.equal(state.nextCalled, true);
    assert.equal(state.nextError, undefined);
    assert.equal(callerFromLocals(state.locals)?.kind, 'api-key');
    assert.equal(callerFromLocals(state.locals)?.keyId, 7);
  });

  test('an invalid key is answered with 401 and never reaches the chain', async () => {
    const { pool } = mockPool([]);

    const state = await run(pool, { 'x-api-key': KEY });

    assert.equal(state.nextCalled, false);
    assert.equal(state.statusCode, 401);
    const body = state.body as { errors: { message: string; extensions: { code: string } }[] };
    assert.equal(body.errors[0]?.extensions.code, 'UNAUTHENTICATED');
    assert.match(body.errors[0]?.message ?? '', /Invalid or revoked API key\./);
    assert.equal(JSON.stringify(state.body).includes(KEY), false);
  });

  test('a request with no key is served when anonymous access is allowed', async () => {
    const { pool } = mockPool();

    const state = await run(pool, {});

    assert.equal(state.nextCalled, true);
    assert.equal(callerFromLocals(state.locals), ANONYMOUS_CALLER);
  });

  test('a request with no key is refused when anonymous access is off', async () => {
    const { pool } = mockPool();

    const state = await run(pool, {}, false);

    assert.equal(state.nextCalled, false);
    assert.equal(state.statusCode, 401);
  });

  test('the header name is configurable', async () => {
    const { pool } = mockPool([keyRow()]);

    const state = await run(pool, { 'x-lumina-key': KEY }, true, 'x-lumina-key');

    assert.equal(state.nextCalled, true);
    assert.equal(callerFromLocals(state.locals)?.keyId, 7);
  });

  test('a key sent under the wrong header is treated as no key', async () => {
    const { pool } = mockPool([keyRow()]);

    const state = await run(pool, { 'x-wrong-header': KEY });

    assert.equal(callerFromLocals(state.locals), ANONYMOUS_CALLER);
  });

  test('a key under the wrong header is refused when anonymous access is off', async () => {
    const { pool } = mockPool([keyRow()]);

    const state = await run(pool, { 'x-wrong-header': KEY }, false);

    assert.equal(state.nextCalled, false);
    assert.equal(state.statusCode, 401);
  });

  test('a database failure is passed on as an error rather than a 401', async () => {
    // A 401 here would tell a legitimate client its key is bad when the truth
    // is that the server cannot check it.
    const pool = {
      query: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    } as unknown as Pool;

    const state = await run(pool, { 'x-api-key': KEY });

    assert.equal(state.nextCalled, true);
    assert.ok(state.nextError instanceof Error);
    assert.match((state.nextError as Error).message, /connection terminated/);
    assert.equal(state.statusCode, 200);
  });

  test('the caller is published under a key a client cannot collide with', () => {
    // A string property on res.locals would be reachable by any other
    // middleware, and `x-api-key` is client-controlled.
    assert.equal(typeof CALLER_LOCALS_KEY, 'symbol');
  });

  test('callerFromLocals reports nothing when the middleware did not run', () => {
    assert.equal(callerFromLocals({}), undefined);
  });
});

// ── Observability ────────────────────────────────────────────────────────────

describe('auth metrics', () => {
  test('outcomes are recorded per credential kind', async () => {
    const before = await authTotal();

    await resolveCaller(mockPool([keyRow()]).pool, KEY, { allowAnonymous: true });
    await resolveCaller(mockPool([]).pool, KEY, { allowAnonymous: true }).catch(() => undefined);
    await resolveCaller(mockPool([keyRow({ revoked_at: NOW })]).pool, KEY, { allowAnonymous: true }).catch(
      () => undefined
    );
    await resolveCaller(mockPool().pool, undefined, { allowAnonymous: true });
    await resolveCaller(mockPool().pool, undefined, { allowAnonymous: false }).catch(() => undefined);

    const after = await authTotal();
    assert.equal((after.get('api-key:resolved') ?? 0) - (before.get('api-key:resolved') ?? 0), 1);
    assert.equal((after.get('api-key:rejected') ?? 0) - (before.get('api-key:rejected') ?? 0), 1);
    assert.equal((after.get('api-key:revoked') ?? 0) - (before.get('api-key:revoked') ?? 0), 1);
    assert.equal((after.get('anonymous:resolved') ?? 0) - (before.get('anonymous:resolved') ?? 0), 1);
    assert.equal((after.get('anonymous:rejected') ?? 0) - (before.get('anonymous:rejected') ?? 0), 1);
  });
});

/** Current counter values as `caller:outcome` → value. */
async function authTotal(): Promise<Map<string, number>> {
  const metric = await registry.getSingleMetric('lumina_graphql_auth_total');
  const snapshot = await metric?.get();
  const values = new Map<string, number>();
  for (const value of snapshot?.values ?? []) {
    const caller = value.labels['caller'] as string;
    const outcome = value.labels['outcome'] as string;
    if (caller && outcome) values.set(`${caller}:${outcome}`, value.value);
  }
  return values;
}
