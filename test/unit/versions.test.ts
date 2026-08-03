/**
 * Version labels and the idempotency key.
 *
 * `nextVersion` is the interesting one: it exists so an operator never has to
 * invent a number, which means its job is to always produce something valid and
 * never to collide with what a product already published.
 */
import { describe, expect, test } from "bun:test";

import { deriveIdempotencyKey, err, ok } from "../../src/core/result.ts";
import {
  compareVersions,
  isValidVersion,
  nextVersion,
} from "../../src/core/versions.ts";

describe("isValidVersion", () => {
  test("accepts canonical core semver", () => {
    for (const version of ["0.0.0", "1.0.0", "1.2.3", "10.20.30"]) {
      expect(isValidVersion(version)).toBe(true);
    }
  });

  test("rejects a `v` prefix", () => {
    expect(isValidVersion("v1.0.0")).toBe(false);
  });

  test("rejects leading zeros", () => {
    expect(isValidVersion("01.0.0")).toBe(false);
    expect(isValidVersion("1.02.0")).toBe(false);
  });

  test("rejects pre-release and build metadata", () => {
    expect(isValidVersion("1.0.0-rc.1")).toBe(false);
    expect(isValidVersion("1.0.0+build")).toBe(false);
  });

  test("rejects partial versions", () => {
    expect(isValidVersion("1.0")).toBe(false);
    expect(isValidVersion("1")).toBe(false);
    expect(isValidVersion("")).toBe(false);
  });
});

describe("nextVersion", () => {
  test("a product with no releases starts at 1.0.0", () => {
    expect(nextVersion([])).toBe("1.0.0");
  });

  test("bumps the minor off the highest published minor", () => {
    expect(nextVersion(["1.0.0"])).toBe("1.1.0");
    expect(nextVersion(["1.0.0", "1.1.0", "1.2.0"])).toBe("1.3.0");
  });

  test("reads the HIGHEST minor, not the last element", () => {
    expect(nextVersion(["1.5.0", "1.1.0", "1.3.0"])).toBe("1.6.0");
  });

  test("always produces something isValidVersion accepts", () => {
    const published: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const next = nextVersion(published);
      expect(isValidVersion(next)).toBe(true);
      published.push(next);
    }
  });

  test("never repeats a version it already derived", () => {
    const published: string[] = [];
    for (let i = 0; i < 25; i += 1) published.push(nextVersion(published));
    expect(new Set(published).size).toBe(published.length);
  });

  /**
   * KNOWN LIMIT, pinned so it is visible rather than discovered. The major is
   * hardcoded and only the minor is read, so an operator-supplied `2.0.0` — the
   * `version` input is optional, not forbidden — makes the next DERIVED version
   * sort BELOW its own predecessor.
   */
  test("ignores the major, so a hand-supplied 2.x produces a lower next version", () => {
    expect(nextVersion(["1.0.0", "2.0.0"])).toBe("1.1.0");
    expect(compareVersions(nextVersion(["1.0.0", "2.0.0"]), "2.0.0")).toBeLessThan(0);
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.2", "1.1.1")).toBeGreaterThan(0);
  });

  test("is zero for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("sorts a list into ascending order", () => {
    const sorted = ["1.10.0", "1.2.0", "2.0.0", "1.0.0"].sort(compareVersions);
    expect(sorted).toEqual(["1.0.0", "1.2.0", "1.10.0", "2.0.0"]);
  });
});

describe("deriveIdempotencyKey", () => {
  test("namespaces by actor and action", () => {
    expect(deriveIdempotencyKey("operator:abc", "createProduct", "cmd-1")).toBe(
      "operator:abc:createProduct:cmd-1",
    );
  });

  test("the same command id from two actors cannot collide", () => {
    expect(deriveIdempotencyKey("operator:a", "createProduct", "cmd-1")).not.toBe(
      deriveIdempotencyKey("operator:b", "createProduct", "cmd-1"),
    );
  });

  test("the same command id across two actions cannot collide", () => {
    expect(deriveIdempotencyKey("operator:a", "createProduct", "cmd-1")).not.toBe(
      deriveIdempotencyKey("operator:a", "deleteProduct", "cmd-1"),
    );
  });

  test("is stable — a retry of the same command derives the same key", () => {
    expect(deriveIdempotencyKey("operator:a", "createProduct", "cmd-1")).toBe(
      deriveIdempotencyKey("operator:a", "createProduct", "cmd-1"),
    );
  });
});

describe("result envelope", () => {
  test("ok carries the value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  /**
   * The whole result is JSON-serialised into the audit row and replayed
   * verbatim, so key PRESENCE has to be byte-stable across a replay — an
   * explicit `message: undefined` would serialise differently.
   */
  test("err without a message omits the key entirely", () => {
    const result = err("not_found");
    expect("message" in result).toBe(false);
    expect(JSON.stringify(result)).toBe('{"ok":false,"error":"not_found"}');
  });

  test("err with a message includes it", () => {
    expect(err("out_of_stock", "Tee (M)")).toEqual({
      ok: false,
      error: "out_of_stock",
      message: "Tee (M)",
    });
  });

  test("a replayed err serialises identically to the original", () => {
    const first = JSON.stringify(err("not_found"));
    const second = JSON.stringify(JSON.parse(first));
    expect(second).toBe(first);
  });
});
