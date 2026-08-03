/**
 * COMMERCE — the operator backend. A pure backend: no routes, no SSR, no client
 * bundle, and no public URL.
 *
 * THE BINDING IS THE AUTHORIZATION BOUNDARY. This Worker performs no
 * authorization of its own: every method trusts `meta.actor` as already
 * validated at the edge. So it must be bound to a trusted caller ONLY —
 * exposing it on a public route, or to a storefront Worker, hands out
 * unauthenticated write access to the whole catalog and order book. `url: false`
 * is the first half of that; the wiring in the stack file is the other half.
 *
 * The capability layer is built ONCE in the init closure and provided to every
 * method. That is the whole argument for services over threaded arguments: v2's
 * `Shell.ts` — twenty-two one-line `lift` wrappers whose only job was passing
 * `db` along — has no equivalent here and nothing replaces it.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Catalog from "../Domain/Catalog.ts";
import type {
  AdjustStockInput,
  ConfirmDeletionInput,
  CreateProductInput,
  IngestProductMediaInput,
  ListProductsInput,
  OperatorCall,
  OrderListInput,
  PlanProductReleaseDeletionInput,
  ProductStatus,
  PublishProductInput,
  PutVariantInput,
  ReorderProductMediaInput,
  SaveProductDraftInput,
  SetOrderStatusInput,
  FulfillOrderInput,
} from "../Domain/Contracts.ts";
import * as Checkout from "../Domain/Checkout.ts";
import * as Deletion from "../Domain/Deletion.ts";
import * as Media from "../Domain/Media.ts";
import * as Orders from "../Domain/Orders.ts";
import * as Timeline from "../Domain/Timeline.ts";
import { capabilities, handles } from "../Runtime.ts";
import { Audit } from "../Services/Audit.ts";
import { Database } from "../Services/Database.ts";
import { Ids } from "../Services/Ids.ts";
import * as PaymentsProvider from "../Services/PaymentsProvider.ts";
import { environmentFor } from "../Services/StripeConfig.ts";

export default class CommerceWorker extends Cloudflare.Worker<CommerceWorker>()(
  "Commerce",
  { main: import.meta.url, url: false },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const resolved = yield* handles;

    /**
     * Checkout mints payment sessions, so Commerce resolves the SAME provider
     * Settlement does, through the same function. They must agree: a session
     * created by one provider cannot be settled by the other, and a stage that
     * checked out against Stripe while settling against the fake would take
     * money and never mark an order paid.
     */
    const environment = environmentFor(stage);
    const provider = yield* PaymentsProvider.resolve(environment);
    const layer = Layer.provideMerge(provider.layer, capabilities(resolved));

    /**
     * Every mutating method follows the same shape: resolve the services, run
     * the pure core, hand its outcome to `Audit.command`. The uniformity is the
     * point — no method can quietly skip the idempotency check, because the
     * commit only happens inside `command`.
     *
     * Reads bypass `command` entirely: they take no idempotency key and write no
     * event, because they have nothing to replay and nothing to record.
     */
    const surface = {
      listProducts: (call: OperatorCall<ListProductsInput>) =>
        Effect.gen(function* () {
          const database = yield* Database;
          const outcome = yield* Catalog.listProducts(database.db, call.input);
          return "failure" in outcome ? outcome.failure : outcome.response;
        }).pipe(Effect.provide(layer)),

      getProduct: (call: OperatorCall<{ productId: string }>) =>
        Effect.gen(function* () {
          const database = yield* Database;
          const outcome = yield* Catalog.getProduct(database.db, call.input.productId);
          return "failure" in outcome ? outcome.failure : outcome.response;
        }).pipe(Effect.provide(layer)),

      createProduct: (call: OperatorCall<CreateProductInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          const ids = yield* Ids;
          return yield* audit.command(
            "createProduct",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              const productId = yield* ids.next();
              return yield* Catalog.createProduct(
                database.db,
                call.input,
                call.meta.actor.sub,
                now,
                productId,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      saveProductDraft: (call: OperatorCall<SaveProductDraftInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "saveProductDraft",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Catalog.saveProductDraft(
                database.db,
                call.input,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      publishProduct: (call: OperatorCall<PublishProductInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          const ids = yield* Ids;
          return yield* audit.command(
            "publishProduct",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              const releaseId = yield* ids.next();
              return yield* Catalog.publishProduct(
                database.db,
                call.input,
                call.meta.actor.sub,
                now,
                releaseId,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      setProductStatus: (call: OperatorCall<{ productId: string; status: ProductStatus }>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "setProductStatus",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Catalog.setProductStatus(
                database.db,
                call.input.productId,
                call.input.status,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      putVariant: (call: OperatorCall<PutVariantInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          const ids = yield* Ids;
          return yield* audit.command(
            "putVariant",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              const variantId = yield* ids.next();
              return yield* Catalog.putVariant(database.db, call.input, now, variantId);
            }),
          );
        }).pipe(Effect.provide(layer)),

      setPreorderCap: (call: OperatorCall<{ productId: string; cap: number | null }>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "setPreorderCap",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Catalog.setPreorderCap(database.db, call.input, now);
            }),
          );
        }).pipe(Effect.provide(layer)),

      adjustStock: (call: OperatorCall<AdjustStockInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "adjustStock",
            call,
            Catalog.adjustStock(database.db, call.input),
          );
        }).pipe(Effect.provide(layer)),

      ingestProductMedia: (call: OperatorCall<IngestProductMediaInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          const ids = yield* Ids;
          return yield* audit.command(
            "ingestProductMedia",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              const imageId = yield* ids.next();
              return yield* Media.ingestProductMedia(database.db, call.input, now, imageId);
            }),
          );
        }).pipe(Effect.provide(layer)),

      reorderProductMedia: (call: OperatorCall<ReorderProductMediaInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "reorderProductMedia",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Catalog.reorderProductMedia(database.db, call.input, now);
            }),
          );
        }).pipe(Effect.provide(layer)),

      listOrders: (call: OperatorCall<OrderListInput>) =>
        Effect.gen(function* () {
          const database = yield* Database;
          const outcome = yield* Orders.listOrders(database.db, call.input);
          return "failure" in outcome ? outcome.failure : outcome.response;
        }).pipe(Effect.provide(layer)),

      getOrder: (call: OperatorCall<{ orderNumber: string }>) =>
        Effect.gen(function* () {
          const database = yield* Database;
          const outcome = yield* Orders.getOrder(database.db, call.input.orderNumber);
          return "failure" in outcome ? outcome.failure : outcome.response;
        }).pipe(Effect.provide(layer)),

      /** Both audit logs for one order, merged. A read — nothing is recorded. */
      orderTimeline: (orderNumber: string) =>
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* Timeline.orderTimeline(database.db, orderNumber);
        }).pipe(Effect.provide(layer)),

      setOrderStatus: (call: OperatorCall<SetOrderStatusInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "setOrderStatus",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Orders.setOrderStatus(database.db, call.input, now);
            }),
          );
        }).pipe(Effect.provide(layer)),

      fulfillOrder: (call: OperatorCall<FulfillOrderInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "fulfillOrder",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Orders.fulfillOrder(database.db, call.input, now);
            }),
          );
        }).pipe(Effect.provide(layer)),

      markDelivered: (call: OperatorCall<{ orderNumber: string }>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "markDelivered",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Orders.markDelivered(database.db, call.input.orderNumber, now);
            }),
          );
        }).pipe(Effect.provide(layer)),

      /**
       * The plan side is NOT idempotency-guarded: every call mints a fresh token
       * and a fresh intent row. Only `delete*` is guarded, which is how
       * single-use tokens and safe retries coexist.
       */
      planProductReleaseDeletion: (call: OperatorCall<PlanProductReleaseDeletionInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "planProductReleaseDeletion",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.planProductReleaseDeletion(
                database.db,
                call.input,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      deleteProductRelease: (call: OperatorCall<ConfirmDeletionInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "deleteProductRelease",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.deleteProductRelease(
                database.db,
                call.input.confirmationToken,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      planProductDeletion: (call: OperatorCall<{ productId: string }>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "planProductDeletion",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.planProductDeletion(
                database.db,
                call.input.productId,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      deleteProduct: (call: OperatorCall<ConfirmDeletionInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "deleteProduct",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.deleteProduct(
                database.db,
                call.input.confirmationToken,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      planVariantDeletion: (call: OperatorCall<{ productId: string; variantId: string }>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "planVariantDeletion",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.planVariantDeletion(
                database.db,
                call.input,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      deleteVariant: (call: OperatorCall<ConfirmDeletionInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "deleteVariant",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.deleteVariant(
                database.db,
                call.input.confirmationToken,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      planProductMediaDeletion: (call: OperatorCall<{ productId: string; mediaId: string }>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "planProductMediaDeletion",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.planProductMediaDeletion(
                database.db,
                call.input,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),

      deleteProductMedia: (call: OperatorCall<ConfirmDeletionInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          const database = yield* Database;
          return yield* audit.command(
            "deleteProductMedia",
            call,
            Effect.gen(function* () {
              const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              return yield* Deletion.deleteProductMedia(
                database.db,
                call.input.confirmationToken,
                call.meta.actor.sub,
                now,
              );
            }),
          );
        }).pipe(Effect.provide(layer)),
    };

    /**
     * THE CUSTOMER METHODS, spread on separately.
     *
     * Checkout is what a shopper does, not an operator capability, so it sits in
     * its own object and behind its own contract (`Domain/Storefront.rpc.ts`).
     * Same D1, same batch, same audit ledger; different caller, different
     * blast radius if the authorization in front of it is wrong.
     *
     * Both still travel a BINDING. The customer-facing decode happens on Catalog,
     * which is the worker a browser can reach; this stays unaddressed.
     */
    const storefront = {
      placeOrder: (call: OperatorCall<Checkout.PlaceOrderInput>) =>
        Effect.gen(function* () {
          const audit = yield* Audit;
          return yield* audit.command("placeOrder", call, Checkout.placeOrder(call.input));
        }).pipe(Effect.provide(layer)),

      /**
       * The customer's own order, and ONLY if they can name the address it was
       * placed with. Commerce enforces the match rather than the edge, because
       * an authorization check that lives on the caller's side is one refactor
       * away from being skipped.
       */
      getCustomerOrder: (orderNumber: string, email: string) =>
        Effect.gen(function* () {
          const database = yield* Database;
          const outcome = yield* Orders.getOrder(database.db, orderNumber);
          if ("failure" in outcome) return outcome.failure;
          const found = outcome.response;
          if (!found.ok) return found;
          /**
           * EITHER ADDRESS OPENS THE ORDER. One is what they typed on the
           * storefront, the other what they gave the payment page — a buyer who
           * used their work address at checkout still owns this order, and
           * telling them it does not exist because they quoted the wrong one of
           * their own two addresses is a support ticket, not security.
           *
           * Case-insensitive, because addresses are not case-sensitive in
           * practice and a retyped capital is not a different person.
           */
          const asked = email.trim().toLowerCase();
          const owns =
            found.value.email.toLowerCase() === asked ||
            found.value.receiptEmail?.toLowerCase() === asked;
          return owns ? found : { ok: false as const, error: "not_found" as const };
        }).pipe(Effect.provide(layer)),

      /** What provider this deployment mints sessions with — asserted by the suite. */
      paymentsProvider: () => Effect.succeed(provider.kind),
    };

    /**
     * No `satisfies OperatorSurface` check here, deliberately.
     *
     * A hand-written interface restating these method signatures validates
     * nothing at runtime and makes every change a two-file edit — the same
     * "assert the code is the code" trap as a test that snapshots a shape. The
     * contract that DOES earn its keep is `Domain/Rpc.ts`, which decodes real
     * payloads at the boundary and fails loudly when the implementation drifts
     * from it.
     */
    return { ...surface, ...storefront };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
      ),
    ),
  ),
) {}
