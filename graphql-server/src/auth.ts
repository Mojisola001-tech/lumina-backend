/**
 * API key authentication — the one place a request's identity is decided.
 *
 * The middleware reads a key from a header, resolves it against `api_keys`, and
 * hands the resulting caller to the GraphQL context. Everything that comes after
 * this — per-key rate limits, quotas, audit — reads that caller instead of the
 * key, so a request either has an identity or never reached a resolver at all.
 *
 * Three properties are load-bearing, and the tests exist to hold them:
 *
 * - **The key is never logged and never echoed.** It is read, hashed, compared
 *   and dropped. Error messages name the failure, not the value, so a client
 *   that pastes its key into a support ticket does not leak it into a response
 *   body, a log aggregator or a screenshot.
 * - **The comparison is constant-time.** See `digestsMatch` for what that does
 *   and does not buy; the short version is that the accept/reject decision must
 *   not depend on how many leading characters of a digest agreed.
 * - **Anonymous access is the default, and stays configurable.** On the day this
 *   lands every existing client is anonymous, and none of them may break.
 *   `ALLOW_ANONYMOUS_ACCESS=false` is the switch that makes keys mandatory.
 */
import crypto from 'crypto';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { findApiKeyByHash, hashApiKey } from './keys';
import { subsystem } from './logger';
import { authAttempts } from './metrics';

const log = subsystem('auth');

/**
 * The logging surface this module needs.
 *
 * Injectable so the "the key is never logged" tests can assert against the
 * exact fields handed to the logger. Capturing `process.stdout` instead would
 * look equivalent and prove nothing: pino writes to fd 1 directly, so a stdout
 * capture sees an empty string and every such assertion passes vacuously.
 */
export type AuthLog = Pick<ReturnType<typeof subsystem>, 'info' | 'warn' | 'error'>;

/**
 * Header the key is read from. Matches a name `errorTracking` already redacts,
 * so a key cannot reach Sentry in plaintext either.
 */
export const DEFAULT_API_KEY_HEADER = 'x-api-key';

/**
 * Who a request is attributed to.
 *
 * Flat rather than a discriminated union: the consumers that matter (rate
 * limits, quotas, audit) all want to read `rateLimit` and branch on `kind`, and
 * a union would make each of them narrow before it could. `null` means "not
 * applicable to this caller" — an anonymous request has no key id and, until
 * anonymous access is turned off, no per-key budget either.
 */
export interface ApiCaller {
  kind: 'api-key' | 'anonymous';
  /** `api_keys.id`; null for an anonymous caller. */
  keyId: number | null;
  /** Human-readable name for logs and audit — a key's label, or "anonymous". */
  label: string;
  /** Requests per minute this caller is allowed, or null when unthrottled. */
  rateLimit: number | null;
}

/** The identity of a request that presented no key. */
export const ANONYMOUS_CALLER: ApiCaller = Object.freeze({
  kind: 'anonymous',
  keyId: null,
  label: 'anonymous',
  rateLimit: null,
});

/**
 * One message for every credential failure, whether the key was never issued or
 * has since been revoked. Distinguishing them would turn the 401 into an oracle:
 * an attacker could confirm that a guessed key is real-but-revoked, which is
 * exactly the fact a leaked-and-cut-off key's holder must not be able to probe.
 * The operator still gets the distinction — it is in the `reason` field, the
 * log line and the metric label. Only the client-facing text is shared.
 */
const AUTH_FAILED_MESSAGE = 'Invalid or revoked API key.';

/** Why a request was refused, for logs and metrics rather than for the client. */
export type AuthFailureReason = 'missing' | 'invalid' | 'revoked' | 'hash-mismatch';

/** A request that could not be attributed to a caller. Always a 401. */
export class ApiKeyError extends Error {
  readonly status = 401;
  readonly reason: AuthFailureReason;

  constructor(message: string, reason: AuthFailureReason) {
    super(message);
    this.name = 'ApiKeyError';
    this.reason = reason;
  }
}

/**
 * Compare two digests in constant time.
 *
 * The honest version of the claim: the digest is not the secret, so this is a
 * second line of defence rather than the primary protection — SHA-256
 * preimage-resistance is what actually keeps a leaked `api_keys` table from
 * yielding usable keys. What it does buy is that the accept/reject decision no
 * longer depends on *where* two values first differ, so a partially matching or
 * hand-edited row cannot be turned into a byte-at-a-time oracle, and the
 * property survives a future move to a weaker digest.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length
 * check comes first. Returning early on it leaks nothing here: both sides are
 * SHA-256 hex and therefore the same length by construction, so the branch is
 * unreachable for well-formed input and exists only for a corrupt row.
 */
export function digestsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Read `ALLOW_ANONYMOUS_ACCESS`.
 *
 * Unset means anonymous, because that is the state the API is in today and
 * nothing about this change should alter it until an operator opts in.
 *
 * An unrecognised value resolves to **false** rather than to `true`. A typo in a
 * security switch must not leave the API open to the public — the operator
 * meant to restrict access, and failing closed turns a silent misconfiguration
 * into a loud refusal they cannot miss.
 */
export function parseAllowAnonymous(raw: string | undefined, logger: AuthLog = log): boolean {
  if (raw === undefined || raw.trim() === '') return true;

  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;

  logger.error(
    { configured: raw },
    'ALLOW_ANONYMOUS_ACCESS is not a recognised boolean; refusing anonymous access'
  );
  return false;
}

export interface ResolveCallerOptions {
  allowAnonymous: boolean;
  /** Used only to name the header in the "no key" error. */
  headerName?: string;
  /** Defaults to the server's `auth` subsystem logger. */
  log?: AuthLog;
}

/**
 * Resolve a presented key into a caller identity.
 *
 * Throws `ApiKeyError` when a key is required and unusable; returns the
 * anonymous caller when a key is absent and that is allowed.
 */
export async function resolveCaller(
  pool: Pool,
  presentedKey: string | undefined,
  options: ResolveCallerOptions
): Promise<ApiCaller> {
  const logger = options.log ?? log;
  const key = presentedKey?.trim();

  if (!key) {
    if (options.allowAnonymous) {
      authAttempts.inc({ caller: 'anonymous', outcome: 'resolved' });
      return ANONYMOUS_CALLER;
    }
    authAttempts.inc({ caller: 'anonymous', outcome: 'rejected' });
    const header = options.headerName ?? DEFAULT_API_KEY_HEADER;
    throw new ApiKeyError(`An API key is required. Send one in the \`${header}\` header.`, 'missing');
  }

  const digest = hashApiKey(key);
  const record = await findApiKeyByHash(pool, digest);

  if (!record) {
    authAttempts.inc({ caller: 'api-key', outcome: 'rejected' });
    // No key id to name, and nothing derived from the presented value may be
    // logged — that value is the secret.
    logger.warn('rejected an API key that matches no record');
    throw new ApiKeyError(AUTH_FAILED_MESSAGE, 'invalid');
  }

  // The lookup above is an index probe, not a constant-time comparison, so the
  // stored digest is re-checked in constant time before the row is trusted.
  if (!digestsMatch(record.keyHash, digest)) {
    authAttempts.inc({ caller: 'api-key', outcome: 'rejected' });
    logger.error(
      { keyId: record.id },
      'api_keys row returned for a digest that does not match it; refusing the caller'
    );
    throw new ApiKeyError(AUTH_FAILED_MESSAGE, 'hash-mismatch');
  }

  if (record.revokedAt) {
    authAttempts.inc({ caller: 'api-key', outcome: 'revoked' });
    // keyId and label are stored metadata, not secrets — safe to name here, and
    // the only way an operator learns *which* key is still being presented.
    logger.warn(
      { keyId: record.id, label: record.label, revokedAt: record.revokedAt },
      'rejected a revoked API key'
    );
    throw new ApiKeyError(AUTH_FAILED_MESSAGE, 'revoked');
  }

  authAttempts.inc({ caller: 'api-key', outcome: 'resolved' });
  logger.info(
    { keyId: record.id, label: record.label, rateLimit: record.rateLimit },
    'resolved API key to caller'
  );

  return {
    kind: 'api-key',
    keyId: record.id,
    label: record.label,
    rateLimit: record.rateLimit,
  };
}

/**
 * Where the resolved caller waits between the auth middleware and the GraphQL
 * context.
 *
 * A module-private symbol rather than a plain string key: it cannot collide with
 * anything a client controls or with another middleware's `res.locals` entry,
 * and it keeps the property off `Request`/`Response` without a global
 * augmentation that every other file would inherit.
 */
export const CALLER_LOCALS_KEY = Symbol('lumina.apiCaller');

type CallerLocals = { [CALLER_LOCALS_KEY]?: ApiCaller };

/** Read the caller the auth middleware attached, if it ran. */
export function callerFromLocals(locals: object): ApiCaller | undefined {
  return (locals as CallerLocals)[CALLER_LOCALS_KEY];
}

export interface ApiKeyAuthOptions {
  pool: Pool;
  allowAnonymous: boolean;
  /** Defaults to `x-api-key`. */
  headerName?: string;
  /** Defaults to the server's `auth` subsystem logger. */
  log?: AuthLog;
}

/**
 * Express middleware that authenticates a request and publishes its caller.
 *
 * On success it calls `next()` with the caller in `res.locals`; on a credential
 * failure it answers 401 itself and never calls `next()`, so a request with an
 * unusable key cannot reach a resolver even once.
 */
export function apiKeyAuthMiddleware(options: ApiKeyAuthOptions): RequestHandler {
  const headerName = options.headerName ?? DEFAULT_API_KEY_HEADER;
  const logger = options.log ?? log;

  return (req, res, next) => {
    resolveCaller(options.pool, req.get(headerName), {
      allowAnonymous: options.allowAnonymous,
      headerName,
      log: logger,
    })
      .then(caller => {
        (res.locals as CallerLocals)[CALLER_LOCALS_KEY] = caller;
        next();
      })
      .catch((err: unknown) => {
        if (!(err instanceof ApiKeyError)) return next(err);

        logger.warn({ reason: err.reason, header: headerName }, 'refused an unauthenticated request');
        res.status(err.status).json({
          errors: [
            {
              message: err.message,
              // Uniform code: a client branches on this, not on prose, and the
              // per-reason detail stays in the log where it is safe to be specific.
              extensions: { code: 'UNAUTHENTICATED' },
            },
          ],
        });
      });
  };
}
