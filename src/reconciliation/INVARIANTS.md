# Reconciliation engine — invariants

The reconciliation engine (`engine.ts` / `resolver.ts` / `store.ts`) is the
safety net that catches drift between the off-chain ledger and external rails /
the chain. An over-eager auto-resolver *masks* real money loss; an under-eager
one floods ops with false positives. These are the correctness properties the
engine must uphold, each backed by a test in `invariants.test.ts`.

> Issue #1101. This file is the spec; the tests are the proof.

## I1 — Convergence (order independence)

> For any interleaving/ordering of a matching ledger + provider event pair, the
> pair reaches the correct terminal state (`matched`), and a genuinely unmatched
> event ends `escalated` within its SLA.

Classification is a **pure function** of its inputs:
`classifyLedgerEvent(ledger, providerEvents, rule, nowMs)` in `engine.ts`. It does
no I/O and does not depend on the order events arrived or were queried — the
settlement provider event is chosen deterministically (`pickSettlement`: latest
by `occurredAt`, ties broken by id). Therefore:

- provider-before-ledger and ledger-before-provider converge to the same result;
- a ledger event seen before its provider event is `skipped` (a *non-terminal*
  state) while inside the delay window, and converges to `matched` once the
  provider event exists;
- the only terminal states are `matched`, or a mismatch that is later
  `auto_resolved` / `closed` / `escalated`.

## I2 — Bounded, observable drift

> The total amount auto-absorbed by tolerance over a window is bounded and
> observable — never unbounded, never silent.

Tolerance is accounted **summed and capped, not per-event** (`drift.ts`). Every
within-tolerance difference is added to a rolling per-`rail:currency` window via
`tryAbsorbDrift`. Once the window total would exceed `capMinor`, absorption is
refused and the engine escalates the difference as an `amount_mismatch` instead
of silently swallowing it. The running total is exact (bigint), inspectable via
`getDriftSnapshot`, and exported as the
`reconciliation_tolerance_absorbed_minor_total` metric, with
`reconciliation_drift_cap_breach_total` counting refusals — so systematic drift
is alertable.

Config: `RECON_DRIFT_WINDOW_MS` (default 1h), `RECON_DRIFT_CAP_MINOR`
(default 100000).

## I3 — No double-repair (idempotency)

> Auto-repair of a `missing_credit` is idempotent — retries never double-credit.

The resolver re-attempts an open mismatch on every pass until it succeeds or hits
`maxResolutionAttempts`. The worker fires passes on a fixed interval with two
overlap guards:
- **Intra-process guard**: a slow pass cannot overlap itself (checks `processingPromise` before scheduling)
- **Cluster-wide leader election**: a Postgres advisory lock (`pg_try_advisory_lock`) ensures only one replica runs passes at a time

These guards prevent concurrent passes from invoking the repair effect for the same mismatch.
`applyIdempotentRepair` (`repair.ts`) keys the repair by a deterministic, mismatch-derived key
(`repairKey`) and runs the credit-posting effect **at most once per key**, even under concurrency:

- a completed key short-circuits (the `applied` cache is bounded by size and TTL,
  so a long-running worker cannot grow it without limit);
- an *in-flight* key makes concurrent callers await the same promise instead of
  launching a second effect;
- a failed effect is recorded nowhere, so a genuine transient failure can retry.

Once the credit is confirmed posted, `runResolutionPass` transitions the
mismatch to `auto_resolved` rather than leaving it open to be retried until it
needlessly escalates. The durable cross-process guarantee is a DB unique
constraint on `repairKey`.

## I4 — Deterministic class assignment

> The same facts always produce the same class.

`classifyLedgerEvent` evaluates classes in a fixed order — missing credit →
duplicate debit → amount mismatch → delayed settlement → clean/within-tolerance
match — over a deterministically chosen settlement event. No wall-clock or query
order leaks into the decision (time enters only through the explicit `nowMs`
argument).

## I5 — SLA escalation, never silent auto-resolve

> Genuinely unmatched events escalate within their SLA and are never silently
> auto-resolved.

`runResolutionPass` escalates any open mismatch past `maxResolutionAttempts`
*and* any open mismatch past its `slaDeadline` (`SLA_HOURS_BY_CLASS`,
`listOpenMismatchesPastSla`), independent of attempt count. Nothing transitions
to `auto_resolved` without a handler explicitly doing so.

## Out of scope (per issue)

- A new ops dashboard for mismatches.
- Changing the provider event ingestion contract.
- Durable/cross-process enforcement of I2/I3 (the in-process accountant bounds a
  worker window and feeds the alerting metric; the durable form is a DB unique
  constraint on `repairKey` and a persisted window — a follow-up).

## I6 — Chain rail invariants

> The chain rail (on-chain reconciliation) upholds the same safety properties as
> fiat rails, with chain-specific handling for finality and RPC availability.

The chain rail extends the reconciliation engine to cover on-chain state by reading
positions from money contracts (deal_escrow, staking_pool, rent_wallet, bond_collateral)
via the SorobanAdapter and classifying drift against the off-chain ledger.

### I6.1 — Bounded, observable drift (chain)

> On-chain drift is bounded and observable via the same drift accounting as fiat rails.

The chain rail uses `toleranceMinor: 0` (on-chain state is the source of truth) and
the same `tryAbsorbDrift` cap from I2. Any ledger-vs-chain delta is either:
- Exactly zero (match)
- Escalated as `amount_mismatch` (zero tolerance means no absorption)

The drift cap applies to the `chain:USDC` bucket, so systematic on-chain drift is
alertable via `reconciliation_tolerance_absorbed_minor_total` and
`reconciliation_drift_cap_breach_total`.

### I6.2 — Circuit breaker degradation (never silent auto-resolve)

> RPC unavailability degrades through the circuit breaker and escalates as "unknown",
> never auto-resolves to "matched".

When the SorobanAdapter is wrapped by CircuitBreakerAdapter, `getOnChainPosition`
is protected by the circuit breaker. If the circuit is open (RPC unavailable), the
chain reconciliation pass catches `CircuitBreakerOpenError` and counts the check as
`unknown` — it never treats unavailability as a match. This prevents silent drift
during outages.

### I6.3 — Finality respect (no false positives)

> In-flight settlements and unconfirmed outbox items are not flagged as mismatches.

The chain rail respects finality by:
- Using the chain rail's `maxDelaySeconds` (30s, based on Stellar ledger close time
  ~5s + outbox confirmation depth 3 ledgers) to allow for settlement confirmation
- Checking the outbox for items still in `CONFIRMING` status (within confirmation window)
- Classifying these as non-terminal (`skipped` / `delayed_settlement`) rather than
  `amount_mismatch`

This prevents false positives when a settlement is genuinely in-flight but not yet
finalized on-chain.

### I6.4 — Idempotent repair (I3 holds for chain)

> Auto-repair of an on-chain mismatch is idempotent under concurrent passes.

The chain rail reuses the existing `applyIdempotentRepair` mechanism from I3. The
repair key is derived from the mismatch (including the chain rail identifier), so:
- Concurrent passes never apply the same repair twice
- A failed repair is not recorded, allowing retry
- The durable guarantee is the same DB unique constraint on `repairKey`

Given `maxResolutionAttempts: 0` for the chain rail, most on-chain mismatches
escalate to ops rather than auto-resolve — auto-repair is only used for provably
safe cases (e.g., correcting a ledger entry that was never applied on-chain).
