/**
 * THE SHOP PAGE — everything a customer does, against the same live store.
 *
 *   browse ──▶ pick a variant ──▶ cart ──▶ place order ──▶ pay ──▶ look it up
 *
 * WHAT ARRIVES FROM HERE IS NOT TRUSTED, and the interesting part is what the
 * server refuses to take from it. No price is sent: the cart carries variant ids
 * and quantities, and the active release is the authority on what they cost. A
 * cart that posts its own totals gets them ignored.
 *
 * THE COMMAND ID IS MINTED ONCE PER CART, not per click. That is what makes a
 * double-tapped Buy a replay rather than a second reservation — the same
 * property test L asserts against the deployed stack. Clicking Buy twice here
 * is a real way to see it: the second call returns the FIRST order.
 *
 * Everything shown comes from the ACTIVE RELEASE. A draft edit on the operator
 * page changes nothing here until it is published, which is worth flipping
 * between the two tabs to watch.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { OrderLines } from "../OrderLines.tsx";
import {
  call,
  commandId,
  expect,
  money,
  when,
  type CustomerOrder,
  type PlacedOrder,
  type StorefrontCard,
  type StorefrontProduct,
} from "../api.ts";

interface Line {
  variantId: string;
  quantity: number;
  label: string;
  priceCents: number;
}

export const ShopPage = () => {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [cart, setCart] = useState<Line[]>([]);

  const products = useQuery({
    queryKey: ["storefront"],
    queryFn: () => call<StorefrontCard[]>("listStorefront"),
  });

  const add = (line: Line) =>
    setCart((current) => {
      const existing = current.find((item) => item.variantId === line.variantId);
      return existing
        ? current.map((item) =>
            item.variantId === line.variantId
              ? { ...item, quantity: item.quantity + line.quantity }
              : item,
          )
        : [...current, line];
    });

  return (
    <div className="page">
      <section className="col wide">
        <div className="card">
          <h2>Storefront</h2>
          <p className="dim">
            Read over the BINDING, not over Catalog's HTTP — the same active-release read model a
            bound SSR storefront would use.
          </p>
          {products.isLoading && <p className="dim">loading…</p>}
          {products.error && <p className="bad">{(products.error as Error).message}</p>}
          <div className="grid">
            {products.data?.map((product) => (
              <button
                key={product.slug}
                className={openSlug === product.slug ? "tile on" : "tile"}
                onClick={() => setOpenSlug(product.slug === openSlug ? null : product.slug)}
              >
                {product.coverHref ? (
                  <img src={product.coverHref} alt={product.title} />
                ) : (
                  <div className="tile-blank">no cover</div>
                )}
                <span className="grow">{product.title}</span>
                <span className="num">{money(product.priceCents)}</span>
                <span className="dim">v{product.version}</span>
              </button>
            ))}
          </div>
          {products.data?.length === 0 && (
            <p className="dim">
              nothing active — publish a product on the operator page and set it active
            </p>
          )}
        </div>

        {openSlug && <Detail slug={openSlug} onAdd={add} />}
      </section>

      <section className="col">
        <Cart cart={cart} onClear={() => setCart([])} onDrop={(id) =>
          setCart((current) => current.filter((line) => line.variantId !== id))
        } />
        <Lookup />
      </section>
    </div>
  );
};

const Detail = ({ slug, onAdd }: { slug: string; onAdd: (line: Line) => void }) => {
  const product = useQuery({
    queryKey: ["storefront", slug],
    queryFn: () => call<StorefrontProduct | null>("getStorefrontProduct", { slug }),
  });

  if (product.isLoading) return <p className="dim">loading…</p>;
  if (!product.data) return <p className="dim">not found</p>;
  const item = product.data;

  return (
    <div className="card">
      <div className="card-head">
        <h2>{item.title}</h2>
        <span className="dim">v{item.version}</span>
        <span className="num">{money(item.priceCents)}</span>
      </div>
      {item.descriptionMarkdown && <p>{item.descriptionMarkdown}</p>}
      <div className="row gap wrap">
        {item.variants.map((variant) => (
          <button
            key={variant.id}
            disabled={!variant.available}
            onClick={() =>
              onAdd({
                variantId: variant.id,
                quantity: 1,
                label: `${item.title} · ${variant.size}`,
                priceCents: item.priceCents,
              })
            }
          >
            {variant.size}
            {!variant.available && " · sold out"}
          </button>
        ))}
      </div>
      <p className="dim">
        `available` is computed server-side from live stock and the pre-order run. Adding a sold-out
        size is not possible here, and would be refused if it were.
      </p>
    </div>
  );
};

const Cart = ({
  cart,
  onClear,
  onDrop,
}: {
  cart: Line[];
  onClear: () => void;
  onDrop: (variantId: string) => void;
}) => {
  const [email, setEmail] = useState("buyer@example.com");
  const [destination, setDestination] = useState("CA");
  /**
   * ONE KEY FOR THE WHOLE CART, regenerated only when the cart is emptied. Two
   * clicks of Buy therefore carry the same key, and the second is a replay that
   * returns the first order rather than reserving stock twice.
   */
  const [key, setKey] = useState(commandId);

  const place = useMutation({
    mutationFn: () =>
      expect<PlacedOrder>("placeOrder", {
        commandId: key,
        email,
        destination,
        items: cart.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      }),
  });

  const subtotal = cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);

  return (
    <div className="card">
      <h2>Cart</h2>
      <ul className="list">
        {cart.map((line) => (
          <li key={line.variantId} className="row">
            <span className="grow">{line.label}</span>
            <span className="dim">×{line.quantity}</span>
            <button className="ghost" onClick={() => onDrop(line.variantId)}>
              ×
            </button>
          </li>
        ))}
        {cart.length === 0 && <li className="dim">empty</li>}
      </ul>

      <label>
        email
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        destination
        <select value={destination} onChange={(e) => setDestination(e.target.value)}>
          <option value="CA">CA</option>
          <option value="US">US</option>
        </select>
      </label>

      <div className="row gap">
        <span className="grow dim">subtotal</span>
        <span className="num">{money(subtotal)}</span>
      </div>

      <button onClick={() => place.mutate()} disabled={cart.length === 0 || place.isPending}>
        {place.isPending ? "reserving…" : "Buy"}
      </button>
      <button
        className="ghost"
        onClick={() => {
          onClear();
          setKey(commandId());
          place.reset();
        }}
      >
        New cart
      </button>

      {place.error && <p className="bad">{(place.error as Error).message}</p>}
      {place.data && (
        <div className="good">
          <p>
            {place.data.orderNumber} · {money(place.data.subtotalCents)} reserved
          </p>
          {place.data.checkoutUrl ? (
            <a href={place.data.checkoutUrl} target="_blank" rel="noreferrer">
              Pay →
            </a>
          ) : (
            <p className="dim">no hosted page under this provider</p>
          )}
          <p className="dim">
            Click Buy again: same key, same order, no second reservation. Shipping and tax are added
            by the provider, so this subtotal is not what gets charged.
          </p>
        </div>
      )}
      <p className="dim">
        Destination is chosen BEFORE checkout opens because it decides the shipping rate and pins
        the address form to one country.
      </p>
    </div>
  );
};

const Lookup = () => {
  const [form, setForm] = useState({ orderNumber: "", email: "buyer@example.com" });
  const find = useMutation({
    mutationFn: () => expect<CustomerOrder>("getMyOrder", form),
  });

  return (
    <div className="card">
      <h2>Find my order</h2>
      <label>
        order number
        <input
          value={form.orderNumber}
          placeholder="SO-…"
          onChange={(e) => setForm({ ...form, orderNumber: e.target.value })}
        />
      </label>
      <label>
        email
        <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </label>
      <button onClick={() => find.mutate()} disabled={!form.orderNumber}>
        Look up
      </button>
      {find.error && <p className="bad">{(find.error as Error).message}</p>}
      {find.data && (
        <div className="drawer">
          <dl className="kv">
            <dt>status</dt>
            <dd>{find.data.status}</dd>
            <dt>payment</dt>
            <dd>{find.data.paymentStatus}</dd>
            <dt>total</dt>
            <dd>{money(find.data.totalCents)}</dd>
            {find.data.trackingNumber && (
              <>
                <dt>tracking</dt>
                <dd>
                  {find.data.carrier} {find.data.trackingNumber}
                </dd>
                <dt>shipped</dt>
                <dd>{when(find.data.shippedAt)}</dd>
              </>
            )}
          </dl>
          <OrderLines items={find.data.items} />
        </div>
      )}
      <p className="dim">
        The email is required and is not a convenience: an order number alone is a guessable,
        shareable handle. A mismatch returns the SAME error as a nonexistent order, so the response
        never confirms a number is real. What comes back is the receipt — the product ids, internal
        customer id and fulfilment note are dropped before they leave the worker.
      </p>
    </div>
  );
};
