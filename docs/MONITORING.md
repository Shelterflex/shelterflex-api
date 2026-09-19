# Backend Monitoring

Observability for the Shelterflex API: distributed traces, Prometheus metrics, slow-query logging, and recommended alert thresholds.

## OpenTelemetry tracing

Initialized in `src/tracing.ts` (imported first in `src/index.ts`).

| Resource attribute | Source |
| --- | --- |
| `service.name` | `OTEL_SERVICE_NAME` (default `shelterflex-backend`) |
| `service.version` | `VERSION` |
| `deployment.environment` | `NODE_ENV` |

| Variable | Default | Description |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP HTTP trace endpoint |
| `OTEL_SAMPLING_RATIO` | `1.0` | Trace sampling ratio |
| `OTEL_CONSOLE_EXPORTER` | `false` | `true` prints every span to stdout instead of exporting over OTLP. Debugging only — background workers poll on a timer, so this floods the terminal even with no traffic. |

Auto-instrumentation covers Express HTTP, PostgreSQL (`pg`), and outgoing HTTP.

**Local verification:** run Jaeger or another OTLP HTTP receiver, or start with `OTEL_CONSOLE_EXPORTER=true` and inspect console span output.

## Prometheus metrics (`GET /metrics`)

| Variable | Description |
| --- | --- |
| `METRICS_TOKEN` | Bearer token required to scrape (`Authorization: Bearer <token>`) |

Returns `401` when the token is missing or incorrect.

### Custom metrics (`src/metrics.ts`)

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `payment_initiated_total` | Counter | `provider`, `status` | Payment initiations (`success` / `failed`) |
| `deal_activation_duration_ms` | Histogram | — | Deal activation end-to-end latency (ms) |
| `kyc_submission_total` | Counter | `status` | KYC submissions by outcome |
| `late_payment_escalation_total` | Counter | `escalation_step` | Late-payment escalations by step |
| `outbox_pending_count` | Gauge | — | Number of outbox items currently pending processing |
| `outbox_processed_total` | Counter | `status` | Total outbox items processed by status |
| `outbox_failed_total` | Counter | `reason` | Total outbox items failed or dead-lettered by reason |
| `outbox_processing_duration_ms` | Histogram | — | Outbox item processing duration (ms) |
| `settlement_pending_count` | Gauge | — | Number of settlement outbox items currently pending |
| `settlement_processed_total` | Counter | `status` | Total settlement items processed by status |
| `settlement_failed_total` | Counter | `reason` | Total settlement items failed or dead-lettered by reason |
| `settlement_processing_duration_ms` | Histogram | — | Settlement item processing duration (ms) |
| `reconciliation_pending_count` | Gauge | — | Number of ledger events pending reconciliation |
| `reconciliation_processed_total` | Counter | `status` | Total ledger events processed by status |
| `reconciliation_mismatches_total` | Counter | `mismatch_class` | Total reconciliation mismatches by class |
| `reconciliation_processing_duration_ms` | Histogram | — | Reconciliation pass processing duration (ms) |
| `reconciliation_tolerance_absorbed_minor_total` | Counter | `rail`, `currency` | Total amount (minor units) auto-absorbed by tolerance rules |
| `reconciliation_drift_cap_breach_total` | Counter | `rail`, `currency` | Times the tolerance-absorption cap was breached |

Default Node/process metrics are also exported via `prom-client` `collectDefaultMetrics`.

A separate OTLP/Prometheus exporter may still listen on `PROMETHEUS_PORT` (default `9464`) for SDK metrics; `GET /metrics` is the secured `prom-client` scrape endpoint for issue #931.

## Database query monitoring

- Queries slower than **100 ms** (configurable via `DB_SLOW_QUERY_THRESHOLD_MS`) log a warning with parameterised SQL and `durationMs`.
- Each HTTP request tracks **database query count** keyed by `x-request-id` (logged when the request completes).

## Health check (`GET /health`)

```json
{
  "status": "ok",
  "uptime": 123.45,
  "version": "0.1.0",
  "dbLatencyMs": 2,
  "memoryUsageMb": 85,
  "requestId": "..."
}
```

`dbLatencyMs` is measured with `SELECT 1`. `memoryUsageMb` is heap used rounded to megabytes.

Additional diagnostics remain under `GET /health/details` and related routes.

## Recommended alert thresholds

Configure in Grafana, Datadog, or your monitoring platform:

### General application health

| Condition | Threshold | Window | Suggested severity |
| --- | --- | --- | --- |
| Route P99 latency | > 2 s | 5 min | Warning |
| HTTP error rate | > 1% of requests | 5 min | Critical |
| Container memory | > 80% of limit | 5 min | Warning |
| Slow DB queries | sustained increase in slow-query log rate | 15 min | Warning |

### Async processor health (outbox, settlement, reconciliation)

| Condition | Threshold | Window | Suggested severity |
| --- | --- | --- | --- |
| Outbox pending count | > 100 for > 5 min | 5 min | Warning |
| Outbox pending count | > 1000 for > 5 min | 5 min | Critical |
| Outbox DLQ rate | > 5 items/min | 5 min | Critical |
| Outbox processing duration P95 | > 5 s | 5 min | Warning |
| Settlement pending count | > 50 for > 5 min | 5 min | Warning |
| Settlement pending count | > 500 for > 5 min | 5 min | Critical |
| Settlement DLQ rate | > 5 items/min | 5 min | Critical |
| Settlement processing duration P95 | > 5 s | 5 min | Warning |
| Reconciliation pending count | > 500 for > 10 min | 10 min | Warning |
| Reconciliation mismatch rate | > 10 mismatches/pass | 10 min | Critical |
| Reconciliation processing duration P95 | > 10 s | 10 min | Warning |
| Reconciliation drift cap breach | > 0 in 5 min | 5 min | Critical |

Example PromQL (adjust labels to your setup):

- P99 latency: `histogram_quantile(0.99, sum(rate(http_server_duration_bucket[5m])) by (le, http_route)) > 2`
- Error rate: `sum(rate(http_server_requests_total{http_status_code=~"5.."}[5m])) / sum(rate(http_server_requests_total[5m])) > 0.01`
- Memory: `process_resident_memory_bytes / container_memory_limit_bytes > 0.8`
- Outbox pending: `outbox_pending_count > 100`
- Outbox DLQ rate: `rate(outbox_failed_total[5m]) > 5`
- Outbox processing P95: `histogram_quantile(0.95, rate(outbox_processing_duration_ms_bucket[5m])) > 5000`
- Settlement pending: `settlement_pending_count > 50`
- Settlement DLQ rate: `rate(settlement_failed_total[5m]) > 5`
- Settlement processing P95: `histogram_quantile(0.95, rate(settlement_processing_duration_ms_bucket[5m])) > 5000`
- Reconciliation pending: `reconciliation_pending_count > 500`
- Reconciliation mismatch rate: `rate(reconciliation_mismatches_total[10m]) > 10`
- Reconciliation processing P95: `histogram_quantile(0.95, rate(reconciliation_processing_duration_ms_bucket[10m])) > 10000`
- Drift cap breach: `rate(reconciliation_drift_cap_breach_total[5m]) > 0`
