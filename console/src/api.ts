/**
 * The client half of the `/api` seam.
 *
 * Every call is a POST to one key in the Console worker's operations table.
 * There is no client-side schema here on purpose: the browser is the untrusted
 * side, so the checks that matter run in the worker, and duplicating them here
 * would only produce a second place to drift.
 */

/**
 * The domain's own result envelope. Never thrown — always a value.
 *
 * Module-local: the pages only ever see the unwrapped value or a thrown error,
 * so exporting this would widen the surface without a consumer.
 */
type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message?: string };

/**
 * A refusal the domain returned, as distinct from a transport failure.
 *
 * Also module-local, and deliberately so: the pages render `.message` and do
 * not discriminate on the type. Export it the moment one of them wants to treat
 * `out_of_stock` differently from a dropped connection — until then an exported
 * class nobody imports is a claim the code does not make.
 */
class Refused extends Error {
  constructor(
    readonly reason: string,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "Refused";
  }
}

/**
 * Call one operation and return whatever it produced.
 *
 * The worker wraps every response as `{ ok, value }`; `value` is the domain's
 * own payload, which for a mutation is itself a `DomainResult`. Unwrapping that
 * second envelope is {@link expect}'s job, because some operations (a timeline,
 * the provider name) have no domain result to unwrap.
 */
interface Envelope {
  value?: unknown;
  error?: string;
  detail?: string;
}

export const call = async <T>(operation: string, payload?: unknown): Promise<T> => {
  const response = await fetch(`/api/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

  // A non-JSON body is itself the failure — an HTML error page, say — so it
  // collapses to an empty envelope and the status carries the message.
  const body: Envelope = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.detail ?? body.error ?? `request failed (${response.status})`);
  }
  return body.value as T;
};

/**
 * Call an operation whose payload is a `DomainResult`, and raise a refusal as an
 * error carrying the domain's own reason string — `out_of_stock`,
 * `revision_conflict`, `missing_media` — so the page renders what the server
 * actually said rather than a generic failure.
 */
export const expect = async <T>(operation: string, payload?: unknown): Promise<T> => {
  const result = await call<DomainResult<T>>(operation, payload);
  if (!result.ok) throw new Refused(result.error, result.message);
  return result.value;
};

/**
 * A fresh retry key for one user intent.
 *
 * Held for the LIFETIME OF THE INTENT, not regenerated per attempt: that is
 * what makes a retry a replay rather than a second command. The worker
 * namespaces it by actor and action before it becomes a domain idempotency key.
 */
export const commandId = (): string => crypto.randomUUID();

export const money = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: "currency", currency: "CAD" });

export const when = (at: number | null): string =>
  at === null ? "—" : new Date(at).toLocaleString();

// ── Shapes the pages read. Structural, not authoritative — the worker owns the
//    contract; these exist so the components typecheck against something. ──────

export interface ProductDraft {
  productId: string;
  slug: string;
  revision: number;
  title: string;
  descriptionMarkdown: string | null;
  priceCents: number;
  status: "draft" | "active" | "unavailable" | "archived";
  activeVersion: string | null;
  updatedAt: number;
}

export interface Variant {
  id: string;
  size: string;
  sku: string;
  stock: number;
  mode: "stock" | "preorder";
  expectedShipAt: number | null;
  available: boolean;
}

export interface ProductDetail {
  draft: ProductDraft;
  preorder: { cap: number | null; claimed: number; remaining: number | null };
  releases: Array<{ id: string; version: string; publishedAt: number }>;
  variants: Variant[];
  media: Array<{ id: string; alt: string; role: string; href: string; position: number }>;
}

export interface OrderSummary {
  orderNumber: string;
  email: string;
  shipName: string | null;
  totalCents: number;
  status: string;
  paymentStatus: string;
  createdAt: number;
}

export interface OrderDetail extends OrderSummary {
  orderId: string;
  sessionId: string | null;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  currency: string;
  refundedCents: number;
  carrier: string | null;
  trackingNumber: string | null;
  fulfillmentNote: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  shipping: { name: string; line1: string; city: string; region: string; postal: string } | null;
  items: Array<{
    title: string;
    size: string;
    unitPriceCents: number;
    quantity: number;
    preorder: boolean;
  }>;
}

export interface TimelineEntry {
  at: number;
  source: "operator" | "customer" | "payment";
  action: string;
  actor: string | null;
  outcome: string;
  detail: string | null;
}

export interface StorefrontCard {
  slug: string;
  title: string;
  priceCents: number;
  version: string;
  coverHref: string | null;
}

export interface StorefrontProduct {
  slug: string;
  title: string;
  descriptionMarkdown: string | null;
  priceCents: number;
  version: string;
  media: Array<{ href: string; alt: string; role: string }>;
  variants: Array<{ id: string; size: string; available: boolean }>;
}

export interface PlacedOrder {
  orderNumber: string;
  subtotalCents: number;
  sessionId: string;
  checkoutUrl: string | null;
}

export interface CustomerOrder {
  orderNumber: string;
  status: string;
  paymentStatus: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: number | null;
  items: Array<{
    title: string;
    size: string;
    unitPriceCents: number;
    quantity: number;
    preorder: boolean;
    expectedShipAt: number | null;
  }>;
}
