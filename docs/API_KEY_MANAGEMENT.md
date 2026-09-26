# API Key Management CLI

This CLI enables operators to manage API keys for the Lumina GraphQL server without writing raw SQL.

## Using a key

Keys are read from the `x-api-key` header on HTTP requests to `/graphql`:

```bash
curl -H "x-api-key: lum_abc123…" http://localhost:4000/graphql \
  -d '{"query":"{ latestLedger { sequence } }"}'
```

The server resolves the key to a **caller** — id, label, and rate limit — and
attaches it to the GraphQL context. Every request without a key is served as an
anonymous caller, so existing clients are unaffected. To require a key:

```bash
ALLOW_ANONYMOUS_ACCESS=false
```

An unrecognised value is treated as `false`: a typo in a security switch must not
leave the API open. The header name is configurable with `API_KEY_HEADER`.

A key that is unknown, revoked, or missing while anonymous access is disabled is
refused with HTTP 401 and a GraphQL-shaped body:

```json
{
  "errors": [
    {
      "message": "Invalid or revoked API key.",
      "extensions": { "code": "UNAUTHENTICATED" }
    }
  ]
}
```

Unknown and revoked deliberately share one message — telling them apart would
confirm that a guessed key really was issued and then cut off. The distinction is
in the server log and in `lumina_graphql_auth_total{caller,outcome}` instead.

Keys are never logged and never echoed back in a response.

## Security Model

- **No Plaintext Storage**: Plaintext keys are generated with 256 bits of cryptographically secure entropy (`crypto.randomBytes(32)`), formatted with a `lum_` prefix. Only their SHA-256 hash is written to the `api_keys` table.
- **Printed Once**: A newly created key is displayed exactly once in terminal output upon creation.
- **Irrecoverable**: When an operator queries an existing key (via `list` or `show`), the CLI will refuse to show the plaintext key because only the hash is retained in the database.
- **Never Logged**: The GraphQL server reads a key, hashes it, compares the hash and discards the key. No log line, metric label or error body contains the key or its hash.
- **Constant-Time Comparison**: The stored hash is re-checked with `crypto.timingSafeEqual` before the caller is trusted, so the accept/reject decision does not depend on where two digests first differ.

## Database Migration

Ensure migration `005_api_keys.sql` has been run:

```bash
psql $DATABASE_URL -f db/migrations/005_api_keys.sql
```

## Database Role

The CLI writes to `api_keys` (`create`, `revoke`, `set-limit`), so run it with
the owning role — a login that is a member of `lumina_owner` — and not with the
read-only `lumina_graphql` role the GraphQL server itself connects as. The
server never writes to `api_keys`; key administration is an operator action. See
[docs/DATABASE_ROLES.md](DATABASE_ROLES.md).

## CLI Usage

You can invoke the CLI from the repo root or from `graphql-server`:

```bash
# From root
npm run manage-keys -- <command> [arguments...]

# Or directly in graphql-server
cd graphql-server
npm run manage-keys -- <command> [arguments...]
```

### Commands

#### 1. Create a key
Generates a new key, saves its hash, and outputs the plaintext key once.

```bash
npm run manage-keys -- create <label> [rate_limit_req_per_min]
```
Example:
```bash
npm run manage-keys -- create mobile-app 120
```

#### 2. List all keys
Lists all keys with their metadata, ID, prefix, label, rate limit, and status (ACTIVE / REVOKED).

```bash
npm run manage-keys -- list
```

#### 3. Show key metadata
Shows full details of a key. Note that plaintext keys cannot and will not be displayed.

```bash
npm run manage-keys -- show <id|key_hash>
```

#### 4. Revoke a key
Revokes a key immediately by setting `revoked_at`.

```bash
npm run manage-keys -- revoke <id|key_hash>
```

#### 5. Update rate limit
Updates the requests-per-minute limit for an existing key.

```bash
npm run manage-keys -- set-limit <id|key_hash> <new_limit>
```
