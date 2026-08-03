/**
 * Which payment provider a Worker runs on, decided ONCE at init.
 *
 * Two Workers need this — Commerce creates sessions, Settlement verifies and
 * settles them — and they must never disagree, because a session minted by one
 * provider cannot be settled by the other. So the decision lives here rather
 * than being restated in each init closure.
 *
 * THE DECISION IS DEPLOY-TIME AND IT IS SAFE THAT WAY. `StripeConfig.load`
 * resolves `Config` values, which alchemy binds as Cloudflare secrets during the
 * plan and resolves from those bindings at cold start — so init reaches the same
 * verdict on the deploy host and inside the deployed Worker. That is what makes
 * this a plain `if` rather than the `Layer.unwrap` deferral an earlier version
 * needed: nothing here reads a per-event service.
 *
 * THE ASYMMETRY IS THE POINT. A dev machine with no Stripe account gets the fake
 * and a fully working stack. Preprod and prod REFUSE TO BOOT instead, because a
 * deployment that silently ran a fake provider would ack real webhooks into a
 * fake ledger and report every order as settled.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Database } from "./Database.ts";
import { Ids } from "./Ids.ts";
import { Payments } from "./Payments.ts";
import * as PaymentsFake from "./PaymentsFake.ts";
import * as PaymentsStripe from "./PaymentsStripe.ts";
import { StripeConfig, VARIABLES, type StripeEnvironment } from "./StripeConfig.ts";

export interface Provider {
  /**
   * Requires `Database | Ids` because the FAKE is D1-backed — it owns a
   * `fake_session` table so a contributor's sessions survive a redeploy the way
   * real ones do. Both are already in `capabilities`, so a worker layers this on
   * top with `Layer.provideMerge` and nothing else changes.
   */
  readonly layer: Layer.Layer<Payments, never, Database | Ids>;
  /** Whether this deployment settles LIVE events. `false` under the fake. */
  readonly livemode: boolean;
  /** What the deployment actually landed on — asserted by the suite. */
  readonly kind: "stripe" | "fake";
}

/**
 * Resolve the provider. INIT PHASE ONLY — see `StripeConfig.load`.
 *
 * Returns a plain value rather than a layer-of-a-layer so callers can read
 * `livemode` directly instead of threading an Effect through every handler.
 */
export const resolve = Effect.fn("PaymentsProvider.resolve")(function* (
  environment: StripeEnvironment,
) {
  return yield* StripeConfig.load(environment).pipe(
    Effect.map(
      (config): Provider => ({
        layer: Layer.provide(PaymentsStripe.layer, StripeConfig.layerOf(config)),
        livemode: config.livemode,
        kind: "stripe",
      }),
    ),
    /**
     * No usable Stripe configuration. `catchCause` rather than a tag match
     * because both ways of failing mean the same thing to this decision — the
     * secret is missing (`ConfigError`) or it is the wrong one for this stage
     * (`StripeKeyMismatch`) — and neither is recoverable here.
     */
    Effect.catchCause((cause) => {
      if (environment !== "dev") {
        const names = VARIABLES[environment];
        /**
         * Outside dev this is FATAL, and dying here fails the DEPLOY — a loud,
         * early, cheap failure. The alternative is a Worker that boots, accepts
         * webhooks it cannot verify, and looks healthy while acking real money
         * into a fake ledger.
         */
        return Effect.die(
          new Error(
            `${environment} cannot resolve its Stripe configuration ` +
              `(${names.secretKey} / ${names.webhookSecret}): ${String(cause)}. ` +
              `Refusing to deploy a real stage onto a fake payment provider.`,
          ),
        );
      }

      return Effect.succeed<Provider>({
        layer: PaymentsFake.layer,
        // The fake mints test-mode events, and the settlement gate must agree.
        livemode: false,
        kind: "fake",
      });
    }),
  );
});
