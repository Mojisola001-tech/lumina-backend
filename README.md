# Lumina Backend

> Stellar event indexer + Apollo GraphQL API + PostgreSQL schema for Lumina, an open-source event indexer and GraphQL data layer for the Stellar network.

Part of the Lumina project, split across three repos:

- [lumina-frontend](https://github.com/Lumeeena/lumina-frontend) — Next.js explorer UI
- [lumina-backend](https://github.com/Lumeeena/lumina-backend) — this repo
- [lumina-contracts](https://github.com/Lumeeena/lumina-contracts) — Soroban Registry contract

API consumers: start with [docs/API_GUIDE.md](docs/API_GUIDE.md), and see
[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) for API keys and rate limits.

## Structure

```
indexer/         Polls Stellar Horizon, writes ledgers/transactions/operations/accounts
                  to Postgres, and (opt-in) indexes Soroban contract events via RPC
graphql-server/   Apollo GraphQL API — reads from Postgres, falls back to Horizon
                  only for accounts that haven't been indexed yet
db/               PostgreSQL schema, migrations, and role grants
docker/           Dockerfiles + docker-compose.yml for postgres + indexer + graphql
```

## How It Works

```
Stellar Horizon ──▶ indexer/ ──▶ PostgreSQL ──▶ graphql-server/ ──▶ lumina-frontend
                                                       ▲
                        Soroban RPC (contract events) ─┘  (opt-in, see below)
                                       ▲
              Lumina Registry (lumina-contracts) ─┘  (opt-in discovery, see below)
```

### Real-time path

Queries read from Postgres. Subscriptions add a push path alongside it, over
Postgres `LISTEN`/`NOTIFY` — the indexer and the GraphQL server are separate
processes, so an in-memory `PubSub` cannot join them, and both already hold a
connection to the same database.

```
indexer/                          graphql-server/                   client
   │                                    │                              │
   │ BEGIN                              │ LISTEN lumina_indexed        │
   │  INSERT ledger/txs/ops             │ (one supervised connection)  │
   │  pg_notify('lumina_indexed', …)    │                              │
   │ COMMIT ─────────────────────▶ notification ──▶ read that ledger   │
   │                                    │           from Postgres      │
   │                                    │              └──▶ push ─────▶│  ws://…/graphql
```

Two things are deliberate here:

- **The notification is queued inside the writing transaction.** Postgres
  delivers notifications at commit, so a rolled-back ledger announces nothing
  and no subscriber is ever told about rows that did not land.
- **The payload carries counts, not content.** Postgres caps a NOTIFY payload
  at 8000 bytes and a busy ledger's transaction hashes alone exceed that, so the
  notification names the ledger and the server reads the rows back out of the
  database. One extra query per ledger (~5s apart) buys a payload that cannot
  overflow or silently truncate.

Subscriptions are served over `graphql-ws` at `ws://localhost:4000/graphql` —
the same path and port as queries:

```graphql
subscription { newTransaction { hash ledger sourceAccount successful } }
subscription { accountActivity(address: "G…") { id type amount asset } }
```

`accountActivity` matches operations that *touch* the address — `source_account`
plus the counterparty fields in `details` — not merely those it submitted, so
being paid counts.

A [Lumina Registry](https://github.com/Lumeeena/lumina-contracts) is deployed
on testnet at `CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ` with
one demo entry (itself), used to verify the discovery wiring below end-to-end
against a live contract.

### Custom event schemas

A project can register a schema describing how its contract's events decode into
named, typed fields — "subgraph-style" indexing on top of the generic
`contract_events` table — and query them through `customEvents` with typed
filters:

```graphql
customEvents(
  contractId: "C…"
  event: "transfer"
  where: [{ field: "amount", op: GT, value: "1000" }]
) { items { fields { name type value } } }
```

Registration is a CLI operation against the database, so a schema can be
iterated on without a transaction, and the Registry keeps deciding *which*
contracts are indexed rather than *how* they decode:

```bash
npm run register-schema -w @lumina/indexer -- apply transfer-schema.json
```

See [docs/CUSTOM_SCHEMAS.md](docs/CUSTOM_SCHEMAS.md) for the format, a worked
example, and what happens when a schema stops matching its contract.

### Search and asset filtering

Memo search, ranked by relevance:

```graphql
search(query: "ORDER-4471", limit: 20) {
  items { hash memo ledger }
  pageInfo { hasNextPage cursor }
}
```

Ranking is **trigram similarity, not full-text search**. `to_tsvector` is built
for prose — it stems words and discards short tokens — and Stellar memos are
mostly not prose: order references, exchange deposit tags, invoice numbers.
Stemming `ORDER-4471` is not merely unhelpful, it is wrong. Trigram treats the
memo as a string, so substrings, typos and case differences all behave the same
way, and one GIN index serves both ranking and `ILIKE`. An exact
case-insensitive match is pinned above every fuzzy one, because pasting a full
memo means looking for that transaction rather than things resembling it.

Search cursors encode the ranking tuple rather than a row id, so a page
boundary holds as new ledgers land. An `OFFSET` would shift every later page by
one whenever a newly indexed transaction sorted earlier, duplicating a row
across the seam.

Filtering operations by asset:

```graphql
operations(asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", limit: 20) {
  items { id type amount asset }
}
```

Use `XLM` (or `native`) for the native asset, which carries no code or issuer on
an operation — without handling that explicitly the most common asset on the
network would be unfindable. A filter matches the asset in all three roles it
can appear in: the payment asset, and either side of an offer. Code and issuer
are always matched together, which is the whole reason issuers exist.

### Index migration time

`db/migrations/004_search_indexes.sql` adds one GIN trigram index and three
expression indexes. On a populated deployment the GIN build is the slow part, so
the migration uses `CREATE INDEX CONCURRENTLY` — it takes longer but does not
hold a write lock, so the indexer keeps running through it. That is also why the
file has no `BEGIN`/`COMMIT`: `CONCURRENTLY` cannot run inside a transaction
block.

Expression indexes rather than generated columns for the asset fields: same
effect for these queries, without rewriting every row in `operations`.

```bash
psql $DATABASE_URL -f db/migrations/004_search_indexes.sql
```

## Run with Docker

```bash
docker compose -f docker/docker-compose.yml up
```

- GraphQL: http://localhost:4000/graphql
- PostgreSQL: localhost:5432

## Run locally

```bash
# once
psql $DATABASE_URL -f db/schema.sql

# once — the least-privilege roles the services connect as (see
# docs/DATABASE_ROLES.md). Needs a superuser connection the first time: it
# creates roles and moves object ownership.
psql "$ADMIN_DATABASE_URL" \
  -v graphql_password="$LUMINA_GRAPHQL_PASSWORD" \
  -v indexer_password="$LUMINA_INDEXER_PASSWORD" \
  -f db/roles.sql
psql "$ADMIN_DATABASE_URL" -f db/verify_roles.sql   # asserts the grants

# indexer
cd indexer && npm install && npm run dev

# graphql server
cd graphql-server && npm install && npm run dev
```

Each service then runs against its own role rather than the owning one:
`DATABASE_URL=postgresql://lumina_indexer:…` for the indexer and
`postgresql://lumina_graphql:…` for the GraphQL server. The server is
read-only, so it cannot write even if a resolver is compromised; the indexer
can write its seven indexed tables and nothing else. Operator commands that do
write — `db/migrations/*.sql`, `npm run manage-keys` — use an `lumina_owner`
connection instead.

### Indexer environment variables

| Variable | Default | Notes |
|---|---|---|
| `HORIZON_URL` | `https://horizon.stellar.org` | |
| `DATABASE_URL` | `postgresql://localhost:5432/lumina` | |
| `DB_POOL_MAX` | `10` | Database connection pool size. Postgres caps total connections via `max_connections` (default 100). The combined pool size of all indexer and graphql-server replicas plus other clients must stay under this. |
| `DB_POOL_IDLE_TIMEOUT` | `10000` | Milliseconds before an idle connection is closed |
| `DB_POOL_CONNECTION_TIMEOUT` | `0` | Milliseconds to wait for a connection before failing (0 = wait forever) |
| `START_LEDGER` | latest | Only used when the DB is empty |
| `POLL_INTERVAL_MS` | `5000` | |
| `HORIZON_MIN_REQUEST_INTERVAL_MS` | `100` | Minimum spacing between outbound Horizon requests, to avoid bursts tripping the per-IP rate limit |
| `SOROBAN_RPC_URL` | unset | Enables Soroban contract event indexing |
| `INDEXED_CONTRACT_IDS` | unset | Comma-separated contract IDs to index events for; requires `SOROBAN_RPC_URL` |
| `REGISTRY_CONTRACT_ID` | unset | Lumina Registry contract to poll for additional contract IDs; requires `SOROBAN_RPC_URL` + `REGISTRY_READ_ACCOUNT` |
| `REGISTRY_READ_ACCOUNT` | unset | Any funded G... account used to simulate the registry's read calls — no secret key needed, simulation doesn't sign or submit |
| `REGISTRY_NETWORK_PASSPHRASE` | Test SDF Network passphrase | Network the registry is deployed on |

Soroban event indexing and registry discovery are both entirely opt-in at
the code level — the indexer behaves exactly as it did before these
variables were introduced when they're unset. `docker/docker-compose.yml`
sets them by default, though, pointed at the deployed testnet registry, so
`docker compose up` shows real contract events out of the box; unset them
there to disable it. When `REGISTRY_CONTRACT_ID` is set, discovered contract
IDs are merged with `INDEXED_CONTRACT_IDS` (the registry is polled roughly
once a minute, independent of the 5s ledger poll loop).

Example against the deployed testnet registry:

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
REGISTRY_CONTRACT_ID=CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ \
REGISTRY_READ_ACCOUNT=<any funded testnet G... address> \
npm run dev
```

### Indexer observability environment variables

| Variable | Default |
|---|---|
| `HEALTH_PORT` | `9090` — port serving `/health`, `/ready` and `/metrics` |
| `HEALTH_MAX_SECONDS_SINCE_INDEX` | `60` — stall threshold before `/health` reports 503 |
| `HEALTH_MAX_LAG_LEDGERS` | `20` — lag threshold before `/health` reports 503 |
| `LOG_LEVEL` | `info` |
| `LOG_PRETTY` | unset — `true` for human-readable local logs |
| `LOG_SAMPLE_RATE` | `0.01` — fraction of routine success logs emitted (see below) |

Routine success logs — one per indexed ledger, plus one per contract-event and
custom-decode batch — are sampled with `LOG_SAMPLE_RATE`, because at a 5s poll
they are the highest-volume source in the indexer and they are measurement
duplicates of the Prometheus counters in `metrics.ts`. `1` logs every one of
them, `0` logs none.

Warnings and errors are never sampled. The sampled path is a separate method
(`routineLogger(...).success()`), so there is no way to log a failure through a
logger that drops lines; `indexer/src/logger.test.ts` asserts that at rate 0 a
warning and an error are still emitted.

An emitted line carries a `suppressed` field with the number of routine
successes dropped since the previous emitted line, so a sampled stream still
shows how much work happened rather than implying nothing did. An unusable
`LOG_SAMPLE_RATE` falls back to the default and says so, instead of stopping the
indexer from starting.

### GraphQL server environment variables

| Variable | Default |
|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/lumina` |
| `DB_POOL_MAX` | `10` | Database connection pool size. Must be sized against Postgres `max_connections` and other service instances. |
| `DB_POOL_IDLE_TIMEOUT` | `10000` | Milliseconds before an idle connection is closed |
| `DB_POOL_CONNECTION_TIMEOUT` | `0` | Milliseconds to wait for a connection before failing (0 = wait forever) |
| `PORT` | `4000` |
| `LOG_LEVEL` | `info` — `debug` for per-ledger detail |
| `LOG_PRETTY` | unset — `true` for human-readable local logs |
| `MAX_SUBSCRIPTIONS` | `500` — concurrent subscriptions before new ones are refused |
| `SUBSCRIPTION_QUEUE_LIMIT` | `64` — notifications buffered per subscriber before the oldest are dropped |
| `ALLOW_ANONYMOUS_ACCESS` | `true` — set `false` to require an API key on every query |
| `API_KEY_HEADER` | `x-api-key` — header the key is read from |

`MAX_SUBSCRIPTIONS` is a ceiling, not a lifetime budget: closing a subscription
frees its slot. Past it, a new subscription is refused with a clear error rather
than degrading every existing one.

`SUBSCRIPTION_QUEUE_LIMIT` bounds what one stalled client — a paused browser
tab, a wedged socket — can accumulate in the server's heap. Past it the *oldest*
notifications are dropped, because on a live feed a client catching up wants the
head of the stream, not a replay of a backlog it no longer cares about.

`ALLOW_ANONYMOUS_ACCESS` defaults to `true` because that is the state the API is
in today: every existing client is anonymous, and introducing keys must not break
any of them. An unrecognised value resolves to *false* rather than `true`, so a
typo in a security switch cannot silently leave the API open.

### Authentication

A request may carry an API key, and the server turns it into a **caller** — an
id, a label, and that key's rate limit — attached to the GraphQL context.
Per-key rate limits, quotas and audit all read that caller rather than the key.

```bash
curl -H "x-api-key: lum_..." http://localhost:4000/graphql \
  -d '{"query":"{ latestLedger { sequence } }"}'
```

Anonymous requests keep working, so nothing changes for a client that sends no
key. Set `ALLOW_ANONYMOUS_ACCESS=false` to require one. Create and revoke keys
with [`manage-keys`](docs/API_KEY_MANAGEMENT.md).

Three properties of this layer are load-bearing:

- **The key is never logged and never echoed.** It is read, hashed, compared and
  dropped. Rejections name the failure, not the value, and an unknown key is
  reported identically to a revoked one — distinguishing them would confirm to
  an attacker that a guessed key really was issued and later cut off. The
  operator still gets the distinction, in the log line and the metric.
- **The digest comparison is constant-time** (`crypto.timingSafeEqual`). The
  digest is not the secret, so this is a second line of defence rather than the
  primary protection — SHA-256 preimage-resistance is what actually protects a
  leaked `api_keys` table. What it buys is that the accept/reject decision does
  not depend on *where* two values first differ.
- **A request that cannot be attributed never reaches a resolver.** The
  middleware runs ahead of the body parser as well as the GraphQL layer, so an
  unauthenticated caller cannot make the server buffer a payload, and a 401 comes
  back before any query is parsed.

The header name is configurable with `API_KEY_HEADER`; the name is matched
case-insensitively, and a key sent under a different header is treated as no key
at all. `lumina_graphql_auth_total{caller,outcome}` counts requests by presented
credential and outcome (`resolved`, `rejected`, `revoked`) — that is how you tell
a misconfigured client from someone guessing at keys.

**Subscriptions are not authenticated.** A websocket cannot present an HTTP
header, so `ws://…/graphql` connections are always the anonymous caller. That path
needs its own work before `ALLOW_ANONYMOUS_ACCESS=false` is a complete lock-down.

## Observability

Both services expose Prometheus metrics and a real health endpoint. `docker
compose ps` reports accurate health rather than "running", because the checks
measure *progress* rather than liveness — a polling loop that is up and no
longer writing ledgers is the failure that actually happens, and it is
indistinguishable from a healthy one without this.

| Endpoint | Service |
| --- | --- |
| `http://localhost:4000/health` | GraphQL server — runs a real `SELECT 1` |
| `http://localhost:4000/metrics` | GraphQL server |
| `http://localhost:9090/health` | Indexer — 503 once indexing stalls |
| `http://localhost:9090/ready` | Indexer — 503 until the first ledger lands |
| `http://localhost:9090/metrics` | Indexer |

Run the local stack with Prometheus and a provisioned Grafana dashboard:

```bash
docker compose -f docker/docker-compose.yml --profile observability up
```

Grafana is on http://localhost:3001 (admin/admin), Prometheus on
http://localhost:9091. The dashboard, datasource and alert rules are checked in
under `docker/observability/`.

Logs are structured JSON via `pino`, with values as fields rather than
interpolated into the message, so a ledger number is queryable rather than
greppable. `LOG_LEVEL` sets verbosity and `LOG_PRETTY=true` gives readable
output locally.

### What "unhealthy" means

Thresholds live in one place — `docker/observability/alerts.yml` — and the
services' own health checks mirror them, so a page, a red container and a red
dashboard panel never disagree.

| Condition | Threshold | Severity |
| --- | --- | --- |
| No ledger indexed | > 60s | critical |
| Behind Horizon | > 20 ledgers for 5m | warning |
| Horizon 429 rate | > 0.1/s for 5m | warning |
| Indexing errors | > 0.05/s for 10m | warning |
| Queries waiting on a DB connection | any, for 5m | warning |
| LISTEN connection down | > 5m | warning |
| GraphQL error ratio | > 5% for 10m | warning |

Both indexer thresholds are configurable with
`HEALTH_MAX_SECONDS_SINCE_INDEX` and `HEALTH_MAX_LAG_LEDGERS`.

### Runbook: indexing lag is high

1. **Check whether it is Horizon rate limiting.** Look at
   `lumina_horizon_requests_total{status="429"}` — this is the metric the whole
   layer exists for, because a sustained 429 rate silently breaks account
   lookups and used to be visible only in raw logs. If it is non-zero, raise
   `HORIZON_MIN_REQUEST_INTERVAL_MS` (the default of 1000ms is already
   conservative for anonymous access; public Horizon 429s even at 10 req/sec
   sustained).
2. **Check whether the indexer is writing at all.**
   `time() - lumina_last_successful_index_timestamp_seconds` climbing without
   bound means the loop is wedged rather than slow. `curl localhost:9090/health`
   names the failing check.
3. **Check the database.** `/health` reports `database: unreachable` when the
   pool cannot answer `SELECT 1`. On the GraphQL side,
   `lumina_db_pool_waiting > 0` means queries are queuing for a connection — a
   latency cliff with no error to point at.
4. **Check how long writes are taking.**
   `lumina_ledger_index_duration_seconds` p95 rising alongside a healthy
   Horizon points at Postgres, not the network.
5. **Check which loop is failing.** `lumina_indexing_errors_total` is labelled
   by loop (`ledger`, `registry`, `contract-events`, `custom-schema`), so a
   broken custom schema is distinguishable from a Horizon outage.

### Runbook: subscriptions stopped delivering

`lumina_graphql_listener_connected` at 0 means the Postgres `LISTEN` connection
is down and reconnecting; queries are unaffected and this is not fatal to
health. If it stays down, check Postgres connectivity from the GraphQL
container. `lumina_graphql_subscriptions_rejected_total` increasing means
clients are hitting the `MAX_SUBSCRIPTIONS` ceiling.

### Database Backup & Restore Runbook

The indexer records full historical ledger state in PostgreSQL that cannot be reconstructed from chain tip alone. See [docs/DATABASE_RESTORE_RUNBOOK.md](docs/DATABASE_RESTORE_RUNBOOK.md) for the operational runbook covering:
- Backup strategy, snapshot isolation, and recommended cadence
- Step-by-step restoration procedure and expected duration benchmarks
- Indexer startup catch-up behavior against restored databases
- Gap detection queries and remediation procedures

## Testing

```bash
npm test   # runs indexer + graphql-server test suites
```

The subscription integration tests need a real Postgres and are skipped without
one, since they exist to check the things a faked `pg` client cannot: that
Postgres actually delivers a NOTIFY, that a rolled-back one is never delivered,
and that killing the listener's backend surfaces as the events the reconnect
supervisor waits for.

```bash
TEST_DATABASE_URL=postgresql://lumina:lumina@localhost:5432/lumina \
  npm run test:integration -w @lumina/graphql-server
```

CI runs them against its own Postgres service.

## License

MIT
