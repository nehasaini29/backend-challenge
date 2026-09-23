# Vehicle catalog service

A backend for importing vehicle makes and types from NHTSA and querying them through `/graphql`.

The stack is Node.js, TypeScript, Express, Apollo Server, PostgreSQL, Pino, Zod, and Jest. Ingestion runs separately from queries, so API requests only read stored data.

## Run with Docker

Prerequisite: Docker Engine / Docker Desktop with Docker Compose v2.

```sh
docker compose up --build -d
docker compose logs -f api
```

The API listens on `http://localhost:3000/graphql`. PostgreSQL uses a named volume that survives container recreation. Database migrations run automatically. Startup launches ingestion in the background; requests use the last committed snapshot. On the first run, the catalog is empty until ingestion succeeds. Check `catalogStatus` for the last successful import.

The first import takes time: the sample response has over 12,000 makes, with one additional request per make. Four requests run at a time by default. Wait for `ingestion_completed` in the logs before querying the full catalog. If an import fails, look for `ingestion_failed`; existing data is kept and the refresh can be retried with the command below.

```sh
# Check the service and catalog state
curl http://localhost:3000/health
curl -X POST http://localhost:3000/graphql -H 'Content-Type: application/json' \
  --data '{"query":"{ catalogStatus { makeCount lastSuccessfulIngestion } }"}'

# Explicit refresh; it also retries a failed first import
docker compose exec api npm run ingest:prod

# Stop without deleting stored data
docker compose down
```

`docker compose down -v` removes the database volume and all stored data. The Compose credentials are development defaults. Set `POSTGRES_PASSWORD` before first startup to override them; changing that variable later does not change an existing PostgreSQL user's password. URL-encode password characters when constructing a database URL.

## Local development

Prerequisites: Node.js **22+**, npm, and PostgreSQL **17+** (or the Compose database).

```sh
npm ci
cp .env.example .env
docker compose up -d db
node --env-file=.env --import tsx --watch src/index.ts
```

On PowerShell, use `Copy-Item .env.example .env`. The `--env-file` option loads local configuration; `npm run dev` and `npm run ingest` expect variables already set in the shell. To run an import using `.env`:

```sh
node --env-file=.env --import tsx src/ingest.ts
```

Build and run compiled JavaScript:

```sh
npm run build
node --env-file=.env dist/index.js
# Or npm start when environment variables are already exported
```

## Queries

Send JSON `{ "query": "...", "variables": { ... } }` to `POST /graphql`, with `Content-Type: application/json`. The API is read-only; imports run through the ingestion command or on startup.

```graphql
query OneMake {
  make(makeId: "440") {
    makeId
    makeName
    vehicleTypes { typeId typeName }
  }
}

query Browse($first: Int = 25, $after: ID) {
  makes(first: $first, after: $after) {
    items {
      makeId
      makeName
      vehicleTypes { typeId typeName }
    }
    nextCursor
  }
  catalogStatus { makeCount lastSuccessfulIngestion }
}
```

Example variables: `{ "first": 25, "after": "440" }`. Omit `after` for the first page; pass `nextCursor` to get subsequent pages until it is `null`. To obtain the reference's top-level JSON array, concatenate the `items` arrays. GraphQL responses use their standard `data` envelope.

The [documented schema](src/graphql/schema.ts) defines:

| Field / type | Meaning |
| --- | --- |
| `make(makeId: ID!): VehicleMake` | One stored make; unknown IDs return `null` |
| `makes(first: Int = 25, after: ID): MakePage!` | Numeric-ID keyset pagination; `first` 1–100, exclusive `after` |
| `catalogStatus: CatalogStatus!` | Committed make count and nullable ISO-8601 ingestion timestamp |
| `VehicleMake` | `makeId: ID!`, `makeName: String!`, `vehicleTypes: [VehicleType!]!` |
| `VehicleType` | `typeId: ID!`, `typeName: String!` |
| `MakePage` | `items: [VehicleMake!]!`, `nextCursor: ID` |

IDs serialize as strings and must be positive decimal integers up to 15 digits, with no leading zeroes. An empty `vehicleTypes` array is valid. Introspection is available in development/test and disabled in production; SDL and examples remain in the repository. An embedded browser IDE is not enabled.

## Data model

Each `vehicle_makes` row stores a numeric `make_id` primary key and a `jsonb` payload:

```json
{
  "makeId": "440",
  "makeName": "ASTON MARTIN",
  "vehicleTypes": [
    { "typeId": "2", "typeName": "Passenger Car" },
    { "typeId": "7", "typeName": "Multipurpose Passenger Vehicle (MPV)" }
  ]
}
```

The payload follows the [assignment's JSON shape](https://gist.github.com/mbaigbimm/d340e7800d17737482e71c9ad1856f68). The XML envelope and count are checked during parsing but aren't stored in the payload. `catalog_state` records the count and timestamp of the last successful import; `schema_migrations` tracks schema changes.

JSONB fits the queries here: a make and its types are always read together, so a page needs one query without joins or extra resolver calls. The separate numeric key handles lookups and pagination. If filtering or reporting by vehicle type becomes a requirement, a normalized type table would be worth adding. See [postgres.ts](src/infrastructure/database/postgres.ts).

## Architecture and ingestion

```text
src/
  config/                   Zod-validated environment configuration
  domain/vehicle/           Models, ports, XML transformation and validation
  infrastructure/database/  PostgreSQL migrations and snapshot persistence
  infrastructure/nhtsa/     HTTP requests, timeouts and retries
  graphql/                  SDL, resolvers, Express app
  services/                 Ingestion orchestration
  utils/                    Logger and runtime assembly
  index.ts                  API lifecycle
  ingest.ts                 One-shot ingestion command
tests/                      Unit, HTTP, and real PostgreSQL integration tests
```

1. Fetch [`getallmakes`](https://vpic.nhtsa.dot.gov/api/vehicles/getallmakes?format=XML) and [`GetVehicleTypesForMakeId/{id}`](https://vpic.nhtsa.dot.gov/api/vehicles/GetVehicleTypesForMakeId/440?format=xml). Worker count, request timeout, and retry count are configurable.
2. Reject malformed XML, DTD/entity declarations, incorrect counts, missing/invalid fields, empty make lists, and conflicting duplicate IDs. Identical duplicates are collapsed. Singleton and empty type results become arrays; IDs remain strings; records are sorted numerically.
3. Build the entire snapshot in memory. Any failure cancels sibling requests and waits for the workers to settle. The previous catalog remains untouched.
4. In one transaction, load a temporary table in batches of 500, replace current rows, and update metadata. Constraints or insertion errors roll back the transaction. PostgreSQL MVCC keeps the previous committed catalog readable while publication is in progress.

## Error handling and operations

| Failure | Behavior |
| --- | --- |
| Network error / timeout / HTTP 429 or 5xx | Retry up to `HTTP_MAX_ATTEMPTS`, waiting 500 ms, 1 s, 2 s, and so on, capped at 8 s |
| Other HTTP errors | Fail immediately without retry |
| XML or domain validation error | Fail refresh; log the transformation error; preserve old catalog |
| Database write error | Roll back snapshot and metadata, log failure |
| Startup database/migration error | Exit nonzero; Compose can restart |
| Background ingestion error | API stays up serving old data; manual/scheduled refresh can retry |
| Invalid GraphQL arguments | `BAD_USER_INPUT`; query validation uses `GRAPHQL_VALIDATION_FAILED` |
| Unexpected resolver error | Log internally; return generic `INTERNAL_SERVER_ERROR`, no stack trace |
| SIGINT / SIGTERM | Stop accepting traffic, cancel ingestion, drain requests, stop Apollo, close pool |
| Uncaught exception / rejection | Fatal log and bounded shutdown with nonzero exit |

Pino writes JSON logs to stdout. Request logs include a generated ID (also returned as `x-request-id`), status, and duration. Import logs record completion counts and failures, including parsing and transformation errors. Startup, shutdown, and unexpected exceptions have their own events. Request bodies and upstream XML aren't included in logs; configuration errors name the invalid field without printing its value.

`GET /health` returns `{ "status": "ok" }` while the HTTP service is running. Docker uses this endpoint for its health check. It does not check database availability or import progress; query `catalogStatus` for the last successful import.

## Configuration

`src/config/index.ts` reads and validates environment variables with Zod at startup. Invalid values stop the process with a configuration error. `.env.example` contains local defaults; keep real credentials out of version control.

| Variable | Default | Validation / purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `PORT` | `3000` | 1–65535; Compose uses this as the host port |
| `HOST` | `0.0.0.0` | Bind address for the Node process |
| `DATABASE_URL` | Required | `postgres://` or `postgresql://`; use TLS for remote production DBs |
| `DATABASE_POOL_MAX` | `10` | 2–100 connections per process |
| `LOG_LEVEL` | `info` | Pino levels: trace, debug, info, warn, error, fatal, silent |
| `NHTSA_BASE_URL` | `https://vpic.nhtsa.dot.gov/api/vehicles/` | HTTP(S) base; trailing slash normalized |
| `HTTP_TIMEOUT_MS` | `15000` | 100–120000; covers headers and body per attempt |
| `HTTP_MAX_ATTEMPTS` | `4` | 1–8, including the initial attempt |
| `INGEST_CONCURRENCY` | `4` | 1–16 workers; tune conservatively for upstream capacity |
| `INGEST_ON_STARTUP` | `true` | Exact `true` / `false`; background refresh |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | 1000–120000; forced exit deadline |
| `POSTGRES_PASSWORD` | `vehicles` | Compose-only initialization password |
| `TEST_DATABASE_URL` | Required for integration tests | Disposable PostgreSQL database; tests create/drop a unique schema |

Compose sets `NODE_ENV=production`, port 3000 inside the container, and its database URL using the `db` hostname. Other supported tuning values are forwarded from the shell or Compose's `.env` file. Set container termination grace longer than `SHUTDOWN_TIMEOUT_MS` (Compose defaults here: 35 seconds).

## Testing and CI

```sh
npm run lint             # ESLint plus TypeScript checks, including tests
npm run test:coverage    # Offline Jest unit and Express/Apollo HTTP tests
npm run build           # Compiled JavaScript in dist/
```

Unit tests cover transformations, duplicate/conflicting records, invalid XML, HTTP mocks and retries, cancellation, concurrency, configuration, and GraphQL behavior. No public API is called during tests.

Run the real PostgreSQL integration suite against the local Compose database:

```sh
# POSIX
TEST_DATABASE_URL=postgresql://vehicles:vehicles@localhost:5432/vehicles npm run test:integration
```

```powershell
$env:TEST_DATABASE_URL = 'postgresql://vehicles:vehicles@localhost:5432/vehicles'
npm run test:integration
```

Integration tests use real PostgreSQL and mocked NHTSA responses. They cover ingestion through GraphQL, reads from a new database connection, pagination and rollback after an insert fails. Each run creates and removes its own random schema. `TEST_DATABASE_URL` is required.

[GitHub Actions](.github/workflows/ci.yml) runs linting, unit coverage, real PostgreSQL integration tests, the TypeScript build, and Docker image build. It uploads coverage and compiled artifacts. It does not publish an image or deploy automatically.

## Tradeoffs and deployment notes

- API processes are stateless and can scale horizontally against PostgreSQL. Each page is one indexed database query returning the embedded types. There is no resolver N+1 pattern. Account for aggregate connection pools across replicas.
- Set `INGEST_ON_STARTUP=false` on API replicas and schedule `node dist/ingest.js` as a separate job. Run only one ingestion job at a time; overlapping imports are not coordinated by the service. There is no in-process cron scheduler or automatic whole-job retry; schedule those at the platform level.
- Memory usage is proportional to the complete catalog. This is appropriate for the current dataset. For much larger datasets, ingest into versioned staging tables and atomically switch an active version. Full replacement creates WAL and dead tuples; monitor storage, autovacuum, ingestion duration, and failures.
- Pagination is consistent within each SQL statement. A refresh between page requests may change the traversed dataset; cursors are make IDs, not snapshot tokens. Versioned cursors would be needed for export-level snapshot consistency.
- GraphQL accepts up to 100 makes per page. HTTP request bodies are capped at 32 KB and HTTP batching is disabled. Put a public deployment behind TLS and ingress rate limiting. Authentication is outside this read-only public-catalog exercise.
- Schema migrations are versioned and run at startup. Start one instance first when creating or updating the schema. For larger deployments, run migrations as a dedicated release job using separate privileges. Back up PostgreSQL and rehearse restore procedures; a Docker volume is persistence, not a backup.
