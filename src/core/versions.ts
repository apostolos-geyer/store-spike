/**
 * Release version labels.
 *
 * A VERSION IS A LABEL, NOT AN INPUT. It exists so a release has something
 * human to point at — "v3 of this shirt" — and that is the whole job. Requiring
 * the operator to invent one made a decorative idea load-bearing on the write
 * path: fixing a typo meant choosing a number, and reusing one refused the
 * publish outright.
 *
 * Extracted from `Domain/Contracts.ts` unchanged. Pure string arithmetic with
 * no I/O, so it belongs where it can be tested without a deployment.
 */

/**
 * Canonical core SemVer: no `v` prefix, no leading zeros, no pre-release or
 * build metadata. A release publishes under an operator-supplied version of
 * exactly this shape.
 */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isValidVersion = (value: string): boolean => SEMVER_PATTERN.test(value);

/**
 * The next version for a product, derived from what it has already published.
 *
 * Bumping the MINOR keeps the shape recognisably semver without pretending
 * these numbers carry compatibility meaning — they describe a garment, not an
 * API.
 *
 * KNOWN LIMIT, pinned by test: the major is hardcoded to `1` and only the minor
 * is read. Because `publishProduct.version` is an optional input, an operator
 * who supplies `2.0.0` by hand makes the next DERIVED version `1.x.0` — lower
 * than its predecessor. Harmless while versions are labels; it would not be if
 * anything ever ordered on them.
 */
export const nextVersion = (published: readonly string[]): string => {
  let highest = 0;
  for (const version of published) {
    const minor = Number(version.split(".")[1] ?? 0);
    if (Number.isFinite(minor) && minor > highest) highest = minor;
  }
  return published.length === 0 ? "1.0.0" : `1.${highest + 1}.0`;
};

/** Compare two core SemVers. Returns <0, 0, or >0. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};
