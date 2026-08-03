/**
 * The reconcile sweep — v2's `reconcilePendingReservations`, and the store's
 * actual money backstop.
 *
 * It covers the two reservation failure classes no webhook can:
 *
 *  - ORPHAN: stock decremented, no session ever attached (the provider call
 *    failed after the reservation committed). Resolvable from the database
 *    alone, but only after a GRACE WINDOW — an order mid-checkout is
 *    indistinguishable from an orphan for a few seconds.
 *  - STALE-ATTACHED: a session is attached, its expiry has passed, and no
 *    terminal payment status landed. NOT resolvable from the database: whether
 *    that session can still be paid is a question only the provider can answer.
 *
 * HEAL BEFORE RELEASE. A session the provider reports as complete-and-paid means
 * the buyer WAS charged and the settlement event was lost — that order is
 * advanced to paid and its stock stays held. Only a session PROVEN dead releases
 * stock: already expired, or successfully expired by this sweep. Anything
 * inconclusive — a failed lookup, a complete-but-still-settling session — is
 * left for the next run and never released blind, because releasing paid stock
 * is unrecoverable while waiting one more cycle costs nothing.
 *
 * This is the routine that makes the absence of a dead-letter queue safe: it
 * recovers a captured charge whether or not the event was ever delivered.
 */
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import * as Effect from "effect/Effect";

import { Database, query, type DbStatement } from "../Services/Database.ts";
import { Payments } from "../Services/Payments.ts";
import { releaseStatements } from "./Reservations.ts";
import { customerOrder, orderItem } from "./Schema.ts";

/** How long an order may hold stock with no session before it is presumed abandoned. */
export const ORPHAN_GRACE_MS = 15 * 60_000;

export interface SweepResult {
  readonly orphansReleased: number;
  readonly healed: number;
  readonly released: number;
  readonly inconclusive: number;
}

export const sweep = Effect.fn("Reconcile.sweep")(function* (): Effect.fn.Return<
  SweepResult,
  never,
  Database | Payments
> {
  const database = yield* Database;
  const payments = yield* Payments;
  const db = database.db;
  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

  const linesOf = Effect.fn("Reconcile.linesOf")(function* (orderId: string) {
    return yield* query(() =>
      db
        .select({
        variantId: orderItem.variantId,
        productId: orderItem.productId,
        quantity: orderItem.quantity,
        preorder: orderItem.preorder,
      })
        .from(orderItem)
        .where(eq(orderItem.orderId, orderId)),
    );
  });

  const release = Effect.fn("Reconcile.release")(function* (orderId: string) {
    const lines = yield* linesOf(orderId);
    yield* Effect.orDie(
      database.run([
        ...releaseStatements(db, orderId, lines, now),
        db
          .update(customerOrder)
          .set({ status: "cancelled", updatedAt: now })
          .where(eq(customerOrder.id, orderId)) as unknown as DbStatement,
      ]),
    );
  });

  // ── Orphans: stock held, no session, past the grace window ─────────────────
  const orphans = yield* query(() =>
    db
      .select({ id: customerOrder.id })
      .from(customerOrder)
      .where(
        and(
          isNull(customerOrder.sessionId),
          eq(customerOrder.status, "pending"),
          lt(customerOrder.createdAt, now - ORPHAN_GRACE_MS),
        ),
      ),
  );

  let orphansReleased = 0;
  for (const orphan of orphans) {
    yield* release(orphan.id);
    orphansReleased += 1;
  }

  // ── Stale-attached: session expired, no terminal payment status ────────────
  const stale = yield* query(() =>
    db
      .select({ id: customerOrder.id, sessionId: customerOrder.sessionId })
      .from(customerOrder)
      .where(
        and(
          isNotNull(customerOrder.sessionId),
          eq(customerOrder.status, "pending"),
          eq(customerOrder.paymentStatus, "unpaid"),
          lt(customerOrder.sessionExpiresAt, now),
        ),
      ),
  );

  let healed = 0;
  let released = 0;
  let inconclusive = 0;

  for (const order of stale) {
    if (!order.sessionId) continue;

    /**
     * A failed lookup PROVES NOTHING — the payment may have just landed — so it
     * is mapped to `null` and counted as inconclusive rather than treated as
     * evidence the order can be released.
     */
    const session = yield* payments.retrieve(order.sessionId).pipe(
      Effect.catchTag("PaymentsUnavailable", () => Effect.succeed(null)),
    );
    if (session === null) {
      inconclusive += 1;
      continue;
    }

    /** Complete AND settled: the buyer was charged and the event was lost. Heal. */
    if (
      session.status === "complete" &&
      (session.paymentStatus === "paid" || session.paymentStatus === "no_payment_required")
    ) {
      yield* Effect.orDie(
        database.run([
          db
            .update(customerOrder)
            .set({ status: "paid", paymentStatus: "paid", updatedAt: now })
            .where(eq(customerOrder.id, order.id)) as unknown as DbStatement,
        ]),
      );
      healed += 1;
      continue;
    }

    /** Complete but still settling — leave it for its event. */
    if (session.status === "complete") {
      inconclusive += 1;
      continue;
    }

    /**
     * Still open: release ONLY once the provider confirms it can no longer be
     * paid. A refused `expire` means the session went complete underneath us,
     * so the order is left alone.
     */
    if (session.status === "open") {
      const expired = yield* payments.expire(session.id).pipe(
        Effect.as(true),
        Effect.catchTag("PaymentsUnavailable", () => Effect.succeed(false)),
      );
      if (!expired) {
        inconclusive += 1;
        continue;
      }
    }

    yield* release(order.id);
    released += 1;
  }

  return { orphansReleased, healed, released, inconclusive };
});
