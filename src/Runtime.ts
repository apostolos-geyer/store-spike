/**
 * The resources every worker shares, and the layer stack they build on.
 *
 * ONE `Drizzle.Schema` → ONE `D1.Database` → ONE R2 bucket, referenced by id
 * from each worker. Catalog and Commerce run on the same D1 deliberately: the
 * claim under test is that the WORKERS separate cleanly, which is the reversible
 * decision. Splitting the database is the irreversible one, and `Deletion` is
 * the module that would pay for it — it plans cascades by querying catalog and
 * order history together.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Audit } from "./Services/Audit.ts";
import { Blobs } from "./Services/Blobs.ts";
import { Database } from "./Services/Database.ts";
import { Ids } from "./Services/Ids.ts";

export const StoreSchema = Drizzle.Schema("store-schema", {
  schema: "./src/Domain/Schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});

export const StoreDatabase = Effect.gen(function* () {
  const schema = yield* StoreSchema;
  return yield* Cloudflare.D1.Database("store-db", {
    migrationsDir: schema.out,
    migrationsTable: "drizzle_migrations",
  });
});

/** Stage-derived so two stages never share a bucket. */
export const MediaBucket = Cloudflare.R2.Bucket(
  "store-media",
  Stack.useSync(({ stage }) => ({
    name: `si-store-media-${stage.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
  })),
);

/**
 * Resolve every handle from the bindings.
 *
 * BOTH ARE LAYERS, and for the same reason: each needs a raw binding, `.raw`
 * carries a `RuntimeContext` requirement, and that context only exists PER
 * EVENT — so they are built inside handlers rather than in a Worker's init
 * closure. This is why no `uncoloured` / `RuntimeContext.phantom` discharge
 * appears anywhere in this codebase.
 */
export const handles = Effect.gen(function* () {
  const database = yield* StoreDatabase;
  const d1 = yield* Cloudflare.D1.QueryDatabase(database);
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(MediaBucket);

  return {
    databaseLayer: Database.layer(d1.raw),
    blobsLayer: Blobs.layer(bucket.raw),
  };
});

export type Handles = Effect.Success<typeof handles>;

/**
 * The capability stack a mutating worker runs on: database and blobs at the
 * bottom, then the services that depend on them.
 *
 * DELIBERATELY EXCLUDES `Payments`. Which provider a worker gets is a
 * per-deployment decision — real Stripe for a configured stage, the fake
 * otherwise — and burying that choice in a shared helper is how a stage ends up
 * on the wrong one. The worker picks it explicitly and layers it on top.
 *
 * `Layer.provideMerge` rather than `Layer.merge` so `Audit` receives
 * `Database`/`Ids` while those stay visible to callers too.
 */
export const capabilities = (handles: Handles) =>
  Layer.provideMerge(
    Audit.layer,
    Layer.mergeAll(handles.databaseLayer, handles.blobsLayer, Ids.layer),
  );

/** Reads need no audit trail and no payment provider. */
export const readCapabilities = (handles: Handles) =>
  Layer.mergeAll(handles.databaseLayer, handles.blobsLayer, Ids.layer);
