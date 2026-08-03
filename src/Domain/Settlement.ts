/**
 * Payment event settlement — v2's `consumeEventBatch`, now writable.
 *
 * Its docstring named exactly what was missing: "the event-type to
 * order-settlement mapping, the paid predicate, and the ack/retry policy". All
 * three are stated below, and none needed a vendor SDK — they needed the
 * `Payments` port's normalised vocabulary.
 *
 * THE FOUR-WAY OUTCOME is the design. `applied`, `duplicate` and `ignored` all
 * ACK; only `retryable` retries. Settling twice is impossible because
 * `payment_event`'s primary key is the provider's event id, and an event for an
 * order that does not exist YET is the one case worth waiting on.
 *
 * Three properties here are load-bearing and each corresponds to a way real
 * money goes missing:
 *
 *  - A FAILED PAYMENT RELEASES ITS STOCK. Cancelling the order without
 *    restoring inventory strands units that nobody bought — permanently, since
 *    no later event refers to that order.
 *  - A LATE EVENT NEVER CLOBBERS A TERMINAL STATE. Providers redeliver out of
 *    order; a stale `completed` arriving after an `async_payment_failed` must
 *    not resurrect a cancelled order, and vice versa.
 *  - A TEST-MODE EVENT NEVER TOUCHES PRODUCTION. `livemode` is checked against
 *    the deployment, so a webhook aimed at the wrong environment is `ignored`
 *    rather than applied.
 *
 * NO DEAD-LETTER QUEUE. An event that exhausts its attempts is written with
 * outcome `dead` and acked; that row is queryable, joins to orders, and outlives
 * any queue retention.
 */
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";

import { Database, query, type DbStatement } from "../Services/Database.ts";
import type { PaymentStatus, ProviderEvent } from "../Services/Payments.ts";
import { restoreStatements } from "./Reservations.ts";
import { customerOrder, orderItem, paymentEvent } from "./Schema.ts";

export type Outcome = "applied" | "duplicate" | "ignored" | "retryable" | "dead";

/** Delivery attempts before an event is written off. */
export const MAX_ATTEMPTS = 5;

/** Events that move an order toward paid. */
const SETTLING = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/** Events that end an order without payment. Each must release stock. */
const FAILING = new Set([
  "checkout.session.expired",
  "checkout.session.async_payment_failed",
]);

/**
 * MONEY GOING BACK.
 *
 * These arrive as CHARGE events, which carry no session and no metadata — the
 * payment intent recorded at settlement is the only join back to an order. They
 * are handled separately from `FAILING` because the order was genuinely paid and
 * may already be shipped, so the stock question has a different answer.
 */
const REVERSING = new Set(["charge.refunded", "charge.dispute.created"]);

/** THE PAID PREDICATE, stated once so no call site can disagree. */
export const isPaid = (status: PaymentStatus | null): boolean =>
  status === "paid" || status === "no_payment_required";

/**
 * Statuses no event may move an order out of.
 *
 * `paid` is terminal against a FAILING event and `cancelled` against a SETTLING
 * one — anything already shipped or delivered is terminal against both. Without
 * this, a redelivered `completed` could un-cancel an order whose stock was
 * already released and resold.
 */
const TERMINAL = new Set(["shipped", "delivered"]);

export interface Settlement {
  readonly outcome: Outcome;
  readonly orderNumber: string | null;
}

/**
 * Settle ONE event. Split from any batch loop so a poison message cannot take
 * its siblings down, and so the mapping is testable without a queue.
 */
export const settle = Effect.fn("Settlement.settle")(function* (
  event: ProviderEvent,
  attempt: number,
  livemode: boolean,
): Effect.fn.Return<Settlement, never, Database> {
  const database = yield* Database;
  const db = database.db;
  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

  // The provider's event id is the replay key. A seen id never settles twice.
  const seen = yield* query(() =>
    db
      .select({ eventId: paymentEvent.eventId })
      .from(paymentEvent)
      .where(eq(paymentEvent.eventId, event.id))
      .limit(1),
  );
  if (seen.length > 0) return { outcome: "duplicate" as const, orderNumber: null };

  const record = (outcome: Outcome, orderId: string | null) =>
    db.insert(paymentEvent).values({
      eventId: event.id,
      eventType: event.type,
      sessionId: event.sessionId,
      orderId,
      outcome,
      attempts: attempt,
      payload: JSON.stringify(event),
      createdAt: now,
    }) as unknown as DbStatement;

  const ignore = Effect.fn("Settlement.ignore")(function* () {
    yield* Effect.orDie(database.run([record("ignored", null)]));
    return { outcome: "ignored" as const, orderNumber: null };
  });

  /**
   * ENVIRONMENT GATE. A test-mode event reaching a live deployment (or the
   * reverse) is recorded and dropped — applying it would settle a real order
   * against a fake payment.
   */
  if (event.livemode !== livemode) return yield* ignore();

  const settling = SETTLING.has(event.type);
  const failing = FAILING.has(event.type);
  const reversing = REVERSING.has(event.type);
  if (!settling && !failing && !reversing) return yield* ignore();
  if (!event.sessionId && !event.orderId && !event.paymentIntentId) {
    return yield* ignore();
  }

  /**
   * TWO WAYS TO FIND THE ORDER, and both are needed.
   *
   * The session id is the normal path — checkout attached it. But an event can
   * legitimately carry our order id in metadata while referring to a session we
   * never created: that is what `stripe trigger` produces, and it is also what a
   * manually re-fired event from the dashboard looks like.
   *
   * Session id wins when both are present, because it is the stronger claim: it
   * says THIS order, whereas metadata is a hint the caller supplied.
   */
  const columns = {
    id: customerOrder.id,
    orderNumber: customerOrder.orderNumber,
    status: customerOrder.status,
    paymentStatus: customerOrder.paymentStatus,
    sessionId: customerOrder.sessionId,
  };

  const bySession = event.sessionId
    ? yield* query(() =>
        db
          .select(columns)
          .from(customerOrder)
          .where(eq(customerOrder.sessionId, event.sessionId as string))
          .limit(1),
      )
    : [];

  const byOrderId =
    bySession.length === 0 && event.orderId
      ? yield* query(() =>
          db
            .select(columns)
            .from(customerOrder)
            .where(eq(customerOrder.id, event.orderId as string))
            .limit(1),
        )
      : [];

  /**
   * THE THIRD WAY IN, and the only one a refund has. A charge event names no
   * session and carries no metadata, so it is matched on the payment intent that
   * settlement recorded when the order was paid.
   */
  const byIntent =
    bySession.length === 0 && byOrderId.length === 0 && event.paymentIntentId
      ? yield* query(() =>
          db
            .select(columns)
            .from(customerOrder)
            .where(eq(customerOrder.paymentIntentId, event.paymentIntentId as string))
            .limit(1),
        )
      : [];

  const order = bySession[0] ?? byOrderId[0] ?? byIntent[0];

  /**
   * No order carries this session YET. The dominant cause is the webhook
   * beating the checkout write, and it is the one case that deserves another
   * attempt. Past MAX_ATTEMPTS it is written off rather than retried forever.
   */
  if (!order) {
    if (attempt < MAX_ATTEMPTS) return { outcome: "retryable" as const, orderNumber: null };
    yield* Effect.orDie(database.run([record("dead", null)]));
    return { outcome: "dead" as const, orderNumber: null };
  }

  /**
   * LATE-EVENT GUARD. The event is legitimate but the order has already moved
   * past the state it describes, so applying it would move money backwards.
   * Recorded as `ignored` so a redelivery is a `duplicate` rather than a
   * perpetual retry.
   */
  /**
   * A REVERSAL IS NEVER LATE. `shipped` and `delivered` are terminal against a
   * checkout event — a redelivered `completed` must not resurrect a cancelled
   * order — but money coming back on an order already out the door is precisely
   * the case an operator most needs recorded, so it is exempt.
   */
  const alreadyTerminal =
    !reversing &&
    (TERMINAL.has(order.status) ||
      (failing && order.status === "paid") ||
      (settling && order.status === "cancelled"));
  if (alreadyTerminal) {
    yield* Effect.orDie(database.run([record("ignored", order.id)]));
    return { outcome: "ignored" as const, orderNumber: order.orderNumber };
  }

  /**
   * A REVERSAL. The money came back, so the order must stop looking shippable —
   * and the stock question turns on whether anything has left the building.
   *
   *  · not shipped → the goods are still here (or, for a pre-order, were never
   *    made), so the units go back and the place in the run is resold.
   *  · shipped or delivered → the goods are gone. Restoring stock would invent
   *    inventory that does not exist, which oversells the next buyer.
   *
   * A DISPUTE is recorded but never cancels: it can still be won, and cancelling
   * an order that is about to be upheld is a worse error than leaving it open for
   * an operator to judge.
   */
  if (reversing) {
    const disputed = event.type.startsWith("charge.dispute");
    const gone = order.status === "shipped" || order.status === "delivered";

    const lines = disputed || gone
      ? []
      : yield* query(() =>
          db
            .select({
              variantId: orderItem.variantId,
              productId: orderItem.productId,
              quantity: orderItem.quantity,
              preorder: orderItem.preorder,
            })
            .from(orderItem)
            .where(eq(orderItem.orderId, order.id)),
        );

    yield* Effect.orDie(
      database.run([
        ...restoreStatements(db, lines),
        db
          .update(customerOrder)
          .set({
            paymentStatus: disputed ? "disputed" : "refunded",
            ...(disputed || gone ? {} : { status: "cancelled" as const }),
            updatedAt: now,
          })
          .where(eq(customerOrder.id, order.id)) as unknown as DbStatement,
        record("applied", order.id),
      ]),
    );
    return { outcome: "applied" as const, orderNumber: order.orderNumber };
  }

  const paid = settling && isPaid(event.paymentStatus);

  /**
   * A `completed` session that is not yet settled is ASYNC IN FLIGHT — the
   * buyer committed but the funds have not cleared. It holds its stock and
   * waits for `async_payment_succeeded` or `async_payment_failed`.
   */
  if (settling && !paid) {
    yield* Effect.orDie(
      database.run([
        db
          .update(customerOrder)
          .set({ paymentStatus: "processing", updatedAt: now })
          .where(eq(customerOrder.id, order.id)) as unknown as DbStatement,
        record("applied", order.id),
      ]),
    );
    return { outcome: "applied" as const, orderNumber: order.orderNumber };
  }

  if (paid) {
    /**
     * DOES THIS EVENT DESCRIBE OUR SESSION?
     *
     * It is not the same question as "does it name our order". An event reaches
     * this point either because its session id matched, or because its metadata
     * carried our order id — and the second path admits a session we never
     * created: a re-fired fixture, a manually replayed event, a session minted
     * against the same order id by something else.
     *
     * Everything the buyer supplied DURING payment — the address, the amounts,
     * the receipt email, the charge — describes that session and not
     * necessarily this order. Copying a foreign session's address onto a paid
     * order would ship someone else's parcel to their door, and copying its
     * amounts would restate the books in a currency nobody was charged in.
     *
     * So the status settles either way (the order was paid; that much the
     * metadata does assert), but collected facts are written ONLY when the
     * session is the one checkout attached — or when no session was ever
     * recorded, which is the orphan case the fallback exists to repair.
     */
    const describesOurSession =
      order.sessionId === null ||
      (event.sessionId !== null && event.sessionId === order.sessionId);

    /**
     * THE AMOUNTS ACTUALLY CHARGED, copied rather than recomputed.
     *
     * Shipping is the rate the buyer picked and tax is what the provider
     * assessed against the address they typed; neither existed when the order
     * row was written, and both are now settled fact. Recomputing either here
     * would produce a second opinion about money that has already moved — and
     * when a store's books disagree with its processor, the processor is right.
     */
    const collected = describesOurSession
      ? {
          ...(event.paymentIntentId ? { paymentIntentId: event.paymentIntentId } : {}),
          ...(event.shipCountry ? { shipCountry: event.shipCountry } : {}),
          /**
           * The buyer's own address is the LOOKUP KEY and is never overwritten;
           * what they typed on the payment page is recorded beside it. Replacing
           * it would lock them out of the order they just placed.
           */
          ...(event.email ? { receiptEmail: event.email } : {}),
          ...(event.amounts
            ? {
                subtotalCents: event.amounts.subtotalCents,
                shippingCents: event.amounts.shippingCents,
                taxCents: event.amounts.taxCents,
                totalCents: event.amounts.totalCents,
                currency: event.amounts.currency,
              }
            : {}),
          /**
           * The address, all-or-nothing, to respect `ship_address_atomic`.
           */
          ...(event.shipping
            ? {
                shipName: event.shipping.name,
                shipLine1: event.shipping.line1,
                shipLine2: event.shipping.line2,
                shipCity: event.shipping.city,
                shipRegion: event.shipping.region,
                shipPostal: event.shipping.postal,
                shipPhone: event.shipping.phone,
              }
            : {}),
        }
      : {};

    yield* Effect.orDie(
      database.run([
        db
          .update(customerOrder)
          .set({
            status: "paid",
            paymentStatus: "paid",
            ...collected,
            updatedAt: now,
          })
          .where(eq(customerOrder.id, order.id)) as unknown as DbStatement,
        record("applied", order.id),
      ]),
    );
    return { outcome: "applied" as const, orderNumber: order.orderNumber };
  }

  /**
   * FAILED — and this is the branch whose absence loses inventory. The order is
   * cancelled AND every line's stock goes back, in one batch with the evidence
   * row, so a crash between them is impossible.
   */
  const lines = yield* query(() =>
    db
      .select({
        variantId: orderItem.variantId,
        productId: orderItem.productId,
        quantity: orderItem.quantity,
        preorder: orderItem.preorder,
      })
      .from(orderItem)
      .where(eq(orderItem.orderId, order.id)),
  );

  yield* Effect.orDie(
    database.run([
      ...restoreStatements(db, lines),
      db
        .update(customerOrder)
        .set({
          status: "cancelled",
          paymentStatus: event.type.endsWith("expired") ? "expired" : "failed",
          updatedAt: now,
        })
        .where(eq(customerOrder.id, order.id)) as unknown as DbStatement,
      record("applied", order.id),
    ]),
  );

  return { outcome: "applied" as const, orderNumber: order.orderNumber };
});
