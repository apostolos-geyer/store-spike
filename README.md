# store

The commerce substrate for the somewhatintelligent platform: one alchemy stack,
four Workers, a schema-validated RPC boundary, and an integration suite that
deploys the whole thing against real Cloudflare and tears it down.

Pinned to `platform/`'s versions — effect `4.0.0-beta.101`, drizzle-orm
`1.0.0-rc.4`, alchemy `2.0.0-beta.65` — so it ports without version drift.

```sh
bun install
bun run db:generate                          # regenerate migrations after a schema edit
bun run test:unit                            # no deploy, no network — ~80ms
ALCHEMY_PROFILE=dev bun test                 # deploy → assert → destroy
NO_DESTROY=1 ALCHEMY_PROFILE=dev bun test    # keep the stack up between runs
```

**Status: 137 unit and contract tests pass in ~80ms; 30/30 integration tests
pass against a live deployment — 13 operator, 9 settlement, 8 end-to-end through
Stripe itself, all green after the correctness fixes below. `tsc --noEmit` clean
under `noUncheckedIndexedAccess`, `noUnusedLocals` and `noUnusedParameters`.**

An adversarial review pass raised 22 findings; 19 survived independent
refutation. **All are now closed**, along with the residue conceded inside two
refutations and tracked nowhere — see [REVIEW.md](./REVIEW.md), which leads with
the current state. Five of the six review lenses hit their finding cap, so that
register is a floor, not a ceiling: independent reading afterwards found five
more, including a silent tail-drop in `classifyGuards` and a control path
decided by regex over a database driver's error text.

## Testing

Two tiers that need nothing, and two that need a deployment.

| Tier | Where | Cost | What it proves |
|---|---|---|---|
| Unit | `test/unit/` | ~80ms | Pricing rules, guard classification, the late-event matrix, cursor codecs, version labels, actor attribution |
| Contract | `test/unit/contracts.test.ts` | — | A value the domain produces survives encode/decode through the real `Schema`, and the schema refuses what it should |
| Integration | `test/store.integ.test.ts`, `test/settlement.integ.test.ts` | ~6 min | Real D1 batches: reservation atomicity, guard compensation, the idempotency ledger |
| End-to-end | `test/stripe.e2e.test.ts` | ~4 min | Money actually moves, against Stripe itself |

The unit tier exists because until recently there wasn't one — every test
required a live deploy and a 600-second hook timeout, which is a plausible
reason `settle` reached 351 lines without being decomposed. Writing it found a
real defect in `classifyGuards` within the first minute.

Setup is `stripe login` and nothing else. The CLI's own test key and signing
secret are read at deploy time, so no Stripe credential is pasted into a shell
profile. Without a CLI the stack runs the fake provider and the Stripe suite
skips.

Only `store.integ.test.ts` owns teardown — two `afterAll(destroy)` hooks over one
stage means whichever finishes first pulls the infrastructure out from under the
other. Every suite waits for the deployment to become ROUTABLE before asserting
(`test/Ready.ts`): `deploy` resolving means Cloudflare accepted the resources, not
that a service binding has propagated, and the gap shows up as a first run that
fails and a second that passes.

## Before this takes real money

Three of these are Stripe dashboard actions. The code is correct without them and
will quietly do the wrong thing until they are done.

| | Why it matters |
|---|---|
| **Register for GST/HST in Stripe Tax** | `automatic_tax` is enabled and sessions report `requires_location_inputs`, but Stripe only charges tax where the account holds a registration. With none, **every Canadian order is taxed $0.** Deliberately leave the US unregistered while under the nexus threshold — same switch, flipped when you cross it. |
| **Point a live webhook endpoint at Settlement** | `stripe listen` is a dev affordance. A deployed stage needs a real endpoint on `<settlement-url>/webhook` subscribed to the six events in `FORWARDED_EVENTS`, and its signing secret in `STRIPE_LIVE_WEBHOOK_SECRET`. |
| **Set `STORE_STOREFRONT_URL`** | Where a buyer returns after paying. Defaulted only in dev; preprod and prod refuse to boot without it. |
| **Deploy under a stage named `prod`** | `environmentFor` maps `prod`/`production` to live keys and `preprod`/`staging` to `STRIPE_PREPROD_*`. **Every other name — including a typo — resolves to dev** and reads `STRIPE_TEST_*`, so a live deploy under the wrong stage name silently runs on test keys and takes no money at all. |

Shipping rates are **inline `shipping_rate_data`**, built from
`STORE_SHIPPING_CENTS_CA` / `_US` (defaults $12 / $22). Nothing is created in the
Stripe dashboard and there are no rate IDs to keep in sync.

## Layout

`core/` is the split the platform's boundary config forces: its `app-core` zone
declares `allow: []` and forbids `fetch`, `caches.*`, `crypto.subtle.*` and
`cloudflare:workers.*`. `Domain/` is pure in a weaker sense — it returns
statements instead of committing, but it imports drizzle and the database
handle — so it could not have become `core/` by renaming.

```
alchemy.run.ts              ONE stack. Catalog + Edge get URLs; the rest are bindings.
src/
  core/                     ZERO IMPORTS — decisions, no I/O, no drizzle, no Effect
    pricing.ts              cart rules; what a buyer is charged
    guards.ts               did a conditional write actually take
    settlement-policy.ts    event classes + the late-event matrix
    paging.ts  money.ts     keyset cursors; minor units
    versions.ts  result.ts  release labels; the result envelope + idempotency key
    actors.ts               operator vs customer, by subject namespace
  Domain/                   emits statements; never commits
    Rpc.ts                  the schema-validated trust boundary (23 procedures)
    Contracts.ts            DTOs DERIVED from Rpc schemas + the OperatorCall envelope
    Schema.ts               11 tables: release model, orders, audit, deletion intents
    Catalog.ts              draft → release → active release
    Orders.ts               the order/fulfilment state machine
    Deletion.ts             two-phase plan/confirm cascade
    Reservations.ts         guarded decrement + compensation
    Checkout.ts             order capture
    Settlement.ts           the four-way event outcome
    Reconcile.ts            heal-before-release sweep
    Storefront.ts           active-release public reads
    Media.ts                ingest + serve
  Services/                 CAPABILITIES — Context.Service + static layer
    Database.ts  Ids.ts  Blobs.ts  Audit.ts  Payments.ts  PaymentsFake.ts
  Workers/
    Catalog.ts              public storefront reads + media streaming
    Commerce.ts             url:false, the 23-method operator surface
    Settlement.ts           url:false, webhook + queue + cron
    Edge.ts                 the trust boundary: RpcServer.toHttpEffect
```

## The two boundaries, and why they use different tools

Alchemy's guidance is explicit: Effect RPC crosses a **trust boundary**;
Worker-to-Worker uses **schemaless RPC**. Both appear here.

| Hop | Transport | Mechanism |
|---|---|---|
| client → Edge | HTTP, untrusted | `RpcServer.toHttpEffect(OperatorRpcs)` — every payload `Schema`-decoded, every failure a tagged error |
| Edge → Commerce | service binding | `bindWorker` — structured clone, no serialization, typed against the declared shape |

**In production there is no mutation over HTTP.** The operator console binds
Commerce directly. `Edge` exists for the integration suite and for the eventual
browser client — which is why it is the one place payloads are validated.

Consequence worth stating: there is **not one cast in `src/Workers/`**. An
earlier draft hand-rolled JSON routing with `as unknown as` on request bodies;
that is gone.

## Findings

### 1. `uncoloured` is never needed — and here is the rule

`Drizzle.D1` DEFERS binding resolution to first query, so it can be built at init
and used per event. The RAW binding cannot defer: `d1.raw` carries a
`RuntimeContext` requirement, and that context does not exist in a Worker's init
closure. Yield it there and the requirement leaks into the Worker's own type.

So anything needing the raw binding stays a **Layer**, built inside handlers —
`Services/Database.ts`, `Services/Blobs.ts`, and the RPC server in `Edge.ts` all
follow that shape. `platform/`'s Auth genuinely needs the discharge for a
different reason: it resolves config on the **deploy host** too, one phase before
any runtime context exists. The store has no deploy-host phase.

Corollary: **do not annotate an RPC method's return as `Effect<A>`**. `MainRpc`
permits `RuntimeContext` in a method's requirement and the bridge supplies it per
event; pinning `R` to `never` is what forces a phantom discharge.

### 2. Two database handles, because `batch` is the only atomicity primitive

`EffectSQLiteD1Database` exposes no `batch`, and `@effect/sql-d1` sets
`transactionAcquirer` to `Effect.die("transactions are not supported in D1")`.
Two invariants ride on batching:

- **Audit** — the mutation and its `store_operator_event` row commit together.
- **Reservation** — per-statement `meta.changes` is the only trustworthy signal
  that a guarded conditional UPDATE matched.

So `Drizzle.D1` serves reads and the classic `drizzle-orm/d1` handle serves the
batch path. Measured, not assumed: **a zero-row UPDATE does not abort a batch**,
which is why the explicit compensation in `Reservations.ts` is load-bearing
rather than defensive.

### 3. Capabilities get services; domain cores get arguments

Everything under `Domain/` takes its handles as parameters and reads no tag.
Only things that genuinely vary are services: `Database`, `Ids`, `Blobs`,
`Audit`, `Payments`. v2's `Shell.ts` — twenty-two one-line `lift` wrappers whose
entire job was passing `db` along — has no equivalent here.

### 4. The `Payments` port is what unblocked both of v2's `NotImplemented` sites

`consumeEventBatch` and `reconcilePendingReservations` both failed by name for
the same reason: no port to write them against. Neither needed a vendor SDK —
they needed a normalised vocabulary (`status` separate from `paymentStatus`).

The fake is **D1-backed, not an in-memory Map**: Commerce and Settlement are
separate isolates, and the sweep's whole job is interrogating a provider some
*other* process wrote to. `expire` refusing on a complete session is the safety
property — the sweep releases stock only after `expire` SUCCEEDS, so stranding a
captured charge is unrepresentable.

### 5. Deliberately dropped from v2

- **Roadie** — media is plain R2 put/get/delete.
- **The media-GC outbox** — a transactional outbox, a cron and a backoff schedule
  existed because the byte store was a remote service that could be down while D1
  was up. R2 is a binding on the same Worker. Deleting a media row deletes the
  object, in `onCommitted`, after the batch commits: a failure there leaks an
  unreferenced object, which costs storage and nothing else. The reverse ordering
  would leave a row pointing at bytes that are gone.
- **The dead-letter queue** — an event that exhausts its attempts is written to
  `payment_event` with outcome `dead` and acked. That row is queryable, joins to
  orders, and outlives any queue retention; a second queue would only be a
  transport to the same row. The reconcile sweep, not a DLQ, is what recovers a
  captured charge.
- **The `pending → ready → failed` image lifecycle** — bytes are written to R2
  before the row is inserted, so a row that exists is servable by construction.

### 6. What the suite caught

Three test failures that looked unrelated turned out to be **one thing: the
idempotency ledger working correctly.** The command ids were not run-scoped, so a
second run reused the first run's keys and `Audit.command` replayed the first
run's recorded responses verbatim — returning a product created minutes earlier
instead of creating a new one. Exactly the guarantee it is supposed to give.

Also surfaced: the storefront is **eventually consistent** with the operator
surface. Commerce writes D1 and Catalog reads it from a different Worker, so a
read issued immediately after a publish can miss it. That is a real property —
and the reason the storefront can be cached at the edge — so the tests wait for
it rather than pretending it is synchronous.

## The tests

Ten invariants, not change-detectors. Each pins a property that must survive a
refactor; none assert that one function calls another.

| | Invariant |
|---|---|
| A | A draft is invisible to the storefront until published |
| B | Publishing is refused without media, and without a variant |
| C | A stale revision cannot overwrite a newer one |
| D | The storefront price comes from the release, not the draft |
| E | A replayed command returns the original answer and mutates once |
| F | Deleting a product never touches order history |
| G | A deletion token is single-use and cannot be redirected |
| H | Media is served by id and its bytes round-trip |
| I | A malformed cursor is a typed domain error, never a 500 |
| J | A negative price is refused at encode time, before any handler |

## Stripe: the seam, and the three environments

`Payments` is the port; `PaymentsStripe.ts` is the only file that imports the
SDK. Which one a deployment gets is decided at RUNTIME, from whether the secrets
are actually bound — not from a deploy-time flag, because a flag is a second
source of truth that goes stale the moment a redeploy is a no-op. That is not
hypothetical: it happened here, and the tests caught it.

The asymmetry is deliberate. A stage with no secrets falls back to the fake;
`preprod` and `prod` **die** instead. A production Settlement worker silently
running a fake provider would ack real webhooks into a fake ledger.

| Stage | Keys from | Signing secret |
|---|---|---|
| dev | `STRIPE_TEST_SECRET_KEY` | minted by `stripe listen`, read via `--print-secret` |
| preprod | `STRIPE_SANDBOX_SECRET_KEY` | `STRIPE_SANDBOX_WEBHOOK_SECRET` |
| prod | `STRIPE_LIVE_SECRET_KEY` | `STRIPE_LIVE_WEBHOOK_SECRET` |

Separate variable names per environment is the point — reusing one name and
swapping its value is how a deploy from the wrong shell charges real cards.
`StripeConfig.load` additionally refuses a `sk_live_` key outside prod and a
non-live key on prod — `StripeKeyMismatch`, raised before anything boots.

`livemode` is derived from the key prefix rather than configured, so it cannot
disagree with the account in use, and `Settlement.settle` drops any event whose
`livemode` does not match.

### The local webhook listener

`Infrastructure/StripeDev.ts` is deploy-host-only and does two things:

- `printSigningSecret()` runs `stripe listen --print-secret` and reads the
  `whsec_…` back out. It has to be read rather than configured, because the CLI
  mints a fresh one per session and it must match what the forwarder signs with.
- `forwarder(url)` declares `Command.Dev("StripeListener", …)` — started by
  `alchemy dev`, restarted when the target URL changes, a literal **no-op on
  `alchemy deploy`**, which is right because a deployed stage receives webhooks
  from a real endpoint.

```sh
stripe login                       # once
export STRIPE_TEST_SECRET_KEY=sk_test_…
alchemy dev --stage dev            # starts the forwarder, threads the secret
```

## Dropping this into `platform/`

1. Copy `src/` and `migrations/` in; the versions already match.
2. Replace `actorFrom` in `Workers/Edge.ts` with a real session read — that one
   function is the entire authorization seam.
3. Swap `Services/PaymentsFake.ts` for a real adapter behind the same
   `Payments` service. Nothing in `Domain/` changes.
4. Point the operator console at `CommerceWorker` with `bindWorker`; it needs no
   HTTP surface.

## Not covered

- **Signature verification is written but never executed.** `parseEvent` uses
  `constructEventAsync` with the SubtleCrypto provider and typechecks against the
  real SDK, but no test has run a signed payload through it — that needs
  `stripe listen` and a Stripe account. si tested it
  (`rejects unsigned requests without enqueueing`).
- **Checkout has no end-to-end test.** The reservation guard, compensation and
  session attach are implemented and typechecked, but nothing drives a full
  cart → pay → fulfil purchase, because checkout is not on the operator surface
  and the fake cannot complete a payment.
- **Stock release on a failed payment is implemented but untested.** The branch
  restores every line's stock in the same batch as the cancellation. Verifying it
  needs a real order carrying a session, which needs checkout — see above. A test
  that staged the state without observing the release was deleted rather than
  left in place asserting nothing.
- The queue consumer is deployed and wired but asserted only through
  `replayEvent`, which runs the same `settle`. Nothing tests the queue's own
  ack/retry dispatch — si had four cases there
  (`dispatches concurrently`, `isolates a throwing message`, `retryable → retry
  with backoff`, `backoff escalates, capped at 300s`).
- Splitting Catalog and Commerce onto separate databases. `Deletion.ts` is the
  module that would pay for it — it plans cascades by querying catalog and order
  history together — so make that call after reading it.
