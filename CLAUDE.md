# store — a spike of a subsystem, not a service

This repo is the commerce **core** for the somewhatintelligent platform. It is
built to be lifted into `platform/` largely intact. It is not, and has never
been, a deployable product on its own.

Read the section below before writing a security finding. It is the single
thing most likely to make a fresh reviewer report something that is not a bug.

---

## There is no authentication here, and that is the design

The platform supplies identity at **two layers that do not exist in this
repo**: Cloudflare Access on the operator side, and a user IdP on the customer
side. This spike deliberately carries neither, so that the domain, the schema
and the settlement machinery can be exercised end to end without dragging an
identity provider into a subsystem that has no opinion about identity.

The authorization model the code actually implements is **the service binding**:

- `Commerce` is declared `url: false`. It has no address, cannot be reached
  from the internet, and performs **no authorization of its own** — every
  method trusts `meta.actor` as already validated by its caller. That is stated
  in its own header and it is the whole point of the design.
- `Edge`, `Catalog` and `Console` are addressed because a browser calls them.
  They mint `meta.actor` and hand it across the binding.
- `SPIKE_ACTOR` (`Workers/Edge.ts`) and `CONSOLE_ACTOR` (`Workers/Console.ts`)
  are hardcoded constants standing in for that identity check. **Replacing
  those two constants with a session read is the entire authorization seam** —
  see the drop-in steps at the end of `README.md`.

### Do NOT report these — they are the design

1. **"Commerce performs no authorization / trusts `meta.actor` blindly."**
   Correct and intentional. The binding is the boundary; `url: false` is the
   other half of it.
2. **"Edge / Console / Catalog accept unauthenticated requests."** Yes. They
   are stand-ins for the platform's real frontends. Ingress exists so the
   integration suite can drive a deployed stack over HTTP.
3. **"`SPIKE_ACTOR` / `CONSOLE_ACTOR` is a hardcoded identity."** Yes, by name,
   deliberately, in one constant each so the seam is a single edit.
4. **"The operator surface is reachable without a login."** In this repo, yes.
   In the platform it sits behind Access.
5. **"Guest checkout derives its subject from an unverified email."** Yes —
   an anonymous storefront has nothing better to key on. Under the user IdP it
   becomes the session subject, which changes the idempotency identity; that is
   noted at `customerCall` in `Domain/Contracts.ts`.

### DO report these — they are real, and the spike posture does not excuse them

The absence of an IdP is not a licence for anything below. These are the
properties the design actually rests on, and breaking one is a genuine defect:

1. **A generic passthrough.** `Console`'s `/api` operations table and
   `Catalog`'s RPC surface are *closed lists*, each key naming exactly one
   Commerce method. A binding grants the **whole** Commerce surface, so that
   list is the only thing between a stray request and `deleteProduct`. A
   wildcard, a computed key, or a forwarded method name is a serious finding.
2. **Widening what crosses back.** The customer views are projections:
   `getMyOrder` must not leak product ids, the internal customer id, the
   fulfilment note or the receipt email. Forwarding an operator row to a
   customer surface is a real leak.
3. **Giving `Commerce` an address**, or binding it to a worker that serves
   untrusted callers without minting an actor.
4. **SQL built from caller-supplied input.** `test/Seed.ts` interpolates
   because `wrangler d1 execute` has no parameter binding; it is confined to
   tests and fed only values the suite produced. Anything reaching it from a
   request, or any interpolation appearing in `src/`, is a finding.
5. **Secrets in the tree.** `.alchemy/` holds resolved `Config` values —
   including the Stripe secret and webhook signing secret — in plaintext, and
   is gitignored for that reason. This repo is public.
6. **Error bodies that leak internals.** D1 failures arrive as defects carrying
   raw driver text with table and column names. Workers log those and return a
   flat `internal`; returning the cause instead is a finding.
7. **Webhook signature verification.** `Settlement` verifies with
   `constructEventAsync` before doing anything. Bypassing or weakening that is
   a finding regardless of stage.

---

## Other framing worth having before you review

- **`Edge` will not exist in the real adaptation.** It is scaffolding for the
  Access-authenticated operator console. `Catalog` is likewise a stand-in for
  the Astro storefront. `Console` is the worked example of what replaces them:
  a worker that holds a binding and calls Commerce as plain methods.
- **D1 has no transactions.** `batch` is the only atomicity primitive, which is
  why guarded conditional UPDATEs and `meta.changes` appear everywhere. A
  "just use a transaction" suggestion is not actionable —
  `@effect/sql-d1` sets `transactionAcquirer` to a defect.
- **Domain cores return failures as values**, never throw. `Audit.command`
  commits the mutation and its ledger row in one batch; a failure returned as a
  value is what lets the audit write be skipped without unwinding.
- **Tests are the regression gate and are not to be edited** to make a change
  pass. `bun run test` deploys to real Cloudflare and tears down.

## Commands

```sh
bun run test:unit       # 157 unit + contract, no infrastructure
bun run test            # 30 integration, deploys to real Cloudflare
bun run console:build   # the SPA; NODE_ENV is pinned, do not unpin it
bun alchemy dev         # local stack — read the ports from its output, they move
bunx fallow dead-code   # the configured gate
```
