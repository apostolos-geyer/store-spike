/**
 * SETTLEMENT — async, provider-facing, binding-only.
 *
 * Owns the payment provider relationship and nothing else, which makes it the
 * cleanest of the three to extract: already asynchronous by construction, and
 * its upstream is its own source of truth.
 *
 * The webhook route, the queue consumer and the cron are the DEPLOYED paths.
 * The two RPC methods exist so a test can assert an outcome instead of polling
 * for one — and they call the very same `settle` and `sweep` the queue and cron
 * do, so a green test is evidence about the real path rather than a parallel one.
 *
 * THERE IS NO DEAD-LETTER QUEUE. An event that exhausts its attempts is written
 * to `payment_event` with outcome `dead` and acked; that row is queryable, joins
 * to orders, and outlives any queue retention. A second queue would only be a
 * transport to the same row — and the reconcile sweep, not a DLQ, is what
 * actually recovers a captured charge.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { sweep } from "../Domain/Reconcile.ts";
import { MAX_ATTEMPTS, settle } from "../Domain/Settlement.ts";
import { capabilities, handles } from "../Runtime.ts";
import { Payments, type ProviderEvent } from "../Services/Payments.ts";
import * as PaymentsProvider from "../Services/PaymentsProvider.ts";
import { environmentFor } from "../Services/StripeConfig.ts";

/** A queue name takes lowercase alphanumerics and hyphens — `dev_${USER}` is neither. */
export const eventsQueueName = (stage: string): string =>
  `store-payment-events-${stage.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;

export const EventsQueue = Cloudflare.Queues.Queue(
  "PaymentEvents",
  Stack.useSync(({ stage }) => ({ name: eventsQueueName(stage) })),
);

/** The maintenance trigger. Quarter-hourly is well inside the session TTL. */
const SWEEP_CRON = "*/15 * * * *";

/** What travels on the queue: the compacted event plus its delivery count. */
interface QueuedEvent {
  readonly event: ProviderEvent;
  readonly attempt: number;
}



export default class SettlementWorker extends Cloudflare.Worker<SettlementWorker>()(
  "Settlement",
  /**
   * THE ONE WORKER THAT KEEPS A PUBLIC ADDRESS BESIDES THE STOREFRONT, and the
   * reasoning differs from Commerce's rather than contradicting it.
   *
   * Commerce is `url: false` because it has no authentication of its own — the
   * binding IS its authorization. This worker's `fetch` has authentication built
   * in: an HMAC over the raw body, keyed by a secret only Stripe and this
   * deployment hold. Every other path 404s, and the RPC methods below are still
   * reachable only over a binding.
   *
   * It needs an address because a provider cannot call a service binding. The
   * alternative — proxying raw bodies through Edge — would move nothing except
   * the number of hops a signature has to survive intact.
   */
  { main: import.meta.url, url: true },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const resolved = yield* handles;

    /**
     * THE SEAM. One branch, at init, and nothing downstream knows which side it
     * landed on — `Settlement.ts`, `Reconcile.ts` and `Checkout.ts` all depend
     * on `Payments` and never on a vendor.
     *
     * `livemode` falls out of the same resolution as a plain boolean, so the
     * environment gate in `settle` reads a constant rather than re-deriving the
     * account from a key on every event.
     */
    const environment = environmentFor(stage);
    const provider = yield* PaymentsProvider.resolve(environment);
    const livemode = provider.livemode;

    const layer = Layer.provideMerge(provider.layer, capabilities(resolved));

    const queue = yield* EventsQueue;
    const send = yield* Cloudflare.Queues.WriteQueue(queue);

    /**
     * `retryable` is the ONLY outcome that retries. applied / duplicate /
     * ignored / dead all ack, which is what stops a redelivery settling an
     * order twice and what makes the absence of a DLQ safe.
     */
    yield* Cloudflare.Queues.consumeQueueMessages<QueuedEvent>(
      queue,
      { maxRetries: MAX_ATTEMPTS },
      (messages) =>
        Effect.flatMap(Stream.runCollect(messages), (batch) =>
          Effect.forEach(
            batch,
            (message) =>
              settle(message.body.event, message.body.attempt, livemode).pipe(
                Effect.provide(layer),
              ),
            { concurrency: 1, discard: true },
          ),
        ),
    );

    yield* Cloudflare.Workers.cron(SWEEP_CRON, () =>
      sweep().pipe(
        Effect.provide(layer),
        Effect.flatMap((result) => Effect.logInfo("store.reconcile.swept", result)),
        Effect.catchCause((cause) => Effect.logWarning("store.reconcile.failed", cause)),
      ),
    );

    return {
      /**
       * The webhook. Verify, compact, enqueue, answer 200 — the handler does no
       * database work, so a slow settle can never make the provider time out and
       * redeliver.
       *
       * Answering 200 at the enqueue point DOES opt out of the provider's own
       * multi-day retry, which is precisely why the reconcile sweep exists.
       */
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://settlement").pathname;
        if (request.method !== "POST" || path !== "/webhook") {
          return yield* HttpServerResponse.json({ error: "not_found" }, { status: 404 });
        }

        const payments = yield* Payments;
        const body = yield* request.text;
        const signature = request.headers["stripe-signature"] ?? null;

        /**
         * An unverifiable body is a 400 and nothing else happens — no queue
         * write, no log of its contents. Handled by tag so the day `parseEvent`
         * grows a second failure mode, this stops compiling instead of quietly
         * answering 400 to something that deserved a different answer.
         */
        return yield* payments.parseEvent(body, signature).pipe(
          Effect.flatMap((event) =>
            Effect.andThen(
              send.send({ event, attempt: 1 }),
              HttpServerResponse.json({ received: true }),
            ),
          ),
          Effect.catchTag("EventNotVerified", () =>
            HttpServerResponse.json({ error: "invalid_signature" }, { status: 400 }),
          ),
        );
      }).pipe(
        Effect.provide(layer),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause).slice(0, 600) }, { status: 500 }),
        ),
      ),

      /** Settle synchronously — the same function the queue consumer runs. */
      settleNow: (event: ProviderEvent, attempt: number) =>
        settle(event, attempt, livemode).pipe(Effect.provide(layer)),

      /**
       * What this deployment settles for, and on what. The suite asserts both:
       * `kind` is how a run proves it exercised the real Stripe adapter rather
       * than quietly passing against the fake.
       */
      provider: () => Effect.succeed({ livemode, kind: provider.kind }),

      /** Run the sweep on demand, so a test need not wait a quarter hour. */
      sweepNow: () => sweep().pipe(Effect.provide(layer)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
) {}
