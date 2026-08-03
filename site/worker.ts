/**
 * SITE — a PLAIN Cloudflare Worker. No Effect, no alchemy runtime, no
 * `Effect.gen` anywhere in this file.
 *
 * WHY THIS EXISTS. Every other worker here is Effect-native, and that made one
 * question unanswerable by reading: what does the platform's real storefront —
 * an Astro or TanStack Start worker, an ordinary `export default { fetch }`
 * module — actually have to write to reach Commerce? This file is that answer,
 * and it is deliberately the dumbest module in the repo.
 *
 * THE PROBLEM IT SOLVES. Commerce's methods return `Effect`s. An Effect is not
 * structured-cloneable, so a service binding cannot hand one across a worker
 * boundary. Alchemy's runtime therefore ENVELOPE-ENCODES what a method returns:
 * the raw binding resolves to `T | RpcErrorEnvelope`, and a stream arrives as
 * `RpcStreamEnvelope`. Call `env.COMMERCE.listStorefront()` directly and you get
 * an envelope you have to unwrap by hand — and, worse, a failure looks like a
 * successful promise carrying an error-shaped object.
 *
 * `toRpcAsync` is the decoder. It wraps the stub in a proxy that turns each
 * `Effect<T>` method into a `Promise<T>`, passes `fetch`/`connect` straight
 * through, and rethrows `RpcErrorEnvelope` as a real `Error` so an ordinary
 * `try`/`catch` works. That is the whole bridge: one call at the top of the
 * handler, and everything below it is plain async TypeScript.
 *
 * WHAT IS STILL TRUE HERE. Being non-Effect changes nothing about the security
 * model. Commerce performs no authorization of its own, so this worker mints
 * `meta.actor` exactly as `Edge` and `Console` do — and, exactly as there, the
 * constant below is a stand-in for the platform's user IdP rather than a
 * finding. See `CLAUDE.md`.
 */
import { toRpcAsync } from "alchemy/Cloudflare/Bridge";

import type CommerceWorker from "../src/Workers/Commerce.ts";
import { customerCall, type ProductCardDTO } from "../src/Domain/Contracts.ts";

/**
 * The binding, typed by the WORKER CLASS rather than restated.
 *
 * `Rpc.Shape<CommerceWorker>` is what `toRpcAsync` reads to produce its
 * promise-flavoured view, so adding a method to Commerce makes it available
 * here with no declaration to keep in step — and removing one breaks this file
 * at compile time rather than at runtime.
 */
interface Env {
  readonly COMMERCE: unknown;
}

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const page = (body: string): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>store</title>` +
      `<style>body{font:14px/1.6 system-ui;margin:40px auto;max-width:44rem;padding:0 1rem}` +
      `h1{font-size:1rem;letter-spacing:.08em;text-transform:uppercase}` +
      `li{margin:.4rem 0}code{background:#eee;padding:0 4px;border-radius:3px}` +
      `.dim{color:#666;font-size:.85em}</style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    /**
     * ONE LINE IS THE ENTIRE BRIDGE. Everything after it is ordinary
     * `await` against a typed surface — no Effect runtime is constructed in
     * this worker, and none is needed.
     */
    const commerce = toRpcAsync<CommerceWorker>(env.COMMERCE);
    const url = new URL(request.url);

    if (url.pathname === "/buy" && request.method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") ?? "");
      const variantId = String(form.get("variantId") ?? "");

      /**
       * A DOMAIN REFUSAL ARRIVES AS A VALUE, not a throw — `placeOrder`
       * returns `DomainResult`, so `out_of_stock` is `result.ok === false`
       * and never reaches the `catch`. What the `catch` is for is the
       * envelope `toRpcAsync` rethrows: a defect on the far side of the
       * binding. Two failure kinds, two mechanisms, and conflating them is
       * how a sold-out size ends up rendered as an internal error.
       */
      try {
        const result = await commerce.placeOrder(
          customerCall(email, crypto.randomUUID(), {
            email,
            customerId: `customer:${email.trim().toLowerCase()}`,
            destination: "CA",
            items: [{ variantId, quantity: 1 }],
          }),
        );

        if (!result.ok) {
          return page(`<h1>refused</h1><p><code>${escape(result.error)}</code></p>
            <p class="dim">A domain refusal — a value on the success channel, not an exception.</p>
            <p><a href="/">back</a></p>`);
        }

        return page(`<h1>reserved</h1>
          <p>${escape(result.value.orderNumber)} · ${money(result.value.subtotalCents)}</p>
          ${
            result.value.checkoutUrl
              ? `<p><a href="${escape(result.value.checkoutUrl)}">pay →</a></p>`
              : `<p class="dim">no hosted page under this provider</p>`
          }
          <p><a href="/">back</a></p>`);
      } catch (error) {
        // Only reachable via the rethrown envelope — see above.
        return page(`<h1>error</h1><p><code>${escape(String(error))}</code></p>`);
      }
    }

    const products: readonly ProductCardDTO[] = await commerce.listStorefront();

    if (products.length === 0) {
      return page(`<h1>store</h1><p class="dim">Nothing active. Publish a product in the
        console and set it active — this reads the same ACTIVE RELEASE the console does,
        over the same binding.</p>`);
    }

    const slug = url.searchParams.get("p");
    if (slug) {
      const detail = await commerce.getStorefrontProduct(slug);
      if (!detail) return page(`<h1>not found</h1><p><a href="/">back</a></p>`);
      return page(`<h1>${escape(detail.title)}</h1>
        <p>${money(detail.priceCents)} · v${escape(detail.version)}</p>
        ${detail.variants
          .map(
            (variant) =>
              `<form method="post" action="/buy">
                 <input type="hidden" name="variantId" value="${escape(variant.id)}">
                 <input name="email" value="buyer@example.com" size="28">
                 <button ${variant.available ? "" : "disabled"}>buy ${escape(variant.size)}</button>
               </form>`,
          )
          .join("")}
        <p><a href="/">back</a></p>`);
    }

    return page(`<h1>store</h1>
      <p class="dim">A plain <code>export default { fetch }</code> worker. It reaches
      Commerce through <code>toRpcAsync</code> over a service binding — no Effect
      runtime in this script.</p>
      <ul>${products
        .map(
          (product) =>
            `<li><a href="/?p=${encodeURIComponent(product.slug)}">${escape(product.title)}</a>
             — ${money(product.priceCents)} <span class="dim">v${escape(product.version)}</span></li>`,
        )
        .join("")}</ul>`);
  },
};
