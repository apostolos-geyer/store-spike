/**
 * The store's domain contract: the call envelope, the result envelope, and every
 * DTO that crosses an RPC boundary. Nothing here touches D1 or Effect — it is
 * the vocabulary both sides of the binding agree on.
 *
 * Two rules govern the whole file:
 *
 *  - `meta` is minted SERVER-SIDE, after the edge has validated the caller. No
 *    browser-facing input type may carry `actor` or `meta`; the browser supplies
 *    an {@link OperatorCommandInput} whose `commandId` is namespaced by actor and
 *    action before it becomes a domain idempotency key, so a client cannot
 *    assert an identity by choosing a key.
 *  - No method ever throws for a domain condition. Success and typed domain
 *    errors are both {@link DomainResult} values.
 */

// ── Result envelope ──────────────────────────────────────────────────────────

export type DomainResult<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message?: string };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

/**
 * `err(code)` with no message OMITS the `message` key rather than setting it to
 * `undefined`. The whole result is JSON-serialised into the audit row and
 * replayed verbatim, so key presence has to be byte-stable across a replay.
 */
export const err = <E extends string>(
  error: E,
  message?: string,
): { ok: false; error: E; message?: string } =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };

// ── Call envelope ────────────────────────────────────────────────────────────

export interface OperatorActor {
  /** Stable subject from the edge's identity check. */
  sub: string;
  /** Verified email claim. */
  email: string;
}

export interface OperatorMeta {
  actor: OperatorActor;
  requestId: string;
  idempotencyKey: string;
}

export interface OperatorCall<T> {
  input: T;
  meta: OperatorMeta;
}

/** Browser-to-edge mutation shape. Never carries `actor` or `meta`. */
export interface OperatorCommandInput<T> {
  commandId: string;
  input: T;
}

/**
 * Namespace a browser command into a domain idempotency key. Retrying the same
 * UI command is stable without letting the browser choose the namespace — a
 * client that picked its own could suppress another actor's writes by colliding.
 */
export const deriveIdempotencyKey = (actorSub: string, action: string, commandId: string): string =>
  `${actorSub}:${action}:${commandId}`;

// ── Versioning ───────────────────────────────────────────────────────────────

/**
 * Canonical core SemVer: no `v` prefix, no leading zeros, no pre-release or
 * build metadata. A release publishes under an operator-supplied version of
 * exactly this shape.
 */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isValidVersion = (value: string): boolean => SEMVER_PATTERN.test(value);

/** Compare two core SemVers. Returns <0, 0, or >0. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

// ── Product DTOs ─────────────────────────────────────────────────────────────

export type ProductStatus = "draft" | "active" | "unavailable" | "archived";

/**
 * The OPERATOR view of a product: title, description, and price come from the
 * mutable draft, while `status` and `activeVersion` come from the identity row
 * and its active release. `updatedAt` is epoch milliseconds.
 */
export interface ProductDraftDTO {
  productId: string;
  slug: string;
  revision: number;
  title: string;
  descriptionMarkdown: string | null;
  priceCents: number;
  status: ProductStatus;
  activeVersion: string | null;
  updatedAt: number;
}

/** `available` is derived as `stock > 0`; it is never stored. */
export interface ProductVariantDTO {
  id: string;
  size: string;
  sku: string;
  stock: number;
  mode: "stock" | "preorder";
  expectedShipAt: number | null;
  available: boolean;
}

export type ProductMediaRole = "cover" | "gallery" | "evidence";

/**
 * `href` is the storage-neutral public path served by the Catalog worker. The
 * R2 object key never appears in a DTO, a URL, or an RPC type.
 */
export interface ProductMediaDTO {
  id: string;
  productId: string;
  alt: string;
  role: ProductMediaRole;
  position: number;
  href: string;
  contentType: string;
  size: number;
  sha256: string;
}

export type MediaMutationError =
  | "not_found"
  | "unsupported_type"
  | "invalid_size"
  | "invalid_role"
  | "storage_unavailable";

/** The public path a media id is served under. One spelling, used everywhere. */
export const mediaHref = (mediaId: string): string => `/media/${mediaId}`;

// ── Order DTOs ───────────────────────────────────────────────────────────────

export type OrderStatus = "pending" | "paid" | "shipped" | "delivered" | "cancelled";

/** Canada only: `country` is a compile-time literal, not a column read. */
export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postal: string;
  country: "CA";
  phone?: string;
}

/**
 * Orders are addressed by `orderNumber`; the internal row id never appears here.
 * `shipping` is all-or-nothing, mirroring the `ship_address_atomic` CHECK. Item
 * lines are the frozen purchase-time snapshot, never the live catalog.
 */
export interface OrderDetailDTO {
  /**
   * The internal id, and the OPERATOR view carries it on purpose.
   *
   * It is what checkout writes into the payment session's metadata, so it is the
   * only handle that joins an order to a provider dashboard. Without it, "this
   * Stripe session says storeOrderId=01J…" is unanswerable from the console. The
   * customer projection in `Storefront.rpc.ts` deliberately omits it.
   */
  orderId: string;
  orderNumber: string;
  /** The payment session holding this order, once checkout has attached one. */
  sessionId: string | null;
  customerId: string;
  /** The address the order was placed with — the customer's lookup key. */
  email: string;
  /** What the buyer gave the payment provider, when it differed. */
  receiptEmail: string | null;
  status: OrderStatus;
  paymentStatus: string;
  /** Ours: line items only. The one figure known before payment. */
  subtotalCents: number;
  /**
   * The provider's, and ZERO until the order is paid — shipping is a rate the
   * buyer picks and tax is assessed on the address they enter, so neither
   * exists at checkout. Read `subtotalCents` for an unpaid order.
   */
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  /** Where it ships. Chosen at checkout, confirmed by the settled address. */
  shipCountry: string;
  shipping: ShippingAddress | null;
  carrier: string | null;
  trackingNumber: string | null;
  fulfillmentNote: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  items: Array<{
    productId: string;
    variantId: string;
    title: string;
    size: string;
    unitPriceCents: number;
    quantity: number;
    /** Snapshot: this line was sold against a run, not a shelf. */
    preorder: boolean;
    expectedShipAt: number | null;
  }>;
}

export interface OrderListResult {
  orders: Array<{
    orderNumber: string;
    email: string;
    shipName: string | null;
    totalCents: number;
    status: OrderStatus;
    paymentStatus: string;
    createdAt: number;
  }>;
  nextCursor: string | null;
}

export type OrderMutationError =
  | "not_found"
  | "invalid_transition"
  | "payment_incomplete"
  | "already_fulfilled";

// ── Deletion protocol ────────────────────────────────────────────────────────

/**
 * The blast radius of a proposed delete, derived read-only. `deleteCounts` is
 * what goes; `retainedCounts` is what stays and must be shown anyway — the
 * retained ORDER counts are folded into the impact hash by design, so a new
 * order arriving between plan and confirm is drift and aborts the delete.
 */
export interface DeletionImpact {
  targetType: "product" | "product_release" | "product_variant" | "media";
  targetId: string;
  label: string;
  activeReleaseAffected: boolean;
  deleteCounts: Record<string, number>;
  retainedCounts: Record<string, number>;
  warnings: string[];
}

export interface DeletionPlan {
  impact: DeletionImpact;
  /** The plaintext token, returned once. Only its SHA-256 hash is persisted. */
  confirmationToken: string;
  expiresAt: number;
}

/**
 * The confirm call's ONLY input. The target is recovered from the intent row, so
 * an operator holding a valid token cannot redirect it at a different aggregate.
 */
export interface ConfirmDeletionInput {
  confirmationToken: string;
}

/**
 * Unknown token, wrong operator, and wrong action all collapse to
 * `deletion_plan_mismatch` deliberately: splitting them for a better error
 * message would leak whether a token exists and who owns it.
 */
export type DeletionError =
  | "not_found"
  | "deletion_plan_expired"
  | "deletion_plan_mismatch"
  | "deletion_already_executed"
  | "deletion_plan_drift";

// ── Method inputs ────────────────────────────────────────────────────────────

export interface ListProductsInput {
  status?: ProductStatus | "all";
  limit?: number;
  cursor?: string;
}

export interface ProductListPage {
  products: ProductDraftDTO[];
  nextCursor: string | null;
}

export interface ProductDetail {
  draft: ProductDraftDTO;
  /** The manufacturing run, if this product is sold as a pre-order. */
  preorder: PreorderRunDTO;
  releases: Array<{ id: string; version: string; publishedAt: number }>;
  variants: ProductVariantDTO[];
  media: ProductMediaDTO[];
}

export interface CreateProductInput {
  slug: string;
  title: string;
  descriptionMarkdown?: string | null;
  priceCents: number;
}

export interface SaveProductDraftInput {
  productId: string;
  expectedRevision: number;
  title?: string;
  descriptionMarkdown?: string | null;
  priceCents?: number;
  slug?: string;
}

export interface PublishProductInput {
  productId: string;
  expectedRevision: number;
  version: string;
}

export interface PutVariantInput {
  productId: string;
  variantId?: string;
  size: string;
  sku: string;
  /**
   * Units this variant may still sell — shelf stock, or places in a pre-order
   * run. Which one it means is {@link mode}.
   */
  stock: number;
  mode?: "stock" | "preorder";
  /** When a pre-order buyer should expect it. Meaningless for `stock`. */
  expectedShipAt?: number | null;
}

/** A product's manufacturing run: the cap, what is sold, what is left. */
export interface PreorderRunDTO {
  cap: number | null;
  claimed: number;
  remaining: number | null;
}

export interface SetPreorderCapInput {
  productId: string;
  /** `null` closes the run — every claim is refused until a cap is set again. */
  cap: number | null;
}

export interface AdjustStockInput {
  variantId: string;
  delta: number;
  /** Free-text operator justification. Audit metadata, stored nowhere else. */
  reason: string;
}

export interface ReorderProductMediaInput {
  productId: string;
  mediaIds: string[];
}

export interface OrderListInput {
  status?: OrderStatus | "all";
  limit?: number;
  cursor?: string;
}

export interface SetOrderStatusInput {
  orderNumber: string;
  /** The only two statuses an operator may set directly. */
  status: "paid" | "cancelled";
}

export interface FulfillOrderInput {
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
  note?: string;
}

export interface PlanProductReleaseDeletionInput {
  productId: string;
  releaseId: string;
  replacementReleaseId?: string | null;
}

/**
 * Media ingest. Unlike v2 this carries an `idempotencyKey`: v2's ingest was
 * off-contract with no key, so a retried upload created a duplicate image row.
 */
export interface IngestProductMediaInput {
  productId: string;
  bytes: ArrayBuffer;
  contentType: string;
  alt: string;
  role: ProductMediaRole;
}

// ── Storefront DTOs ──────────────────────────────────────────────────────────

/** What the storefront list shows. Sourced from the ACTIVE RELEASE, never the draft. */
export interface ProductCardDTO {
  slug: string;
  title: string;
  priceCents: number;
  version: string;
  coverHref: string | null;
}

export interface StorefrontProductDTO {
  slug: string;
  title: string;
  descriptionMarkdown: string | null;
  priceCents: number;
  version: string;
  media: Array<{ href: string; alt: string; role: ProductMediaRole }>;
  variants: Array<{ id: string; size: string; available: boolean }>;
}
