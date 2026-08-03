/**
 * Order capture — the consumer that makes the reservation core reachable.
 *
 * In v2 `reserveStockAndWrite` is dead code: correct, hard-won, and called by
 * nothing, because checkout was never ported. This module closes that loop, and
 * it is the first place the `Payments` port earns its keep.
 *
 * ORDER OF OPERATIONS MATTERS. Stock is reserved and the order row written in
 * ONE batch, and only then is a payment session created. Creating the session
 * first would leave a live session pointing at stock nobody holds; reserving
 * first means the worst case is an ORPHAN — stock held with no session attached
 * — which is exactly the state the reconcile sweep is built to find and release.
 */
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";

import type { CoreOutcome } from "../Services/Audit.ts";
import { Database, type ClassicDb, type DbStatement } from "../Services/Database.ts";
import { Ids } from "../Services/Ids.ts";
import { Payments } from "../Services/Payments.ts";
import type { Destination } from "../Services/StripeConfig.ts";
import { err, ok } from "./Contracts.ts";
import {
  classifyGuards,
  compensateStatement,
  compensateRunStatement,
  computeTotals,
  guardStatement,
  loadPricingInputs,
  orderRollbackStatements,
  runClaims,
  runGuardStatement,
  type CartItem,
  type OrderLine,
} from "./Reservations.ts";
import { customerOrder, orderItem } from "./Schema.ts";

/**
 * How long a fresh payment session may hold stock.
 *
 * THIRTY-FIVE minutes, not thirty, and the five is not arbitrary. Stripe refuses
 * a session whose `expires_at` is under 30 minutes away, and the deadline is
 * computed here but evaluated there — so network latency and the floor to whole
 * seconds both eat into it. Exactly 30 would fail intermittently, under load,
 * on the checkout path, which is the worst possible place for a flake.
 */
export const SESSION_TTL_MS = 35 * 60_000;

export interface PlaceOrderInput {
  readonly items: readonly CartItem[];
  readonly email: string;
  readonly customerId: string;
  /**
   * Where the cart is going, chosen on the storefront before checkout opens.
   *
   * Required rather than inferred, because it decides the shipping rate and the
   * countries the address form will accept — and inferring it from an address we
   * do not have yet is the mistake that lets someone pay Canadian postage to
   * Texas.
   */
  readonly destination: Destination;
}

export interface PlacedOrder {
  readonly orderNumber: string;
  /**
   * LINE ITEMS ONLY. Shipping and tax are added by the provider on the payment
   * page, so this is not what the buyer will be charged — and calling it
   * `totalCents` would invite a storefront to display it as one.
   */
  readonly subtotalCents: number;
  readonly sessionId: string;
  /** Where the buyer goes to pay. `null` under a provider with no hosted page. */
  readonly checkoutUrl: string | null;
}

export type CheckoutError =
  | "empty_cart"
  | "invalid_quantity"
  | "variant_not_found"
  | "product_unavailable"
  | "out_of_stock"
  /** A pre-order run is fully subscribed — distinct from a shelf being empty. */
  | "preorder_full"
  /**
   * Another request with the same command id is mid-flight, or died mid-flight.
   * A double tap gets this on the losing request while the winner completes —
   * which is the correct answer: one cart, one reservation.
   */
  | "in_progress"
  | "payments_unavailable";

/**
 * The order number a customer quotes. Derived from the id's tail rather than a
 * counter, so it needs no sequence table and no coordination.
 */
export const orderNumberFor = (orderId: string): string => `SO-${orderId.slice(-8).toUpperCase()}`;

const orderWriteStatements = (
  db: ClassicDb,
  orderId: string,
  orderNumber: string,
  input: PlaceOrderInput,
  lines: readonly OrderLine[],
  subtotalCents: number,
  currency: string,
  now: number,
  itemIds: readonly string[],
): readonly DbStatement[] => [
  db.insert(customerOrder).values({
    id: orderId,
    orderNumber,
    userId: input.customerId,
    email: input.email,
    status: "pending",
    paymentStatus: "unpaid",
    subtotalCents,
    currency,
    /**
     * Shipping, tax and total are deliberately LEFT AT ZERO here. They are not
     * yet knowable — the buyer has not chosen a rate or entered an address — and
     * writing a guess would put a number in the books that no receipt agrees
     * with. The settlement path fills all three from the paid event.
     */
    shipCountry: input.destination,
    createdAt: now,
    updatedAt: now,
  }) as unknown as DbStatement,
  ...lines.map(
    (line, index) =>
      db.insert(orderItem).values({
        id: itemIds[index] as string,
        orderId,
        productId: line.productId,
        variantId: line.variantId,
        // SNAPSHOT: later catalog edits never rewrite this line.
        titleSnapshot: line.title,
        sizeSnapshot: line.size,
        unitPriceCents: line.unitPriceCents,
        quantity: line.quantity,
        preorder: line.preorder,
        expectedShipAt: line.expectedShipAt,
      }) as unknown as DbStatement,
  ),
];

/**
 * Price the cart, reserve stock and write the order atomically, compensate if a
 * guard lost, then attach a payment session.
 *
 * Returns a {@link CoreOutcome} so `Audit.command` commits it — which is what
 * makes a retried checkout idempotent rather than a second reservation.
 */
export const placeOrder = Effect.fn("Checkout.placeOrder")(function* (
  input: PlaceOrderInput,
  /**
   * THE LEDGER'S CLAIM, and it goes in the FIRST batch — beside the stock
   * guards, not after them.
   *
   * This core cannot hand its statements to `Audit.command`: it has to commit
   * the reservation, inspect which guards won, and only then call the payment
   * provider. That left the reservation outside the ledger's batch, so two taps
   * of Buy both missed the replay check, both decremented stock, and the loser
   * died on the unique index with its phantom hold intact.
   *
   * Committing the claim WITH the guards makes the unique index arbitrate the
   * reservation itself: both requests reach the batch, exactly one commits, and
   * the loser's guards roll back with it.
   */
  claim: DbStatement,
): Effect.fn.Return<
  CoreOutcome<PlacedOrder, CheckoutError>,
  never,
  Database | Ids | Payments
> {
  const database = yield* Database;
  const ids = yield* Ids;
  const payments = yield* Payments;
  const db = database.db;

  /**
   * The currency the order is QUOTED in, recorded on the row rather than left to
   * the column default. The default is right only by coincidence today, and the
   * column exists precisely so the constant can stop being constant.
   */
  const currency = payments.currency;

  const { variants, products } = yield* loadPricingInputs(
    db,
    input.items.map((item) => item.variantId),
  );
  const totals = computeTotals(input.items, variants, products);
  if (!totals.ok) {
    return { failure: err(totals.error as CheckoutError, totals.message) };
  }

  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const orderId = yield* ids.next();
  const itemIds = yield* ids.many(totals.lines.length);
  const orderNumber = orderNumberFor(orderId);

  /**
   * The guards and the order writes commit together. If any guard matched no
   * row the batch still SUCCEEDS — a zero-row UPDATE is not an error — so the
   * result has to be inspected rather than trusted.
   */
  /**
   * Two levels of guard, both compare-and-set, both in the SAME batch as the
   * order writes: one per variant against its own count, and one per product
   * against its manufacturing run. A pre-order for two sizes of one shirt takes
   * two variant guards and ONE run guard, which is the whole reason the run cap
   * lives on the product.
   *
   * Order matters — `classifyGuards` reads the results positionally, because
   * positional correspondence is all D1's batch hands back.
   */
  const claims = runClaims(totals.lines);

  /**
   * NOT `orDie` — the unique index is a CONTROL PATH here, not a crash.
   *
   * The claim shares this batch with the guards precisely so a concurrent
   * duplicate loses on the index, which means D1 answers with a constraint
   * violation and rolls the whole batch back: no reservation, no order rows,
   * nothing to compensate. That is the mechanism working, so it has to become a
   * domain result rather than a 500 on the losing tap of a double-clicked Buy.
   */
  const committed = yield* Effect.result(
    database.run([
      claim,
      ...totals.lines.map((line) => guardStatement(db, line)),
      ...claims.map((claim) => runGuardStatement(db, claim)),
      ...orderWriteStatements(
        db,
        orderId,
        orderNumber,
        input,
        totals.lines,
        totals.subtotalCents,
        currency,
        now,
        itemIds,
      ),
    ]),
  );
  if (committed._tag === "Failure") {
    const detail = String(committed.failure.message ?? committed.failure);
    // Anything else is a real infrastructure failure and must still crash.
    if (!/UNIQUE constraint failed: command_event/i.test(detail)) {
      return yield* Effect.die(committed.failure);
    }
    return { failure: err("in_progress") };
  }
  const results = committed.success;

  /**
   * The claim occupies the FIRST slot, so the guard results start one later.
   * `classifyGuards` reads positionally because positional correspondence is all
   * D1's batch hands back, which makes this offset load-bearing rather than
   * cosmetic.
   */
  const { succeeded, firstFailing, claimed, firstFullRun } = classifyGuards(
    totals.lines,
    claims,
    results.slice(1),
  );

  /**
   * ANY guard losing unwinds ALL of them. A zero-row UPDATE does not abort a D1
   * batch, so the winners committed alongside the loser and have to be handed
   * back explicitly — variant counts and run places alike.
   */
  if (firstFailing || firstFullRun) {
    yield* Effect.orDie(
      database.run([
        ...succeeded.map((line) => compensateStatement(db, line)),
        ...claimed.map((claim) => compensateRunStatement(db, claim)),
        ...orderRollbackStatements(db, orderId),
      ]),
    );
    /**
     * The run being full is reported as its own condition. Telling a shopper a
     * pre-order is "out of stock" describes inventory that never existed and
     * implies more is coming; `preorder_full` says the run is spoken for.
     */
    return firstFullRun
      ? { failure: err("preorder_full", firstFullRun.title) }
      : {
          failure: err(
            "out_of_stock",
            `${(firstFailing as OrderLine).title} (${(firstFailing as OrderLine).size})`,
          ),
        };
  }

  /**
   * Stock is held; attach a session. A failure here leaves an ORPHAN on
   * purpose — the sweep releases it after a grace window, which is strictly
   * safer than unwinding a reservation whose session may have just been created
   * on the provider's side.
   */
  const attached = yield* payments.createSession({
      orderId,
      orderNumber,
      subtotalCents: totals.subtotalCents,
      destination: input.destination,
      expiresAt: now + SESSION_TTL_MS,
      lines: totals.lines.map((line) => ({
        title: line.title,
        size: line.size,
        unitPriceCents: line.unitPriceCents,
        quantity: line.quantity,
        preorder: line.preorder,
      })),
    })
    .pipe(
      /**
       * The provider's failure is a DOMAIN condition here, not a defect: a
       * storefront should render "payments are down, your stock is held" rather
       * than a stack trace. Caught by tag so a new error on this channel has to
       * be handled deliberately instead of being swallowed by a catch-all.
       */
      Effect.catchTag("PaymentsUnavailable", (error) =>
        Effect.succeed({ failure: err("payments_unavailable", error.message) } as const),
      ),
    );
  if ("failure" in attached) return attached;
  const session = attached;

  return {
    statements: [
      db
        .update(customerOrder)
        .set({
          sessionId: session.id,
          // Written in the SAME commit as the session id. An order missing this
          // copy is invisible to the sweep, so the two must never diverge.
          sessionExpiresAt: session.expiresAt,
          updatedAt: now,
        })
        .where(eq(customerOrder.id, orderId)) as unknown as DbStatement,
    ],
    response: ok({
      orderNumber,
      subtotalCents: totals.subtotalCents,
      sessionId: session.id,
      checkoutUrl: session.checkoutUrl,
    }),
    facts: {
      targetType: "order",
      targetId: orderNumber,
      detail: {
        lines: totals.lines.length,
        subtotalCents: totals.subtotalCents,
        destination: input.destination,
        preorder: totals.lines.some((line) => line.preorder),
      },
    },
  };
});
