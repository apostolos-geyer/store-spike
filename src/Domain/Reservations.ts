/**
 * Pricing and stock reservation.
 *
 * PRICE AUTHORITY. A price crosses into an order only from the product's ACTIVE
 * RELEASE — never from the draft and never from the client. A product with no
 * active release contributes NO pricing row and fails closed as
 * `product_unavailable`. Once written, an order line's `unitPriceCents` is a
 * permanent snapshot.
 *
 * RESERVATION CONCURRENCY. Reserving stock is a SQL-guarded conditional UPDATE
 * whose `meta.changes` (0 or 1) is the only trustworthy signal that a line
 * actually reserved. A `Math.max(0, stock - qty)` computed in JS off a stale
 * SELECT lets two concurrent requests both win the last unit.
 *
 * D1's batch aborts on a statement ERROR but NOT on a zero-row UPDATE — a guard
 * matching nothing is a no-op, not a failure. So a failed guard is compensated
 * EXPLICITLY: re-increment the lines that did decrement and remove the order
 * rows that committed beside them. That is measured, not assumed — see the
 * atomicity test.
 *
 * Reservation is NOT idempotent. Each call decrements; callers own not invoking
 * it twice for the same intent, which is what `Audit.command` guarantees.
 */
import { eq, inArray, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";

import {
  query,
  type ClassicDb,
  type DbStatement,
  type StatementResult,
} from "../Services/Database.ts";
import { customerOrder, orderItem, product, productRelease, productVariant } from "./Schema.ts";

export interface CartItem {
  readonly variantId: string;
  readonly quantity: number;
}

export interface OrderLine {
  readonly variantId: string;
  readonly productId: string;
  readonly title: string;
  readonly size: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  /**
   * Sold against a manufacturing run rather than a shelf.
   *
   * Carried on the line rather than looked up later because it must be SNAPSHOT:
   * the variant flips to `stock` the day the run lands, and what a buyer was told
   * when they paid cannot be allowed to change with it.
   */
  readonly preorder: boolean;
  readonly expectedShipAt: number | null;
}

/**
 * What this store can price, and nothing more.
 *
 * There is no `shippingCents` and no `totalCents` here any more, and their
 * absence is the design: shipping is a rate the buyer picks at checkout and tax
 * is computed from the address they type there. Neither is knowable at this
 * point, so neither is guessed. The settled payment reports both.
 */
export type Totals =
  | {
      readonly ok: true;
      readonly lines: readonly OrderLine[];
      readonly subtotalCents: number;
    }
  | { readonly ok: false; readonly error: string; readonly message?: string };

interface PricingVariant {
  readonly id: string;
  readonly productId: string;
  readonly size: string;
  readonly stock: number;
  readonly mode: string;
  readonly expectedShipAt: number | null;
}

interface PricingProduct {
  readonly id: string;
  readonly title: string;
  readonly priceCents: number;
  readonly status: string;
  readonly preorderCap: number | null;
  readonly preorderClaimed: number;
}

/**
 * A pre-order claim against ONE product's run, summed across its variants.
 *
 * The cap is a product-level fact, so a cart holding two sizes of the same shirt
 * claims two places against one run — and must be guarded once, not twice.
 */
export interface RunClaim {
  readonly productId: string;
  readonly title: string;
  readonly quantity: number;
}

/** Sum the pre-order lines per product. Empty when nothing in the cart is one. */
export const runClaims = (lines: readonly OrderLine[]): readonly RunClaim[] => {
  const byProduct = new Map<string, RunClaim>();
  for (const line of lines) {
    if (!line.preorder) continue;
    const existing = byProduct.get(line.productId);
    byProduct.set(line.productId, {
      productId: line.productId,
      title: line.title,
      quantity: (existing?.quantity ?? 0) + line.quantity,
    });
  }
  return [...byProduct.values()];
};

/**
 * Validate a cart against the authoritative rows and compute totals. Money is
 * only added and multiplied by integer quantities here, never divided.
 *
 * A pure function of its three arguments — no database, no clock — so every
 * pricing rule is testable without infrastructure.
 */
export const computeTotals = (
  items: readonly CartItem[],
  variants: readonly PricingVariant[],
  products: readonly PricingProduct[],
): Totals => {
  if (items.length === 0) return { ok: false, error: "empty_cart" };

  const productById = new Map(products.map((entry) => [entry.id, entry]));
  const variantById = new Map(variants.map((entry) => [entry.id, entry]));

  let subtotalCents = 0;
  const lines: OrderLine[] = [];

  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return { ok: false, error: "invalid_quantity", message: item.variantId };
    }
    const variant = variantById.get(item.variantId);
    if (!variant) return { ok: false, error: "variant_not_found", message: item.variantId };
    const owner = productById.get(variant.productId);
    if (!owner || owner.status !== "active") {
      return { ok: false, error: "product_unavailable", message: variant.productId };
    }
    /**
     * ONE CHECK FOR BOTH MODES. `stock` is units on a shelf for a stocked
     * variant and remaining places in a run for a pre-order, and running out
     * means the same thing either way — there is nothing left to sell. The
     * message differs so a buyer is told which it was.
     */
    if (variant.stock < item.quantity) {
      return {
        ok: false,
        error: variant.mode === "preorder" ? "preorder_full" : "out_of_stock",
        message: `${owner.title} (${variant.size})`,
      };
    }
    subtotalCents += owner.priceCents * item.quantity;
    lines.push({
      variantId: variant.id,
      productId: owner.id,
      title: owner.title,
      size: variant.size,
      unitPriceCents: owner.priceCents,
      quantity: item.quantity,
      preorder: variant.mode === "preorder",
      expectedShipAt: variant.expectedShipAt,
    });
  }

  return { ok: true, lines, subtotalCents };
};

/**
 * Load the authoritative pricing inputs: live size and stock from the variant
 * rows, and each product's title and price from its ACTIVE RELEASE. The draft
 * copy and price are never read.
 */
export const loadPricingInputs = Effect.fn("Reservations.loadPricingInputs")(function* (
  db: ClassicDb,
  variantIds: readonly string[],
) {
  if (variantIds.length === 0) {
    return { variants: [] as PricingVariant[], products: [] as PricingProduct[] };
  }

  const variants = yield* query(() =>
    db
      .select({
        id: productVariant.id,
        productId: productVariant.productId,
        size: productVariant.size,
        stock: productVariant.stock,
        mode: productVariant.mode,
        expectedShipAt: productVariant.expectedShipAt,
      })
      .from(productVariant)
      .where(inArray(productVariant.id, [...variantIds])),
  );

  const productIds = [...new Set(variants.map((variant) => variant.productId))];
  if (productIds.length === 0) return { variants, products: [] as PricingProduct[] };

  const products = yield* query(() =>
    db
      .select({
        id: product.id,
        title: productRelease.title,
        priceCents: productRelease.priceCents,
        status: product.status,
        preorderCap: product.preorderCap,
        preorderClaimed: product.preorderClaimed,
      })
      .from(product)
      // INNER join through the active release: a product without one yields no
      // pricing row at all, so the cart fails closed.
      .innerJoin(productRelease, eq(productRelease.id, product.activeReleaseId))
      .where(inArray(product.id, productIds)),
  );

  return { variants, products };
});

/** The guarded decrement for one line. */
export const guardStatement = (db: ClassicDb, line: OrderLine): DbStatement =>
  db
    .update(productVariant)
    .set({ stock: sql`${productVariant.stock} - ${line.quantity}` })
    .where(
      sql`${productVariant.id} = ${line.variantId} and ${productVariant.stock} >= ${line.quantity}`,
    ) as unknown as DbStatement;

/**
 * The guarded claim against a product's RUN.
 *
 * Identical compare-and-set to the variant guard, one level up: it matches no
 * row when the run is full, and a zero-row UPDATE does not abort the batch — so
 * the result is inspected, never trusted. A product with a `null` cap is not
 * sold as a pre-order and the guard matches nothing, which is why a line can
 * only be marked `preorder` if its variant says so.
 */
export const runGuardStatement = (db: ClassicDb, claim: RunClaim): DbStatement =>
  db
    .update(product)
    .set({ preorderClaimed: sql`${product.preorderClaimed} + ${claim.quantity}` })
    .where(
      sql`${product.id} = ${claim.productId} and ${product.preorderCap} is not null and ${product.preorderClaimed} + ${claim.quantity} <= ${product.preorderCap}`,
    ) as unknown as DbStatement;

/** Undo a decrement that committed beside a guard which matched nothing. */
export const compensateStatement = (db: ClassicDb, line: OrderLine): DbStatement =>
  db
    .update(productVariant)
    .set({ stock: sql`${productVariant.stock} + ${line.quantity}` })
    .where(eq(productVariant.id, line.variantId)) as unknown as DbStatement;

/** Undo a run claim that committed beside a guard which matched nothing. */
export const compensateRunStatement = (db: ClassicDb, claim: RunClaim): DbStatement =>
  db
    .update(product)
    .set({ preorderClaimed: sql`max(0, ${product.preorderClaimed} - ${claim.quantity})` })
    .where(eq(product.id, claim.productId)) as unknown as DbStatement;

/** Remove the order rows that committed alongside a failed reservation. */
export const orderRollbackStatements = (
  db: ClassicDb,
  orderId: string,
): readonly DbStatement[] => [
  db.delete(orderItem).where(eq(orderItem.orderId, orderId)) as unknown as DbStatement,
  db.delete(customerOrder).where(eq(customerOrder.id, orderId)) as unknown as DbStatement,
];

/**
 * Classify a batch result: which guards matched, and which line failed first.
 * Pure, so the classification is testable without a database.
 */
export const classifyGuards = (
  lines: readonly OrderLine[],
  claims: readonly RunClaim[],
  results: readonly StatementResult[],
): {
  succeeded: OrderLine[];
  firstFailing: OrderLine | undefined;
  claimed: RunClaim[];
  firstFullRun: RunClaim | undefined;
} => {
  const won = (result: StatementResult | undefined) => (result?.meta?.changes ?? 0) === 1;

  const succeeded: OrderLine[] = [];
  let firstFailing: OrderLine | undefined;
  results.slice(0, lines.length).forEach((result, index) => {
    const line = lines[index];
    if (!line) return;
    if (won(result)) succeeded.push(line);
    else if (!firstFailing) firstFailing = line;
  });

  /**
   * The run guards were appended AFTER the line guards, so they occupy the next
   * `claims.length` results. Positional rather than keyed because that is the
   * only correspondence D1's batch gives back.
   */
  const claimed: RunClaim[] = [];
  let firstFullRun: RunClaim | undefined;
  results.slice(lines.length, lines.length + claims.length).forEach((result, index) => {
    const claim = claims[index];
    if (!claim) return;
    if (won(result)) claimed.push(claim);
    else if (!firstFullRun) firstFullRun = claim;
  });

  return { succeeded, firstFailing, claimed, firstFullRun };
};

/**
 * Restore stock for every line of an order — the reconcile sweep's release path.
 *
 * A RELATIVE increment, never a value computed in JS off a stale read: the sweep
 * runs concurrently with live checkouts, so `stock = <number>` would clobber
 * whatever happened in between.
 */
export interface RestorableLine {
  readonly variantId: string;
  readonly productId: string;
  readonly quantity: number;
  /** Snapshot from the order line, NOT the variant's current mode. */
  readonly preorder: boolean;
}

export const restoreStatements = (
  db: ClassicDb,
  lines: readonly RestorableLine[],
): readonly DbStatement[] => [
  ...lines.map(
    (line) =>
      db
        .update(productVariant)
        .set({ stock: sql`${productVariant.stock} + ${line.quantity}` })
        .where(eq(productVariant.id, line.variantId)) as unknown as DbStatement,
  ),
  /**
   * AND THE RUN PLACE. A pre-order that expires or is refunded must hand its
   * place back, or the run silently shrinks: the cap still reads 200, the
   * counter still reads 200, and nobody can buy the twelve shirts that were
   * abandoned. Because the counter is what the guard tests, that loss is
   * permanent and invisible.
   *
   * Keyed off the ORDER LINE's snapshot rather than the variant's current mode,
   * so flipping a variant to `stock` when the run lands cannot orphan the claims
   * placed while it was a pre-order.
   */
  ...runClaims(
    lines.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      title: "",
      size: "",
      unitPriceCents: 0,
      quantity: line.quantity,
      preorder: line.preorder,
      expectedShipAt: null,
    })),
  ).map((claim) => compensateRunStatement(db, claim)),
];
