/**
 * Worker props computed from the deploy stage.
 *
 * `Stack.useSync` returns an Effect, and `Cloudflare.Worker`'s three-argument
 * overload wants plain props — the resolver reads it at plan time, but the type
 * does not say so. This is the one cast that reconciles them, in one place,
 * rather than at every worker that needs a stage-derived name or binding.
 *
 * Lifted from `somewhatintelligent-v2/Infrastructure/Staged.ts`, which hit the
 * same wall.
 */
import type * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

export const stagedWorkerProps = (
  compute: (stack: { readonly stage: string }) => Cloudflare.WorkerProps,
): Cloudflare.WorkerProps =>
  Stack.useSync(({ stage }) => compute({ stage })) as unknown as Cloudflare.WorkerProps;
