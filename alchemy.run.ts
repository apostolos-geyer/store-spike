/**
 * ONE STACK, FOUR WORKERS.
 *
 * A stack is a state and lifecycle boundary. `Auth` in the platform repo earns
 * its own because it deploys first and publishes a routing contract to
 * strangers. These four deploy together and bind to each other — and a service
 * binding names a resource its stack OWNS and cannot cross a stack boundary. Cut
 * them into separate stacks and Edge → Commerce degrades from a binding into a
 * public URL, which is the opposite of what `url: false` is for.
 *
 * Commerce is never given an address; it enters the resource graph through the
 * binding that names it. Catalog and Edge are addressed because a browser calls
 * them. Settlement is addressed because a PROVIDER calls it, and a provider
 * cannot call a service binding — its `fetch` carries its own authentication in
 * the form of a signature.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "alchemy/Output";

import * as StripeDev from "./src/Infrastructure/StripeDev.ts";
import { MediaBucket, StoreDatabase, StoreSchema } from "./src/Runtime.ts";
import * as StripeConfig from "./src/Services/StripeConfig.ts";
import { environmentFor } from "./src/Services/StripeConfig.ts";
import CatalogWorker from "./src/Workers/Catalog.ts";
import EdgeWorker from "./src/Workers/Edge.ts";
import SettlementWorker from "./src/Workers/Settlement.ts";

/**
 * ARMED AT MODULE LOAD, and it has to be here.
 *
 * The Workers read their Stripe secrets with `Config.redacted` during their init
 * phase, and that resolution is what records the Cloudflare secret binding. But
 * `ConfigProvider.fromEnv()` COPIES `process.env` when it is constructed, and
 * alchemy constructs it before it evaluates the stack body — so exporting the
 * secrets from inside the body below would be invisible to every `Config` in the
 * graph, and the whole deployment would silently fall back to the fake provider
 * with no error anywhere. Top-level await is the only point that is reliably
 * earlier than the snapshot.
 *
 * Skipped entirely on a host that carries preprod or prod secrets: those stages
 * read their own variables and must never consult a developer's CLI.
 */
const isDevHost =
  !process.env[StripeConfig.VARIABLES.preprod.secretKey] &&
  !process.env[StripeConfig.VARIABLES.prod.secretKey];
const stripeArmed = isDevHost ? await Effect.runPromise(StripeDev.arm()) : true;

export default Alchemy.Stack(
  "StoreSpike",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    /**
     * The schema resource runs FIRST: it regenerates migration SQL when
     * `Domain/Schema.ts` drifts, and the database applies whatever is in that
     * directory. Declaring it here fixes the ordering rather than leaving it to
     * whichever worker happens to resolve the database first.
     */
    yield* StoreSchema;
    yield* StoreDatabase;
    yield* MediaBucket;

    const environment = environmentFor(stage);

    const catalog = yield* CatalogWorker;
    const settlement = yield* SettlementWorker;
    const edge = yield* EdgeWorker;

    /**
     * The forwarder, pointed at the address the provider will actually use.
     *
     * `Command.Dev` runs under `alchemy dev` and is a no-op under
     * `alchemy deploy`, which is the correct split: a deployed stage should
     * receive its webhooks from a registered endpoint. The integration suite
     * deploys, so it starts the same command itself — see `stripe.e2e.test.ts`.
     */
    if (stripeArmed && environment === "dev") {
      yield* StripeDev.forwarder(
        Output.interpolate`${settlement.url}/webhook`,
      );
    }

    return {
      catalogUrl: catalog.url.as<string>(),
      edgeUrl: edge.url.as<string>(),
      settlementUrl: settlement.url.as<string>(),
    };
  }),
);
