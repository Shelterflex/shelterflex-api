# Shelterflex Backend

Node.js backend for Shelterflex.

## Setup

> **Package manager:** This project uses **npm**. Use `npm install` (not `pnpm` or `yarn`) to match
> the `package-lock.json` lockfile that is committed to the repository.

**Prerequisites:**

- A local Postgres instance with a database matching `DATABASE_URL` in `.env.example`
  (default: `postgres://app:app@localhost:5432/app` — create a role and database named
  `app` locally, or point `DATABASE_URL` at your own instance). Required — the server
  runs pending migrations against it on startup.
- Redis is optional for local development: it's used for rate limiting/quotas and fails
  open if unreachable, or set `REDIS_DISABLED=true` to skip it entirely.

Postgres + MinIO are easiest to run via the full-stack compose in
[shelterflex-platform](https://github.com/Shelterflex/shelterflex-platform).

```bash
npm install
cp .env.example .env
npm run db:migrate   # create the schema
npm run db:seed      # load the development dataset
npm run dev
```

`.env.example` ships with schema-valid placeholder secrets so the server boots
out of the box — replace `ENCRYPTION_KEY` and `WEBHOOK_KEY` with real generated
values before using this outside local development (see the comments in
`.env.example` for how to generate each one).

`npm run dev` also applies pending migrations on startup, so `db:migrate` is
only needed when you want the schema without booting the server. Skipping
`db:seed` leaves you with an empty database: every listing page, search result
and dashboard renders empty, which is indistinguishable from a broken build.

## Seed data

`npm run db:seed` loads a small, deterministic development dataset: accounts for
every role, landlord properties with photos, public listings across several
cities and price bands, two leases with instalment history, inspection jobs and
tenant applications.

### Seeded accounts

Authentication is passwordless — request an OTP for one of these addresses and
read the code from the server console (`OTP_DELIVERY_PROVIDER=console` is the
default in `.env.example`). All addresses use the reserved `example.com` domain
and all data is fictional.

| Role | Email | Name |
|---|---|---|
| tenant | `tenant@example.com` | Tola Tenant — has an active lease with payment history |
| tenant | `tenant2@example.com` | Temi Tenant — has a completed lease |
| landlord | `landlord@example.com` | Lola Landlord — owns 3 properties |
| landlord | `landlord2@example.com` | Lanre Landlord — owns 3 properties |
| admin | `admin@example.com` | Ada Admin — also granted the `super_admin` RBAC role |
| inspector | `inspector@example.com` | Ike Inspector — verified, has assigned jobs |
| agent | `agent@example.com` | Ayo Agent |

```bash
curl -X POST localhost:4000/api/v1/auth/request-otp \
  -H 'content-type: application/json' -d '{"email":"landlord@example.com"}'
# the OTP is printed in the server log; then:
curl -X POST localhost:4000/api/v1/auth/verify-otp \
  -H 'content-type: application/json' -d '{"email":"landlord@example.com","otp":"123456"}'
```

### Behaviour

- **Idempotent.** Every row is upserted on a fixed primary key, so running the
  seed repeatedly refreshes the same rows and never duplicates them.
- **Deterministic ids.** Seeded UUIDs all start with `5eed`, so tests can
  reference stable ids (see `src/seeds/devData.ts`) and
  `WHERE id::text LIKE '5eed%'` finds seeded rows. Only the payment due dates
  move — they are anchored to the current month so the dataset stays plausible.
- **Transactional.** The whole seed runs in one transaction; a failure part-way
  through rolls back and leaves the database exactly as it was. You can prove
  this with `npm run db:seed -- --simulate-failure`, which aborts mid-run on
  purpose.
- **Guarded.** The seed refuses to run when `NODE_ENV=production` (no override),
  and any database host that is not local needs explicit confirmation:
  `npm run db:seed -- --allow-remote` (or `SEED_ALLOW_REMOTE=true`).

### Starting over

```bash
npm run db:reset     # drop the schema, re-run every migration, seed
```

`db:reset` is destructive and goes through the same guard as `db:seed`.

## Testing

Run the integration test suite:

```bash
npm test
```

Run tests in watch mode (useful during development):

```bash
npm run test:watch
```

Run tests with coverage report:

```bash
npm run test:coverage
```

Run Soroban integration tests (requires configuration):

```bash
npm run test:integration
```

Tests are located in `src/**/*.test.ts` files and use Vitest + Supertest. 

- **Unit tests** do not require external network access — all blockchain interactions are stubbed.
- **Integration tests** make actual calls to Soroban testnet and require proper environment configuration. See [docs/soroban-integration-tests.md](docs/soroban-integration-tests.md) for details.

## Database migrations

SQL migrations live in `migrations/` and are applied in filename order.

`npm run db:migrate` (and the server on startup) runs the migration runner in
`src/migrations/runMigrations.ts`, which:

- creates a `schema_migrations` table if missing
- applies any `.sql` files not yet recorded, each in its own transaction

`npm run db:verify` applies every migration to a throwaway database to check
that the schema builds from empty.

## Documentation

| Topic | File |
|---|---|
| API specification (OpenAPI) | [docs/openapi.yml](docs/openapi.yml) |
| Error handling contract | [src/docs/ERROR-INFO.md](src/docs/ERROR-INFO.md) |
| Soroban integration tests | [docs/soroban-integration-tests.md](docs/soroban-integration-tests.md) |
| Admin signing service | [docs/ADMIN_SIGNING.md](docs/ADMIN_SIGNING.md) |
| Webhook signature verification | [docs/WEBHOOK_SIGNATURE_VERIFICATION.md](docs/WEBHOOK_SIGNATURE_VERIFICATION.md) |

## API Specification

All API endpoints are now versioned under `/api/v1/`. The current version is `v1`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service liveness check (includes API version) |
| `GET` | `/soroban/config` | Returns the active Soroban RPC configuration |
| `POST` | `/api/v1/example/echo` | Example endpoint demonstrating Zod validation |
| `POST` | `/soroban/simulate` | Validates and queues a Soroban contract simulation |

### API Versioning

The API uses URL path versioning with the `/api/v1/` prefix. Requests to the unversioned `/api/*` paths are automatically redirected to `/api/v1/*` with deprecation headers.

**Version negotiation:**
- URL path prefix: `/api/v1/...` (preferred)
- `Accept-Version` header: `v1` (optional)
- Default: `v1`

**Deprecation headers:**
When accessing deprecated API versions, the response includes:
- `Deprecation: true`
- `Sunset: {date}` (ISO 8601 date string)
- `Link: </api/v1>; rel="successor-version"`

**Health check response:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "apiVersion": "v1",
  "uptimeSeconds": 1234,
  "dbLatencyMs": 5,
  "memoryUsageMb": 128,
  "requestId": "abc-123"
}
```

### POST `/api/v1/example/echo`

Example endpoint demonstrating Zod request validation. Use this as a reference pattern when adding new endpoints.

**Request body**

```json
{
  "message": "Hello, world!",
  "timestamp": 1234567890
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `message` | `string` | ✅ | 1-100 characters |
| `timestamp` | `number` | ❌ | Positive integer |

**Success – 200**

```json
{
  "echo": "Hello, world!",
  "receivedAt": "2026-02-27T10:30:00.000Z",
  "originalTimestamp": 1234567890
}
```

**Validation error – 400**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {
      "message": "Message cannot be empty"
    }
  }
}
```

**Example curl commands**

Valid request:
```bash
curl -X POST http://localhost:3001/api/v1/example/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, world!", "timestamp": 1234567890}'
```

Invalid request (empty message):
```bash
curl -X POST http://localhost:3001/api/v1/example/echo \
  -H "Content-Type: application/json" \
  -d '{"message": ""}'
```

Invalid request (wrong type):
```bash
curl -X POST http://localhost:3001/api/v1/example/echo \
  -H "Content-Type: application/json" \
  -d '{"message": 123}'
```

### POST `/soroban/simulate`

Validates the request body with Zod before forwarding to the Soroban RPC node.
Returns **400** with structured field-level errors on invalid input.

**Request body**

```json
{
  "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "method": "deposit",
  "args": [1000, "GABC..."]
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `contractId` | `string` | ✅ | Exactly 56 characters (Stellar strkey) |
| `method` | `string` | ✅ | Non-empty string |
| `args` | `unknown[]` | ❌ | Defaults to `[]` |

**Success – 200**

```json
{
  "contractId": "CAAA...",
  "method": "deposit",
  "args": [1000, "GABC..."],
  "status": "pending",
  "message": "Simulation queued – RPC integration coming soon"
}
```

**Validation error – 400**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {
      "contractId": "contractId must be a 56-character Stellar strkey"
    }
  }
}
```
The complete API specification is available in [OpenAPI format](docs/openapi.yml). It includes:
- All available endpoints
- Request/response schemas
- Error response formats
- Example requests and responses

You can view the OpenAPI spec in tools like Swagger UI or Redoc, or use it to generate client code.

## Request validation pattern

All endpoints that accept input use the `validate` middleware from
`src/middleware/validate.ts`. It wraps any Zod schema and can target
`body` (default), `query`, or `params`:

```ts
import { validate } from './middleware/validate.js'
import { mySchema } from './schemas/my-feature.js'

// validate body (default)
router.post('/route', validate(mySchema), handler)

// validate query string
router.get('/route', validate(mySchema, 'query'), handler)
```

Schemas live in `src/schemas/` and export both the Zod schema and the
inferred TypeScript type.

## Error handling

See [src/docs/ERROR-INFO.md](src/docs/ERROR-INFO.md) for the full error contract, code catalog, and usage examples.

## Environment Variables

Create a `.env` file based on `.env.example`. The following environment variables are required:

### Core Configuration
```bash
# Server
PORT=4000
NODE_ENV=development

# CORS (comma-separated origins)
CORS_ORIGINS=http://localhost:3000

# Rate limiting (public endpoints: /health, /soroban/config)
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# HTTP security headers (helmet). Leave SECURITY_HSTS_ENABLED unset to follow
# NODE_ENV — HSTS on in production, off elsewhere so local HTTP dev works.
# SECURITY_HSTS_ENABLED=
SECURITY_HSTS_MAX_AGE=15552000
SECURITY_HSTS_INCLUDE_SUBDOMAINS=true
SECURITY_HSTS_PRELOAD=false
SECURITY_FRAME_OPTIONS=DENY
SECURITY_REFERRER_POLICY=no-referrer
```

### Soroban / Stellar Configuration
```bash
# Soroban network (local|testnet|mainnet)
SOROBAN_NETWORK=testnet

# Soroban adapter mode (stub|real)
# 'stub' (default) uses fake data, 'real' makes actual contract calls
SOROBAN_ADAPTER_MODE=stub

# USDC token contract address (required in non-development environments).
# This must be a Soroban contract ID: a 56-character Stellar StrKey starting with 'C' (base32).
# Prefer SOROBAN_USDC_TOKEN_ID; USDC_TOKEN_ADDRESS is accepted as a legacy alias.
# Testnet example: USDC_TOKEN_ADDRESS=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
# Mainnet example: USDC_TOKEN_ADDRESS=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7EJJUD
USDC_TOKEN_ADDRESS=

# Soroban RPC URL and network passphrase
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Soroban contract IDs (required for 'real' adapter mode).
# Each value must be a 56-character Stellar StrKey starting with 'C'.
SOROBAN_CONTRACT_ID=
SOROBAN_USDC_TOKEN_ID=
SOROBAN_STAKING_POOL_ID=
SOROBAN_STAKING_REWARDS_ID=
```

### Indexer Configuration
```bash
# How often the indexer polls for new ledgers (in milliseconds). Default is 5000.
INDEXER_POLL_MS=5000

# The ledger sequence number to start indexing from. If omitted, the indexer starts from the current network ledger.
INDEXER_START_LEDGER=
```

**Important Notes:**
- `SOROBAN_USDC_TOKEN_ID` (preferred) or `USDC_TOKEN_ADDRESS` (legacy alias) is **required** in `production` environments
- In `development` and `test`, the token ID can be omitted (the server uses mock/stub data)
- The value must be a valid Soroban contract ID: a **56-character Stellar StrKey starting with `C`** (base32-encoded, no `0x` prefix)
- Server will refuse to start if neither variable is set in non-development/non-test environments

**Soroban Adapter Mode**: The backend uses an adapter pattern for Soroban interactions:
- `SOROBAN_ADAPTER_MODE=stub` (Default): Uses in-memory state and fake data. No network calls are made. Suitable for local UI development and unit testing.
- `SOROBAN_ADAPTER_MODE=real`: Performs actual calls to the Soroban RPC. Requires all contract IDs and network configuration to be set.

**Admin Signing**: Admin operations (pause/unpause, set_operator, init) require:
- `SOROBAN_ADMIN_SECRET` - Admin secret key for signing transactions
- `SOROBAN_ADMIN_SIGNING_ENABLED=true` - Feature flag to enable admin signing

> [!CAUTION]
> **Security**: `SOROBAN_ADMIN_SECRET` confers full control over the contracts. It should ONLY be used in restricted admin contexts and NEVER committed to version control. General request handlers do not have access to this secret.


## Request IDs

Every incoming request is assigned a unique request ID to help track and debug requests across the system.

- If the client sends `x-request-id` in the request header, it is reused.
- Otherwise, a UUID is generated automatically.
- The request ID is returned in the response header (`x-request-id`).
- Error responses include the request ID in both the header and the JSON body.
- Logs include the request ID for easier correlation between requests and system logs.

Example:

Request:
GET /health
x-request-id: abc-123

Response:
HTTP/1.1 200 OK
x-request-id: abc-123
{
  "status": "ok",
  "requestId": "abc-123"
}
## Rate limiting

The backend implements a comprehensive rate limiting system to protect sensitive endpoints and prevent abuse. It supports per-endpoint, per-user (authenticated), and per-IP (unauthenticated) limits.

### Configuration

Rate limits are configured in `src/middleware/comprehensiveRateLimit.ts`. Default limits are:

| Category | Endpoints | Default Limit | Window |
|----------|-----------|---------------|--------|
| Auth | `/api/auth/*` | 5-20 reqs | 1-15 min |
| Wallet | `/api/wallet/*` | 30 reqs | 1 min |
| Admin | `/api/admin/*` | 10 reqs | 1 min |
| General | `/api/*` | 50-100 reqs | 1 min |

### Environment Variables

Global defaults can be adjusted via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `RATE_LIMIT_WINDOW_MS` | Default time window in milliseconds | `60000` (1 minute) |
| `RATE_LIMIT_MAX_REQUESTS` | Default max requests per IP/user per window | `100` |

### Headers

The server includes standard rate limit headers in all API responses:

- `X-RateLimit-Limit`: The total limit for the current window.
- `X-RateLimit-Remaining`: Remaining requests in the current window.
- `X-RateLimit-Reset`: Time when the limit resets (UTC timestamp in seconds).
- `Retry-After`: (Only on 429) Number of seconds to wait before retrying.

### 429 Too Many Requests

When a limit is exceeded, the server returns a **429** error with a `Retry-After` header:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Too many requests. Please try again later."
  }
}
```

Health checks (`/health`) are exempt from rate limiting.

## Object Storage

The backend uses S3-compatible object storage for tenant documents, property media, inspection reports, and rental agreements. The storage layer supports both AWS S3 and MinIO (for local development).

### Configuration

Set the storage provider and credentials in `.env`:

```bash
# Storage provider: s3 (AWS S3 or MinIO) or local (filesystem)
STORAGE_PROVIDER=s3

# S3 Configuration (required when STORAGE_PROVIDER=s3)
S3_BUCKET=tenant-documents
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your_access_key
S3_SECRET_ACCESS_KEY=your_secret_key
S3_ENDPOINT=https://s3.amazonaws.com  # For MinIO: http://localhost:9000
S3_FORCE_PATH_STYLE=false  # Set to true for MinIO

# Local Storage Configuration (required when STORAGE_PROVIDER=local)
LOCAL_STORAGE_DIR=/tmp/shelterflex-dev
```

### Local Development with MinIO

For local development, you can run MinIO using Docker:

```bash
docker run -d \
  -p 9000:9000 \
  -p 9001:9001 \
  --name minio \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

Then configure your `.env`:

```bash
STORAGE_PROVIDER=s3
S3_BUCKET=tenant-documents
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
```

After starting MinIO:
1. Visit http://localhost:9001
2. Login with `minioadmin` / `minioadmin`
3. Create a bucket named `tenant-documents`
4. Set bucket policy to block all public access (access via presigned URLs only)

### Bucket Structure Convention

Files are organized using the following key structure:

- `tenant-documents/{tenantId}/{docType}/{uuid}.{ext}` - Tenant documents
- `property-media/{listingId}/{uuid}.{ext}` - Property images
- `inspection-reports/{jobId}/{uuid}.{ext}` - Inspection reports
- `agreements/{dealId}/agreement.pdf` - Rental agreements

### Usage

```typescript
import {
  getStorageProvider,
  buildTenantDocumentObjectKey,
  uploadFile,
  deleteFile,
  generatePresignedUpload,
  generatePresignedDownload,
  copyFile,
} from './services/storageService.js'

// Get the configured storage provider
const provider = getStorageProvider()

// Upload a file
const key = buildTenantDocumentObjectKey('tenant-123', 'id-proof', 'application/pdf')
const { key: objectKey, url } = await uploadFile(key, buffer, 'application/pdf')

// Generate presigned upload URL (for direct browser upload)
const { uploadUrl, objectKey } = await generatePresignedUpload(key, 'image/jpeg', 900)

// Generate presigned download URL
const { downloadUrl } = await generatePresignedDownload(key, 300)

// Delete a file
await deleteFile(key)

// Copy a file
await copyFile(sourceKey, destKey)
```

### Switching Providers

Set `STORAGE_PROVIDER=local` to use filesystem storage without AWS credentials:

```bash
STORAGE_PROVIDER=local
LOCAL_STORAGE_DIR=/tmp/shelterflex-dev
```

This is useful for local development when you don't want to run MinIO.

