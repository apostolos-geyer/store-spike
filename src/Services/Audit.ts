/**
 * Idempotency and audit, which are the same table doing both jobs — and that is
 * why the design works.
 *
 * v2 got this right and it is the most portable thing in its store. The
 * contract, in three parts:
 *
 *  1. Every mutating command begins with an idempotency lookup. A hit returns
 *     the ORIGINAL response verbatim and re-runs nothing.
 *  2. On success the domain mutation and exactly one event insert go into the
 *     SAME batch. Splitting them would let a mutation land with no idempotency
 *     record, and the next retry would mutate again.
 *  3. A typed-error return writes NO event, so a failed call stays retryable
 *     and a recorded row always means a success replay.
 *
 * {@link command} is that whole protocol in one place, so no call site can
 * implement half of it. A core hands back the statements it wants committed and
 * the response it wants recorded; it never touches the database itself, which is
 * what keeps every domain module a pure function of its arguments.
 */
import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DomainResult, OperatorCall } from "../Domain/Contracts.ts";
import { operatorEvent } from "../Domain/Schema.ts";
import { Database, query, type DbStatement } from "./Database.ts";
import { Ids } from "./Ids.ts";

export interface EventFacts {
  readonly targetType: string;
  /** The operator-facing handle: a product, variant or media id — for an order, its NUMBER. */
  readonly targetId: string;
  /** Identifiers and counts only. Never a body, a blob, or a secret. */
  readonly detail?: Record<string, unknown>;
}

/**
 * What a domain core returns: either a committed outcome with its statements
 * and audit facts, or a typed domain failure that writes nothing.
 */
export type CoreOutcome<T, E extends string> =
  | {
      readonly statements: readonly DbStatement[];
      readonly response: { ok: true; value: T };
      readonly facts: EventFacts;
      /**
       * Run AFTER the batch commits — the escape hatch for an effect D1 cannot
       * hold, which in practice means deleting R2 objects behind a media delete.
       *
       * The ordering is deliberate and not symmetric. Commit first, then delete
       * bytes: a failure here leaks an unreferenced object, which costs storage
       * and nothing else. The reverse would leave a row pointing at bytes that
       * are already gone, which is a visibly broken product page. So this is
       * allowed to fail, and its failure is logged rather than propagated.
       */
      readonly onCommitted?: Effect.Effect<void, unknown>;
    }
  | { readonly failure: DomainResult<T, E> };

export class Audit extends Context.Service<
  Audit,
  {
    /**
     * Run a mutating command under the idempotency + audit protocol. Returns
     * the domain result, whether freshly computed or replayed.
     *
     * `R` is carried through rather than pinned to `never`: a core may need a
     * capability of its own — media deletion needs `Blobs` to drop the bytes
     * after its batch commits — and the protocol should not force those cores
     * to resolve their services early.
     */
    command<I, T, E extends string, R>(
      action: string,
      call: OperatorCall<I>,
      core: Effect.Effect<CoreOutcome<T, E>, never, R>,
    ): Effect.Effect<DomainResult<T, E>, never, R>;
  }
>()("store/Services/Audit") {
  static readonly layer = Layer.effect(
    Audit,
    Effect.gen(function* () {
      const database = yield* Database;
      const ids = yield* Ids;
      const db = database.db;

      /** The recorded success response for this key + action, or null. */
      const recorded = Effect.fn("Audit.recorded")(function* (
        idempotencyKey: string,
        action: string,
      ) {
        const rows = yield* query(() =>
          db
            .select({ responseJson: operatorEvent.responseJson })
            .from(operatorEvent)
            .where(
              and(
                eq(operatorEvent.idempotencyKey, idempotencyKey),
                eq(operatorEvent.action, action),
              ),
            )
            .limit(1),
        );
        const found = rows[0]?.responseJson;
        return found == null ? null : (JSON.parse(found) as unknown);
      });

      const command = Effect.fn("Audit.command")(function* <I, T, E extends string>(
        action: string,
        call: OperatorCall<I>,
        core: Effect.Effect<CoreOutcome<T, E>>,
      ) {
        const replay = yield* recorded(call.meta.idempotencyKey, action);
        if (replay !== null) return replay as DomainResult<T, E>;

        const outcome = yield* core;
        if ("failure" in outcome) return outcome.failure;

        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const eventId = yield* ids.next();

        /**
         * The mutation and its event row in ONE batch. The unique index on
         * (idempotency_key, action) means a concurrent duplicate loses here
         * rather than mutating twice — the batch aborts on the constraint.
         */
        yield* Effect.orDie(
          database.run([
            ...outcome.statements,
            db.insert(operatorEvent).values({
              id: eventId,
              operatorSub: call.meta.actor.sub,
              operatorEmail: call.meta.actor.email,
              action,
              targetType: outcome.facts.targetType,
              targetId: outcome.facts.targetId,
              requestId: call.meta.requestId,
              idempotencyKey: call.meta.idempotencyKey,
              outcome: "success",
              detailJson: outcome.facts.detail ? JSON.stringify(outcome.facts.detail) : null,
              responseJson: JSON.stringify(outcome.response),
              createdAt: now,
            }) as unknown as DbStatement,
          ]),
        );

        /**
         * The row is gone and the audit event is written; only bytes remain.
         * A failure here is logged and swallowed — see the note on
         * `onCommitted` for why it must not fail the command.
         */
        if (outcome.onCommitted) {
          yield* outcome.onCommitted.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("store.audit.after_commit_failed", { action, cause }),
            ),
          );
        }

        return outcome.response as DomainResult<T, E>;
      });

      return Audit.of({ command });
    }),
  );
}

export type AuditService = Audit["Service"];
