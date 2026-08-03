/**
 * CATALOG — the storefront. Everything a shopper's browser touches.
 *
 * Reads are plain HTTP because they are cacheable, linkable and have no payload
 * to decode: `/products`, `/products/:slug`, `/media/:id`. The two things a
 * shopper WRITES — placing an order, looking up their own — go through
 * `StorefrontRpcs` at `/rpc`, because those do have payloads, and a payload
 * arriving from a browser has to be decoded before a handler sees it. That is
 * the same trust-boundary argument `Edge.ts` makes for the operator console; the
 * two surfaces are separate workers so a mistake in one cannot reach the other.
 *
 * IT BINDS COMMERCE, WHICH IS A REAL COST. A binding grants the whole Commerce
 * surface, so a routing bug here is bounded only by the fact that nothing in
 * this file forwards anything except the two procedures named below. There is no
 * generic passthrough, and there must never be one.
 *
 * Everything it serves comes from a product's ACTIVE RELEASE. A draft edit
 * changes nothing here until it is published.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { customerCall } from "../Domain/Contracts.ts";
import * as MediaDomain from "../Domain/Media.ts";
import * as Storefront from "../Domain/Storefront.ts";
import {
  CartRefused,
  OrderNotFound,
  StorefrontRpcs,
} from "../Domain/Storefront.rpc.ts";
import { handles, readCapabilities } from "../Runtime.ts";
import { Database } from "../Services/Database.ts";
import CommerceWorker from "./Commerce.ts";

export default class CatalogWorker extends Cloudflare.Worker<CatalogWorker>()(
  "Catalog",
  { main: import.meta.url },
  Effect.gen(function* () {
    const resolved = yield* handles;
    const layer = readCapabilities(resolved);
    const commerce = yield* Cloudflare.Workers.bindWorker(CommerceWorker);

    const handlers = StorefrontRpcs.toLayer({
      /**
       * The same active-release reads the GET routes below answer, now declared
       * so a client shares the type instead of restating it.
       */
      listStorefront: () =>
        Effect.provide(
          Effect.flatMap(Database, (database) => Storefront.listActiveProducts(database.db)),
          layer,
        ),

      getStorefrontProduct: ({ slug }) =>
        Effect.provide(
          Effect.flatMap(Database, (database) =>
            Storefront.getActiveProductBySlug(database.db, slug),
          ),
          layer,
        ),

      placeOrder: ({ commandId, email, destination, items }) =>
        Effect.flatMap(
          commerce.placeOrder(
            customerCall(email, commandId, {
              email,
              // The subject doubles as the customer id: a guest order still
              // needs a stable owner, and this is the only one on offer.
              customerId: `customer:${email.trim().toLowerCase()}`,
              destination,
              items: items.map((item) => ({ ...item })),
            }),
          ),
          (result) =>
            result.ok
              ? Effect.succeed(result.value)
              : Effect.fail(new CartRefused({ reason: result.error, detail: result.message })),
        ),

      getMyOrder: ({ orderNumber, email }) =>
        Effect.flatMap(commerce.getCustomerOrder(orderNumber, email), (result) =>
          result.ok
            ? Effect.succeed({
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
                /**
                 * PROJECTED, not forwarded. The operator view carries product
                 * and variant ids, the internal customer id and a fulfilment
                 * note; a customer gets what is on their receipt and nothing
                 * else. Passing the row through would leak all four.
                 */
                items: result.value.items.map((item) => ({
                  title: item.title,
                  size: item.size,
                  unitPriceCents: item.unitPriceCents,
                  quantity: item.quantity,
                  preorder: item.preorder,
                  expectedShipAt: item.expectedShipAt,
                })),
              })
            : Effect.fail(new OrderNotFound({ orderNumber })),
        ),
    });

    /**
     * The read routes, and ONLY the read routes, behind a catch-all 500.
     *
     * The RPC route is deliberately outside it. `RpcServer` signals the end of a
     * response stream by failing with an internal `Done` cause, so a
     * `catchCause` wrapped around it converts every successful RPC call into a
     * 500 with an empty body — which is exactly what it did, and it looks like a
     * routing bug rather than an interception one.
     */
    const reads = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://catalog").pathname;
      const segments = path.split("/").filter(Boolean);

      {
        if (request.method === "GET" && path === "/products") {
          const database = yield* Database;
          const products = yield* Storefront.listActiveProducts(database.db);
          return yield* HttpServerResponse.json({ products });
        }

        if (request.method === "GET" && segments[0] === "products" && segments.length === 2) {
          const database = yield* Database;
          const found = yield* Storefront.getActiveProductBySlug(
            database.db,
            segments[1] as string,
          );
          return found
            ? yield* HttpServerResponse.json({ product: found })
            : yield* HttpServerResponse.json({ error: "not_found" }, { status: 404 });
        }

        /**
         * Media is streamed through this worker rather than served from a public
         * bucket URL, so the R2 key never leaves the system and access stays
         * revocable.
         */
        if (request.method === "GET" && segments[0] === "media" && segments.length === 2) {
          const database = yield* Database;
          const blob = yield* MediaDomain.openMedia(database.db, segments[1] as string);
          if (!blob) return yield* HttpServerResponse.json({ error: "not_found" }, { status: 404 });
          const bytes = Stream.fromReadableStream({
            evaluate: () => blob.body,
            onError: (error) => error,
          });
          return HttpServerResponse.stream(bytes, {
            headers: {
              "content-type": blob.contentType,
              // Immutable: a media id names exactly one set of bytes forever.
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        }

        return yield* HttpServerResponse.json({ error: "not_found", path }, { status: 404 });
      }
    }).pipe(
      Effect.provide(layer),
      /**
       * LOGGED, NOT RETURNED. `query` wraps D1 in `Effect.promise`, so a database
       * failure arrives here as a defect whose message is the raw driver text —
       * table and column names included. That is free reconnaissance for an
       * anonymous caller and tells a legitimate one nothing they can act on.
       */
      Effect.catchCause((cause) =>
        Effect.flatMap(Effect.logError("store.request.failed", cause), () =>
          HttpServerResponse.json({ error: "internal" }, { status: 500 }),
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        /**
         * Trailing slash stripped before matching. `RpcClient.layerProtocolHttp`
         * posts to `<url>/`, so a route written as `/rpc` never matches its own
         * client — and the 404 surfaces at the caller as "empty HTTP response
         * from RPC server", which points nowhere near the routing table.
         */
        const path =
          new URL(request.url, "http://catalog").pathname.replace(/\/+$/, "") || "/";

        /**
         * Built INSIDE the request, not at init: the handlers call Commerce over
         * a binding and those calls require `RuntimeContext`, a per-event
         * service. `HttpEffect` admits it, so this needs no discharge — the same
         * shape `Edge.ts` uses for the operator group.
         */
        if (path === "/rpc") {
          const server = yield* RpcServer.toHttpEffect(StorefrontRpcs).pipe(
            Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
          );
          return yield* server;
        }

        return yield* reads;
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
      ),
    ),
  ),
) {}
