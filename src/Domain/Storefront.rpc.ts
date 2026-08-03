/**
 * The CUSTOMER surface.
 *
 * A separate contract from `Rpc.ts` on purpose. The two have different callers,
 * different trust, and different reasons to change:
 *
 *   OperatorRpcs   — the console. Bound, trusted, carries `meta.actor`, every
 *                    mutation audited and idempotency-keyed.
 *   StorefrontRpcs — the shop. Public, anonymous, and the ONLY writes it can
 *                    reach are "buy this cart" and nothing else.
 *
 * Collapsing them would mean one surface where a missing authorization check
 * exposes the whole order book rather than one checkout call. They are separate
 * because the blast radius of a mistake is different.
 */
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export class CartRefused extends Schema.TaggedErrorClass<CartRefused>()("CartRefused", {
  reason: Schema.Literals([
    "empty_cart",
    "invalid_quantity",
    "variant_not_found",
    "product_unavailable",
    "out_of_stock",
    /** The run is fully subscribed. Distinct from a shelf being empty. */
    "preorder_full",
    "payments_unavailable",
  ]),
  detail: Schema.optional(Schema.String),
}) {}

export class OrderNotFound extends Schema.TaggedErrorClass<OrderNotFound>()("OrderNotFound", {
  orderNumber: Schema.String,
}) {}

/** Where a cart is going. Fixes the shipping rate and the address form. */
export const Destination = Schema.Literals(["CA", "US"]);

export const PlacedOrder = Schema.Struct({
  orderNumber: Schema.String,
  /**
   * LINE ITEMS ONLY, and named so a storefront cannot mistake it for a total.
   * Shipping and tax are added on the payment page — what the buyer is charged
   * is not known until they finish there.
   */
  subtotalCents: Schema.Number,
  sessionId: Schema.String,
  /**
   * Where to send the buyer. `null` when the deployment runs the fake provider,
   * which hosts no payment page — so a storefront must branch rather than
   * redirect blindly.
   */
  checkoutUrl: Schema.NullOr(Schema.String),
});

/** What a customer may see about their own order. Never the internal id. */
export const CustomerOrderView = Schema.Struct({
  orderNumber: Schema.String,
  status: Schema.Literals(["pending", "paid", "shipped", "delivered", "cancelled"]),
  paymentStatus: Schema.String,
  /**
   * The receipt. All four are zero until the order is paid, because shipping
   * and tax do not exist before then — a storefront showing an unpaid order
   * should render `subtotalCents` and say so.
   */
  subtotalCents: Schema.Number,
  shippingCents: Schema.Number,
  taxCents: Schema.Number,
  totalCents: Schema.Number,
  currency: Schema.String,
  carrier: Schema.NullOr(Schema.String),
  trackingNumber: Schema.NullOr(Schema.String),
  shippedAt: Schema.NullOr(Schema.Number),
  items: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      size: Schema.String,
      unitPriceCents: Schema.Number,
      quantity: Schema.Number,
      /** Told to the buyer before they paid, and kept afterwards. */
      preorder: Schema.Boolean,
      expectedShipAt: Schema.NullOr(Schema.Number),
    }),
  ),
});

export class StorefrontRpcs extends RpcGroup.make(
  /**
   * Buy a cart.
   *
   * `commandId` is the browser's retry key — a double-clicked Buy button must
   * not reserve stock twice, and this is what makes the retry a replay. Prices
   * are NOT accepted from the client; the active release is the authority.
   */
  Rpc.make("placeOrder", {
    payload: {
      commandId: Schema.String.check(Schema.isMinLength(1)),
      email: Schema.String.check(Schema.isMinLength(3)),
      /**
       * Chosen on the storefront BEFORE checkout opens, because it decides the
       * shipping rate and pins the address form to one country. Asking Stripe
       * to infer it from an address the buyer has not typed yet is not possible,
       * and offering both rates lets them pick the wrong one.
       */
      destination: Destination,
      items: Schema.Array(
        Schema.Struct({
          variantId: Schema.String,
          quantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        }),
      ),
    },
    success: PlacedOrder,
    error: CartRefused,
  }),

  /**
   * Look up an order the customer already placed.
   *
   * The EMAIL IS REQUIRED and it is not a convenience. Order numbers are derived
   * from an id tail and are quoted in emails, receipts and support threads — on
   * their own they are a guessable, shareable handle, so a lookup keyed on the
   * number alone hands the order book to anyone willing to enumerate. Requiring
   * the address the order was placed with is the weakest check that is still a
   * check, and it is what an anonymous storefront can actually ask for.
   *
   * A mismatch returns `OrderNotFound`, the same error as a nonexistent order,
   * so the response never confirms that a number is real.
   */
  Rpc.make("getMyOrder", {
    payload: { orderNumber: Schema.String, email: Schema.String },
    success: CustomerOrderView,
    error: OrderNotFound,
  }),
) {}
