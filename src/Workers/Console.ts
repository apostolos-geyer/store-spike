/**
 * CONSOLE — the worked example. One worker, both sides of the store, over a
 * SERVICE BINDING rather than HTTP.
 *
 * WHY THIS EXISTS. `Edge` and `Catalog` are stand-ins for frontends that do not
 * live in this repo: Edge for the Access-authenticated operator console,
 * Catalog for the storefront. Both speak schemaful Effect RPC over HTTP because
 * their caller is a BROWSER, and a payload crossing that boundary has to be
 * decoded before a handler sees it. Neither is what a bound sibling should do.
 *
 * This worker is what a bound sibling actually looks like. It holds one binding
 * to Commerce and calls it as plain methods — `commerce.publishProduct(call)` —
 * with no schema, no serialization and no network hop: Cloudflare moves the
 * arguments by structured clone inside the account. That is the "schemaless RPC
 * over a binding" half of alchemy's guidance, and the reason Commerce carries
 * `url: false`.
 *
 * IT SERVES A BROWSER TOO, so it does not escape the decode problem — it
 * relocates it. `/api/*` is this worker's own trust boundary and the SPA is the
 * untrusted caller. What crosses it is deliberately small: a closed table of
 * operations, each naming exactly one Commerce method.
 *
 * THERE IS NO GENERIC PASSTHROUGH, and there must never be one — the same rule
 * `Catalog.ts` states for the same reason. A binding grants the WHOLE Commerce
 * surface, so the only thing standing between a stray request and
 * `deleteProduct` is that the table below does not contain a wildcard. Adding
 * one would hand an anonymous caller the entire order book and catalog.
 *
 * THE ACTOR IS A STAND-IN, exactly as it is on `Edge`. There is no identity in
 * this repo; the platform supplies Cloudflare Access on the operator side and a
 * user IdP on the customer side. Dropping this into the platform means replacing
 * `CONSOLE_ACTOR` with a session read — nothing else in this file changes.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { deriveIdempotencyKey, type OperatorActor, type OperatorCall } from "../Domain/Contracts.ts";
import CatalogWorker from "./Catalog.ts";
import CommerceWorker from "./Commerce.ts";
import SettlementWorker from "./Settlement.ts";

/** @see `Edge.ts` — the same stand-in, for the same reason. */
const CONSOLE_ACTOR: OperatorActor = {
  sub: "operator:console",
  email: "operator@console.local",
};

/**
 * Build the envelope Commerce expects.
 *
 * The browser supplies only `commandId`; the key it becomes is namespaced by
 * actor and action here, server-side, so a client cannot assert an identity by
 * choosing one. Same construction as `Edge.ts`.
 */
const envelope = <T>(action: string, commandId: string, input: T): OperatorCall<T> => ({
  input,
  meta: {
    actor: CONSOLE_ACTOR,
    requestId: commandId,
    idempotencyKey: deriveIdempotencyKey(CONSOLE_ACTOR.sub, action, commandId),
  },
});

/** Reads carry no command id — there is nothing to replay. */
const readEnvelope = <T>(action: string, input: T): OperatorCall<T> =>
  envelope(action, `read:${action}`, input);

/**
 * A guest checkout's envelope, keyed on the buyer's address.
 *
 * The address is the only stable thing an anonymous shopper supplies, and the
 * idempotency key is derived from it — so two browsers that mint the same
 * `commandId` do not collide, and one shopper double-clicking Buy does. Under a
 * real user IdP this becomes the session subject and the dedup identity changes
 * with it; that is a behavioural change, not a refactor.
 */
const customerCall = <T>(email: string, commandId: string, input: T): OperatorCall<T> => {
  const sub = `customer:${email.trim().toLowerCase()}`;
  return {
    input,
    meta: {
      actor: { sub, email },
      requestId: commandId,
      idempotencyKey: deriveIdempotencyKey(sub, "placeOrder", commandId),
    },
  };
};

/** The JSON body of an `/api` call, after the shape checks below. */
type Payload = Record<string, unknown>;

/**
 * One entry in the operations table.
 *
 * `RuntimeContext` is the requirement every binding call carries — it is a
 * PER-EVENT service, which is why the table is built inside the init closure
 * but only ever invoked inside a request.
 *
 * The shape helpers below THROW rather than returning a result, and that is
 * deliberate: they run while the arguments are being extracted, before the
 * returned Effect has started, so a plain `try` around the call separates a
 * malformed request from a failure inside Commerce. See the handler.
 */
type Operation = (payload: Payload) => Effect.Effect<unknown, never, RuntimeContext>;

const str = (payload: Payload, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
};

const optionalStr = (payload: Payload, key: string): string | undefined => {
  const value = payload[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
};

const num = (payload: Payload, key: string): number => {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
};

const optionalNum = (payload: Payload, key: string): number | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  return num(payload, key);
};

export default class ConsoleWorker extends Cloudflare.Worker<ConsoleWorker>()(
  "Console",
  {
    main: import.meta.url,
    /**
     * The built SPA, served straight from Cloudflare's asset store.
     *
     * `notFoundHandling` makes every unmatched path fall back to `index.html`,
     * which is what a client-side router needs — TanStack Router owns `/operator`
     * and `/shop`, and a hard refresh on either must not 404.
     *
     * `runWorkerFirst` is the exception that keeps the API reachable. Without it
     * the SPA fallback would swallow `/api/*` too and every call would come back
     * as the HTML shell with a 200, which looks like a JSON parse bug and is not
     * one.
     *
     * The directory is produced by the `ConsoleBuild` command in `alchemy.run.ts`,
     * which is yielded BEFORE this worker so the output exists at upload time.
     */
    assets: {
      directory: "console/dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
  },
  Effect.gen(function* () {
    const commerce = yield* Cloudflare.Workers.bindWorker(CommerceWorker);
    const settlement = yield* Cloudflare.Workers.bindWorker(SettlementWorker);

    /**
     * Catalog is bound for ONE reason: `/media/:id`.
     *
     * `mediaHref` is a root-relative path, and the worker that serves it is
     * Catalog — media is streamed from R2 through a worker rather than from a
     * public bucket URL, so the key never leaves the system and access stays
     * revocable. On this origin that path is just another unmatched route, so
     * every `<img>` in the console resolved to the SPA shell instead of an
     * image.
     *
     * Proxying keeps the property that makes the indirection worth having: the
     * bytes still travel a binding, never the public internet, and Console
     * never learns the R2 key.
     */
    yield* Cloudflare.Workers.bindWorker(CatalogWorker);

    /**
     * The asset server, reached through the binding alchemy adds for us
     * (`Assets.local("ASSETS")`) whenever `assets` is set.
     *
     * WHY THE WORKER SERVES THE SPA ITSELF rather than letting the platform do
     * it. `runWorkerFirst` is an ALLOW-LIST in production — only `/api/*`
     * reaches this script and static files are served without ever waking it.
     * The local dev runtime does not read it that way:
     *
     *   invoke_user_worker_ahead_of_assets: worker.assets?.runWorkerFirst !== false
     *
     * An array is `!== false`, so under `alchemy dev` EVERY path arrives here —
     * including `/operator` and every hashed bundle. Without this fallback the
     * console 404s on itself locally while working when deployed, which is the
     * worst shape a bug can have.
     */
    const environment = yield* Cloudflare.Workers.WorkerEnvironment;
    const assets = environment["ASSETS"] as
      | { fetch(request: Request): Promise<Response> }
      | undefined;

    /**
     * The raw Catalog stub, read by binding name rather than through
     * `bindWorker`'s return value.
     *
     * `bindWorker` types a worker by its SHAPE, and Catalog's shape is
     * `{ fetch: HttpEffect }` — an Effect describing a handler, not a callable
     * that takes a Request. What the runtime puts in the environment is an
     * ordinary Cloudflare service stub, whose `fetch` is exactly what a proxy
     * needs. The `bindWorker` call above is still what DECLARES the binding;
     * this only reaches the value it produced.
     */
    const catalog = environment["Catalog"] as
      | { fetch(request: Request): Promise<Response> }
      | undefined;

    /**
     * THE CLOSED TABLE. Every key is one operation and names one binding call.
     *
     * A request for a key that is not here is a 404 — which is the whole
     * security property, so keep it a literal object and never compute keys
     * into it.
     */
    const operations: Record<string, Operation> = {
      // ── Operator: catalog lifecycle ────────────────────────────────────────
      listProducts: (p) =>
        commerce.listProducts(
          readEnvelope("listProducts", {
            status: optionalStr(p, "status") as never,
            limit: optionalNum(p, "limit"),
            cursor: optionalStr(p, "cursor"),
          }),
        ),

      getProduct: (p) =>
        commerce.getProduct(readEnvelope("getProduct", { productId: str(p, "productId") })),

      createProduct: (p) =>
        commerce.createProduct(
          envelope("createProduct", str(p, "commandId"), {
            slug: str(p, "slug"),
            title: str(p, "title"),
            descriptionMarkdown: optionalStr(p, "descriptionMarkdown") ?? null,
            priceCents: num(p, "priceCents"),
          }),
        ),

      saveProductDraft: (p) =>
        commerce.saveProductDraft(
          envelope("saveProductDraft", str(p, "commandId"), {
            productId: str(p, "productId"),
            expectedRevision: num(p, "expectedRevision"),
            title: optionalStr(p, "title"),
            descriptionMarkdown: optionalStr(p, "descriptionMarkdown") ?? null,
            priceCents: optionalNum(p, "priceCents"),
            slug: optionalStr(p, "slug"),
          }),
        ),

      /**
       * `bump` decides which part of the derived label moves. Omitting `version`
       * entirely is the normal path — see `core/versions.ts` for why supplying
       * one by hand is the exception rather than the rule.
       */
      publishProduct: (p) =>
        commerce.publishProduct(
          envelope("publishProduct", str(p, "commandId"), {
            productId: str(p, "productId"),
            expectedRevision: num(p, "expectedRevision"),
            version: optionalStr(p, "version"),
            bump: optionalStr(p, "bump") as never,
          }),
        ),

      setProductStatus: (p) =>
        commerce.setProductStatus(
          envelope("setProductStatus", str(p, "commandId"), {
            productId: str(p, "productId"),
            status: str(p, "status") as never,
          }),
        ),

      putVariant: (p) =>
        commerce.putVariant(
          envelope("putVariant", str(p, "commandId"), {
            productId: str(p, "productId"),
            variantId: optionalStr(p, "variantId"),
            size: str(p, "size"),
            sku: str(p, "sku"),
            stock: num(p, "stock"),
            mode: optionalStr(p, "mode") as never,
            expectedShipAt: optionalNum(p, "expectedShipAt") ?? null,
          }),
        ),

      setPreorderCap: (p) =>
        commerce.setPreorderCap(
          envelope("setPreorderCap", str(p, "commandId"), {
            productId: str(p, "productId"),
            cap: optionalNum(p, "cap") ?? null,
          }),
        ),

      adjustStock: (p) =>
        commerce.adjustStock(
          envelope("adjustStock", str(p, "commandId"), {
            variantId: str(p, "variantId"),
            delta: num(p, "delta"),
            reason: str(p, "reason"),
          }),
        ),

      /**
       * Media ingest. Publish REFUSES with `missing_media` until a product has a
       * cover, so without this the console can walk the lifecycle right up to
       * the gate and no further — which is where it stopped the first time it
       * was driven.
       *
       * Bytes arrive base64 because the JSON body has no binary frame. Decoded
       * here rather than in the page, so what crosses the binding is the
       * ArrayBuffer the domain actually wants.
       */
      ingestProductMedia: (p) => {
        const binary = atob(str(p, "bytesBase64"));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return commerce.ingestProductMedia(
          envelope("ingestProductMedia", str(p, "commandId"), {
            productId: str(p, "productId"),
            bytes: bytes.buffer,
            contentType: str(p, "contentType"),
            alt: str(p, "alt"),
            role: str(p, "role") as never,
          }),
        );
      },

      // ── Operator: orders ───────────────────────────────────────────────────
      listOrders: (p) =>
        commerce.listOrders(
          readEnvelope("listOrders", {
            status: optionalStr(p, "status") as never,
            limit: optionalNum(p, "limit"),
            cursor: optionalStr(p, "cursor"),
          }),
        ),

      getOrder: (p) =>
        commerce.getOrder(readEnvelope("getOrder", { orderNumber: str(p, "orderNumber") })),

      orderTimeline: (p) => commerce.orderTimeline(str(p, "orderNumber")),

      setOrderStatus: (p) =>
        commerce.setOrderStatus(
          envelope("setOrderStatus", str(p, "commandId"), {
            orderNumber: str(p, "orderNumber"),
            status: str(p, "status") as never,
          }),
        ),

      fulfillOrder: (p) =>
        commerce.fulfillOrder(
          envelope("fulfillOrder", str(p, "commandId"), {
            orderNumber: str(p, "orderNumber"),
            carrier: str(p, "carrier"),
            trackingNumber: str(p, "trackingNumber"),
            note: optionalStr(p, "note"),
          }),
        ),

      markDelivered: (p) =>
        commerce.markDelivered(
          envelope("markDelivered", str(p, "commandId"), {
            orderNumber: str(p, "orderNumber"),
          }),
        ),

      // ── Operator: settings and operations ──────────────────────────────────
      /** Which provider mints sessions here — the one config an operator cannot set. */
      paymentsProvider: () => commerce.paymentsProvider(),

      /**
       * Force the reconcile sweep. Normally the cron fires it; an operator
       * running it by hand is how a stuck order gets unstuck without waiting.
       */
      runSweep: () => settlement.sweepNow(),

      // ── Customer: the storefront ───────────────────────────────────────────
      /** The active-release read model, over the binding rather than Catalog's HTTP. */
      listStorefront: () => commerce.listStorefront(),

      getStorefrontProduct: (p) => commerce.getStorefrontProduct(str(p, "slug")),

      placeOrder: (p) => {
        const email = str(p, "email");
        const items = p["items"];
        if (!Array.isArray(items)) throw new Error("items must be an array");
        return commerce.placeOrder(
          customerCall(email, str(p, "commandId"), {
            email,
            customerId: `customer:${email.trim().toLowerCase()}`,
            destination: str(p, "destination") as never,
            items: items.map((item) => {
              const line = item as Payload;
              return { variantId: str(line, "variantId"), quantity: num(line, "quantity") };
            }),
          }),
        );
      },

      /**
       * PROJECTED, not forwarded. `getCustomerOrder` checks ownership but
       * returns the full operator row — product and variant ids, the internal
       * customer id, the fulfilment note. A customer gets what is on their
       * receipt, and the narrowing happens on this side of the binding so the
       * browser never receives the rest.
       */
      getMyOrder: (p) =>
        Effect.map(
          commerce.getCustomerOrder(str(p, "orderNumber"), str(p, "email")),
          (result) =>
            result.ok
              ? {
                  ok: true as const,
                  value: {
                    orderNumber: result.value.orderNumber,
                    status: result.value.status,
                    paymentStatus: result.value.paymentStatus,
                    subtotalCents: result.value.subtotalCents,
                    shippingCents: result.value.shippingCents,
                    taxCents: result.value.taxCents,
                    totalCents: result.value.totalCents,
                    currency: result.value.currency,
                    carrier: result.value.carrier,
                    trackingNumber: result.value.trackingNumber,
                    shippedAt: result.value.shippedAt,
                    items: result.value.items.map((item) => ({
                      title: item.title,
                      size: item.size,
                      unitPriceCents: item.unitPriceCents,
                      quantity: item.quantity,
                      preorder: item.preorder,
                      expectedShipAt: item.expectedShipAt,
                    })),
                  },
                }
              : result,
        ),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://console").pathname;

        /** Media belongs to Catalog. Forwarded over the binding, unchanged. */
        if (path.startsWith("/media/") && catalog) {
          const streamed = yield* Effect.promise(() =>
            catalog.fetch(request.source as Request),
          );
          return HttpServerResponse.fromWeb(streamed);
        }

        /**
         * Not an API call, so it is a page or a bundle: hand it to the asset
         * server untouched, which applies `notFoundHandling` and returns
         * `index.html` for a client-side route like `/operator`.
         */
        if (!path.startsWith("/api/")) {
          if (!assets) {
            return yield* HttpServerResponse.json({ error: "not_found", path }, { status: 404 });
          }
          const served = yield* Effect.promise(() =>
            assets.fetch(request.source as Request),
          );
          return HttpServerResponse.fromWeb(served);
        }

        const operation = operations[path.slice("/api/".length)];
        if (!operation) {
          return yield* HttpServerResponse.json({ error: "unknown_operation", path }, { status: 404 });
        }

        const payload = yield* Effect.orElseSucceed(
          Effect.map(request.json, (body) => (body ?? {}) as Payload),
          () => ({}) as Payload,
        );

        /**
         * TWO FAILURE KINDS, told apart by WHEN they happen.
         *
         * Extracting the arguments is synchronous and runs here, before the
         * returned Effect has started — so a `try` around this call catches
         * exactly a malformed request and nothing else. That earns a 400 naming
         * the field, which is information the caller can act on.
         *
         * A failure inside Commerce happens later, inside the Effect, and is
         * caught below. It is NOT returned: `query` wraps D1 in
         * `Effect.promise`, so a database failure arrives as a defect whose
         * message is the raw driver text — table and column names included.
         * That is free reconnaissance and tells a legitimate caller nothing.
         * Same rule as `Catalog.ts`.
         */
        let invoked: Effect.Effect<unknown, never, RuntimeContext>;
        try {
          invoked = operation(payload);
        } catch (error) {
          return yield* HttpServerResponse.json(
            {
              error: "bad_request",
              detail: error instanceof Error ? error.message : "invalid payload",
            },
            { status: 400 },
          );
        }

        return yield* invoked.pipe(
          Effect.flatMap((value) => HttpServerResponse.json({ ok: true, value })),
          Effect.catchCause((cause) =>
            Effect.flatMap(Effect.logError("console.request.failed", cause), () =>
              HttpServerResponse.json({ error: "internal" }, { status: 500 }),
            ),
          ),
        );
      }),
    };
  }),
) {}
