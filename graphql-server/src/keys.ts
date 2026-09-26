import crypto from 'crypto';
import { Pool } from 'pg';

export interface ApiKeyRecord {
  id: number;
  keyHash: string;
  keyPrefix: string;
  label: string;
  rateLimit: number;
  createdAt: Date;
  revokedAt: Date | null;
  updatedAt: Date;
}

export interface CreatedApiKey extends ApiKeyRecord {
  plaintextKey: string;
}

/**
 * Generates a cryptographically secure API key with the "lum_" prefix.
 * 32 bytes (256 bits) of randomness formatted as hex.
 */
export function generateApiKey(): string {
  const token = crypto.randomBytes(32).toString('hex');
  return `lum_${token}`;
}

/**
 * Computes the deterministic SHA-256 hash of an API key for secure storage and comparison.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key.trim()).digest('hex');
}

/**
 * Derives a human-friendly prefix from a plaintext key or key hash for display in CLI listings.
 */
export function deriveKeyPrefix(plaintextKey: string): string {
  // e.g. "lum_a1b2c3d4..."
  return plaintextKey.slice(0, 12) + '...';
}

/**
 * Map raw database row to typed ApiKeyRecord.
 */
function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: Number(row.id),
    keyHash: String(row.key_hash),
    keyPrefix: String(row.key_prefix),
    label: String(row.label),
    rateLimit: Number(row.rate_limit),
    createdAt: new Date(row.created_at as string | number | Date),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string | number | Date) : null,
    updatedAt: new Date(row.updated_at as string | number | Date),
  };
}

/**
 * Create a new API key.
 * The plaintext key is returned in the result and must be displayed immediately,
 * because only its cryptographic hash is stored in the database.
 */
export async function createApiKey(
  pool: Pool,
  label: string,
  rateLimit: number = 60
): Promise<CreatedApiKey> {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    throw new Error('API key label cannot be empty');
  }
  if (!Number.isInteger(rateLimit) || rateLimit <= 0) {
    throw new Error(`Rate limit must be a positive integer, got: ${rateLimit}`);
  }

  const plaintextKey = generateApiKey();
  const keyHash = hashApiKey(plaintextKey);
  const keyPrefix = deriveKeyPrefix(plaintextKey);

  const query = `
    INSERT INTO api_keys (key_hash, key_prefix, label, rate_limit, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
  `;

  const res = await pool.query(query, [keyHash, keyPrefix, trimmedLabel, rateLimit]);
  const record = mapApiKeyRow(res.rows[0]);

  return {
    ...record,
    plaintextKey,
  };
}

/**
 * List all API keys in the database ordered by creation date descending.
 * Does NOT contain plaintext keys (as they are not stored).
 */
export async function listApiKeys(pool: Pool): Promise<ApiKeyRecord[]> {
  const query = `
    SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    FROM api_keys
    ORDER BY created_at DESC, id DESC
  `;
  const res = await pool.query(query);
  return res.rows.map(mapApiKeyRow);
}

/**
 * Retrieve metadata for a single key by ID or hash.
 */
export async function getApiKey(
  pool: Pool,
  identifier: number | string
): Promise<ApiKeyRecord | null> {
  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const query = isNumeric
    ? `
      SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
      FROM api_keys
      WHERE id = $1
    `
    : `
      SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
      FROM api_keys
      WHERE key_hash = $1
    `;

  const res = await pool.query(query, [identifier]);
  if (res.rows.length === 0) return null;
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Retrieve a key by its hash, and only by its hash.
 *
 * Deliberately distinct from `getApiKey`, which infers id-versus-hash from the
 * shape of its argument. That inference is fine for a human typing a CLI
 * argument, but the request path already knows it holds a digest and must not
 * have it second-guessed: a SHA-256 hash is hex and could in principle be all
 * digits, in which case the guess would silently look up an id and miss.
 */
export async function findApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKeyRecord | null> {
  const query = `
    SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    FROM api_keys
    WHERE key_hash = $1
  `;

  const res = await pool.query(query, [keyHash]);
  if (res.rows.length === 0) return null;
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Revoke an API key by setting its revoked_at timestamp.
 */
export async function revokeApiKey(
  pool: Pool,
  identifier: number | string
): Promise<ApiKeyRecord> {
  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const query = isNumeric
    ? `
      UPDATE api_keys
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `
    : `
      UPDATE api_keys
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE key_hash = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `;

  const res = await pool.query(query, [identifier]);
  if (res.rows.length === 0) {
    throw new Error(`API key not found: ${identifier}`);
  }
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Set a new rate limit (requests per minute) for an API key.
 */
export async function setApiKeyLimit(
  pool: Pool,
  identifier: number | string,
  newLimit: number
): Promise<ApiKeyRecord> {
  if (!Number.isInteger(newLimit) || newLimit <= 0) {
    throw new Error(`Rate limit must be a positive integer, got: ${newLimit}`);
  }

  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const query = isNumeric
    ? `
      UPDATE api_keys
      SET rate_limit = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `
    : `
      UPDATE api_keys
      SET rate_limit = $2, updated_at = NOW()
      WHERE key_hash = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `;

  const res = await pool.query(query, [identifier, newLimit]);
  if (res.rows.length === 0) {
    throw new Error(`API key not found: ${identifier}`);
  }
  return mapApiKeyRow(res.rows[0]);
}

export async function setApiKeyExportPermission(pool: Pool, identifier: number | string, enabled: boolean): Promise<void> {
  const numeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const result = numeric
    ? await pool.query('UPDATE api_keys SET export_enabled = $2, updated_at = NOW() WHERE id = $1', [identifier, enabled])
    : await pool.query('UPDATE api_keys SET export_enabled = $2, updated_at = NOW() WHERE key_hash = $1', [identifier, enabled]);
  if (result.rowCount !== 1) throw new Error(`API key not found: ${identifier}`);
}
