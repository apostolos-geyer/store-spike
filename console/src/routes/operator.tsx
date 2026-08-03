/**
 * THE OPERATOR PAGE — the whole product lifecycle, plus the settings an
 * operator has to set before a product can be sold.
 *
 * The lifecycle this page walks, in the order the domain enforces it:
 *
 *   create ──▶ draft edits ──▶ add a variant ──▶ publish ──▶ set status active
 *
 * PUBLISH IS THE GATE, and it refuses rather than warns: a product with no
 * variant or no media cannot publish, and a product with no ACTIVE RELEASE
 * cannot go active. Those refusals are the point of the page — they arrive as
 * `missing_variant` / `missing_media` / `no_release` and are rendered verbatim
 * so the sequence is visible rather than something you have to already know.
 *
 * EVERY EDIT CARRIES `expectedRevision`. Two tabs open on one product is the
 * ordinary case, and the second save loses with `revision_conflict` instead of
 * silently overwriting the first.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  call,
  commandId,
  expect,
  money,
  when,
  type OrderDetail,
  type OrderSummary,
  type ProductDetail,
  type ProductDraft,
  type TimelineEntry,
} from "../api.ts";

const STATUSES = ["draft", "active", "unavailable", "archived"] as const;

/** Surface whatever came back, refusal reason included. */
const Outcome = ({ error, done }: { error: unknown; done?: string }) => {
  if (error) return <p className="bad">{(error as Error).message}</p>;
  if (done) return <p className="good">{done}</p>;
  return null;
};

export const OperatorPage = () => {
  const [selected, setSelected] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const products = useQuery({
    queryKey: ["products", statusFilter],
    queryFn: () =>
      expect<{ products: ProductDraft[]; nextCursor: string | null }>("listProducts", {
        status: statusFilter,
        limit: 50,
      }),
  });

  return (
    <div className="page">
      <section className="col">
        <Settings />
        <CreateProduct onCreated={setSelected} />

        <div className="card">
          <div className="card-head">
            <h2>Products</h2>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">all</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          {products.isLoading && <p className="dim">loading…</p>}
          <Outcome error={products.error} />
          <ul className="list">
            {products.data?.products.map((product) => (
              <li key={product.productId}>
                <button
                  className={selected === product.productId ? "row on" : "row"}
                  onClick={() => setSelected(product.productId)}
                >
                  <span className="grow">{product.title}</span>
                  <span className={`pill ${product.status}`}>{product.status}</span>
                  <span className="dim">{product.activeVersion ?? "unpublished"}</span>
                </button>
              </li>
            ))}
            {products.data?.products.length === 0 && <li className="dim">nothing here yet</li>}
          </ul>
        </div>
      </section>

      <section className="col wide">
        {selected ? <Product productId={selected} /> : <p className="dim">select a product</p>}
        <Orders />
      </section>
    </div>
  );
};

/**
 * The two configs an operator does not choose but must be able to SEE, plus the
 * one operation they run by hand.
 *
 * `paymentsProvider` is decided by the stage — a deployment that checked out
 * against Stripe while settling against the fake would take money and never
 * mark an order paid, so which one is live is worth showing.
 *
 * The sweep normally fires on a cron. Running it here is how a stuck order gets
 * unstuck without waiting for the next tick.
 */
const Settings = () => {
  const provider = useQuery({
    queryKey: ["provider"],
    queryFn: () => call<string>("paymentsProvider"),
  });
  const sweep = useMutation({ mutationFn: () => call<unknown>("runSweep") });

  return (
    <div className="card">
      <h2>Settings</h2>
      <dl className="kv">
        <dt>payments provider</dt>
        <dd>{provider.data ?? "…"}</dd>
        <dt>actor</dt>
        <dd className="dim">operator:console (stand-in for Access)</dd>
      </dl>
      <button onClick={() => sweep.mutate()} disabled={sweep.isPending}>
        {sweep.isPending ? "sweeping…" : "Run reconcile sweep"}
      </button>
      <Outcome
        error={sweep.error}
        done={sweep.isSuccess ? JSON.stringify(sweep.data) : undefined}
      />
    </div>
  );
};

const CreateProduct = ({ onCreated }: { onCreated: (id: string) => void }) => {
  const client = useQueryClient();
  const [form, setForm] = useState({ slug: "", title: "", priceCents: 4500 });

  const create = useMutation({
    mutationFn: () => expect<{ productId: string }>("createProduct", { ...form, commandId: commandId() }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["products"] });
      onCreated(result.productId);
      setForm({ slug: "", title: "", priceCents: 4500 });
    },
  });

  return (
    <div className="card">
      <h2>New product</h2>
      <label>
        slug
        <input
          value={form.slug}
          placeholder="charcoal-tee"
          onChange={(e) => setForm({ ...form, slug: e.target.value })}
        />
      </label>
      <label>
        title
        <input
          value={form.title}
          placeholder="Charcoal Tee"
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </label>
      <label>
        price (cents)
        <input
          type="number"
          value={form.priceCents}
          onChange={(e) => setForm({ ...form, priceCents: Number(e.target.value) })}
        />
      </label>
      <button onClick={() => create.mutate()} disabled={create.isPending || !form.slug}>
        Create
      </button>
      <Outcome error={create.error} />
    </div>
  );
};

const Product = ({ productId }: { productId: string }) => {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["product", productId],
    queryFn: () => expect<ProductDetail>("getProduct", { productId }),
  });

  const refresh = () => {
    client.invalidateQueries({ queryKey: ["product", productId] });
    client.invalidateQueries({ queryKey: ["products"] });
  };

  if (detail.isLoading) return <p className="dim">loading…</p>;
  if (detail.error) return <Outcome error={detail.error} />;
  if (!detail.data) return null;

  const { draft, preorder, releases, variants, media } = detail.data;

  return (
    <div className="card">
      <div className="card-head">
        <h2>{draft.title}</h2>
        <span className={`pill ${draft.status}`}>{draft.status}</span>
        <span className="dim">rev {draft.revision}</span>
      </div>

      <Draft draft={draft} onDone={refresh} />
      <Lifecycle draft={draft} releases={releases} onDone={refresh} />
      <Variants productId={productId} variants={variants} onDone={refresh} />
      <Preorder productId={productId} draft={draft} preorder={preorder} onDone={refresh} />

      <details>
        <summary>media ({media.length})</summary>
        {media.length === 0 ? (
          <p className="dim">
            none — publish refuses with <code>missing_media</code> until a cover exists. Uploading
            takes bytes, so it is driven from the integration suite rather than here.
          </p>
        ) : (
          <ul className="list">
            {media.map((item) => (
              <li key={item.id} className="row">
                <span className="grow">{item.alt || item.id}</span>
                <span className="pill">{item.role}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
};

const Draft = ({ draft, onDone }: { draft: ProductDraft; onDone: () => void }) => {
  const [form, setForm] = useState({
    title: draft.title,
    slug: draft.slug,
    priceCents: draft.priceCents,
    descriptionMarkdown: draft.descriptionMarkdown ?? "",
  });

  const save = useMutation({
    mutationFn: () =>
      expect<{ revision: number }>("saveProductDraft", {
        productId: draft.productId,
        expectedRevision: draft.revision,
        commandId: commandId(),
        ...form,
      }),
    onSuccess: onDone,
  });

  return (
    <section className="block">
      <h3>Draft</h3>
      <div className="grid2">
        <label>
          title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label>
          slug
          <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
        </label>
      </div>
      <label>
        price (cents)
        <input
          type="number"
          value={form.priceCents}
          onChange={(e) => setForm({ ...form, priceCents: Number(e.target.value) })}
        />
      </label>
      <label>
        description
        <textarea
          rows={3}
          value={form.descriptionMarkdown}
          onChange={(e) => setForm({ ...form, descriptionMarkdown: e.target.value })}
        />
      </label>
      <button onClick={() => save.mutate()} disabled={save.isPending}>
        Save draft
      </button>
      <Outcome error={save.error} done={save.isSuccess ? "saved" : undefined} />
      <p className="dim">
        Edits land on the draft only. What a shopper sees does not move until publish.
      </p>
    </section>
  );
};

const Lifecycle = ({
  draft,
  releases,
  onDone,
}: {
  draft: ProductDraft;
  releases: ProductDetail["releases"];
  onDone: () => void;
}) => {
  const [bump, setBump] = useState<"major" | "minor" | "patch">("minor");

  const publish = useMutation({
    mutationFn: () =>
      expect<{ version: string }>("publishProduct", {
        productId: draft.productId,
        expectedRevision: draft.revision,
        bump,
        commandId: commandId(),
      }),
    onSuccess: onDone,
  });

  const setStatus = useMutation({
    mutationFn: (status: string) =>
      expect<unknown>("setProductStatus", {
        productId: draft.productId,
        status,
        commandId: commandId(),
      }),
    onSuccess: onDone,
  });

  return (
    <section className="block">
      <h3>Lifecycle</h3>
      <div className="row gap">
        <select value={bump} onChange={(e) => setBump(e.target.value as typeof bump)}>
          <option value="patch">patch</option>
          <option value="minor">minor</option>
          <option value="major">major</option>
        </select>
        <button onClick={() => publish.mutate()} disabled={publish.isPending}>
          Publish
        </button>
        {STATUSES.map((status) => (
          <button
            key={status}
            className="ghost"
            disabled={setStatus.isPending || draft.status === status}
            onClick={() => setStatus.mutate(status)}
          >
            {status}
          </button>
        ))}
      </div>
      <Outcome error={publish.error ?? setStatus.error} />
      <p className="dim">
        The version is a LABEL, derived from the latest release — supply one by hand only to name a
        release something specific. Active needs a release; publish needs a variant and a cover.
      </p>
      <ul className="list">
        {releases.map((release) => (
          <li key={release.id} className="row">
            <span className="grow">v{release.version}</span>
            <span className="dim">{when(release.publishedAt)}</span>
            {draft.activeVersion === release.version && <span className="pill active">active</span>}
          </li>
        ))}
        {releases.length === 0 && <li className="dim">never published</li>}
      </ul>
    </section>
  );
};

const Variants = ({
  productId,
  variants,
  onDone,
}: {
  productId: string;
  variants: ProductDetail["variants"];
  onDone: () => void;
}) => {
  const [form, setForm] = useState({ size: "M", sku: "", stock: 10, mode: "stock" });
  const [adjust, setAdjust] = useState<Record<string, number>>({});

  const put = useMutation({
    mutationFn: () =>
      expect<unknown>("putVariant", { productId, ...form, commandId: commandId() }),
    onSuccess: onDone,
  });

  const stock = useMutation({
    mutationFn: (input: { variantId: string; delta: number }) =>
      expect<{ stock: number }>("adjustStock", {
        ...input,
        reason: "console adjustment",
        commandId: commandId(),
      }),
    onSuccess: onDone,
  });

  return (
    <section className="block">
      <h3>Variants</h3>
      <table>
        <thead>
          <tr>
            <th>size</th>
            <th>sku</th>
            <th>mode</th>
            <th className="num">stock</th>
            <th>adjust</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((variant) => (
            <tr key={variant.id}>
              <td>{variant.size}</td>
              <td className="dim">{variant.sku}</td>
              <td>
                <span className="pill">{variant.mode}</span>
              </td>
              <td className="num">{variant.stock}</td>
              <td>
                <div className="row gap">
                  <input
                    type="number"
                    className="tiny"
                    value={adjust[variant.id] ?? 1}
                    onChange={(e) =>
                      setAdjust({ ...adjust, [variant.id]: Number(e.target.value) })
                    }
                  />
                  <button
                    className="ghost"
                    onClick={() =>
                      stock.mutate({ variantId: variant.id, delta: adjust[variant.id] ?? 1 })
                    }
                  >
                    +
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      stock.mutate({ variantId: variant.id, delta: -(adjust[variant.id] ?? 1) })
                    }
                  >
                    −
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {variants.length === 0 && (
            <tr>
              <td colSpan={5} className="dim">
                none — publish refuses with <code>missing_variant</code>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="row gap wrap">
        <input
          className="tiny"
          value={form.size}
          onChange={(e) => setForm({ ...form, size: e.target.value })}
          placeholder="size"
        />
        <input
          value={form.sku}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
          placeholder="sku"
        />
        <input
          type="number"
          className="tiny"
          value={form.stock}
          onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
        />
        <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
          <option value="stock">stock</option>
          <option value="preorder">preorder</option>
        </select>
        <button onClick={() => put.mutate()} disabled={put.isPending || !form.sku}>
          Add / update
        </button>
      </div>
      <Outcome error={put.error ?? stock.error} />
      <p className="dim">
        Stock moves by a RELATIVE delta, never a value typed from a stale read — the same reason
        checkout reserves with a guarded conditional UPDATE.
      </p>
    </section>
  );
};

const Preorder = ({
  productId,
  draft,
  preorder,
  onDone,
}: {
  productId: string;
  draft: ProductDraft;
  preorder: ProductDetail["preorder"];
  onDone: () => void;
}) => {
  const [cap, setCap] = useState<string>(preorder.cap === null ? "" : String(preorder.cap));

  const save = useMutation({
    mutationFn: () =>
      expect<unknown>("setPreorderCap", {
        productId,
        cap: cap === "" ? null : Number(cap),
        commandId: commandId(),
      }),
    onSuccess: onDone,
  });

  return (
    <section className="block">
      <h3>Pre-order run</h3>
      <div className="row gap">
        <input
          className="tiny"
          value={cap}
          placeholder="no cap"
          onChange={(e) => setCap(e.target.value)}
        />
        <button onClick={() => save.mutate()} disabled={save.isPending}>
          Set cap
        </button>
        <span className="dim">
          claimed {preorder.claimed}
          {preorder.remaining !== null && ` · ${preorder.remaining} left`}
        </span>
      </div>
      <Outcome error={save.error} />
      <p className="dim">
        Empty means this product is not sold as a pre-order. Lowering the cap below what is already
        claimed is refused with <code>cap_below_claimed</code> — {draft.title} keeps its promises.
      </p>
    </section>
  );
};

const Orders = () => {
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const orders = useQuery({
    queryKey: ["orders", filter],
    queryFn: () =>
      expect<{ orders: OrderSummary[] }>("listOrders", { status: filter, limit: 25 }),
  });

  return (
    <div className="card">
      <div className="card-head">
        <h2>Orders</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">all</option>
          {["pending", "paid", "shipped", "delivered", "cancelled"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <Outcome error={orders.error} />
      <ul className="list">
        {orders.data?.orders.map((order) => (
          <li key={order.orderNumber}>
            <button
              className={open === order.orderNumber ? "row on" : "row"}
              onClick={() => setOpen(open === order.orderNumber ? null : order.orderNumber)}
            >
              <span className="grow">{order.orderNumber}</span>
              <span className="dim">{order.email}</span>
              <span className={`pill ${order.status}`}>{order.status}</span>
              <span className="num">{money(order.totalCents)}</span>
            </button>
            {open === order.orderNumber && (
              <Order
                orderNumber={order.orderNumber}
                onDone={() => client.invalidateQueries({ queryKey: ["orders"] })}
              />
            )}
          </li>
        ))}
        {orders.data?.orders.length === 0 && <li className="dim">no orders</li>}
      </ul>
    </div>
  );
};

const Order = ({ orderNumber, onDone }: { orderNumber: string; onDone: () => void }) => {
  const client = useQueryClient();
  const [ship, setShip] = useState({ carrier: "canada-post", trackingNumber: "" });

  const detail = useQuery({
    queryKey: ["order", orderNumber],
    queryFn: () => expect<OrderDetail>("getOrder", { orderNumber }),
  });
  const timeline = useQuery({
    queryKey: ["timeline", orderNumber],
    queryFn: () => call<TimelineEntry[] | null>("orderTimeline", { orderNumber }),
  });

  const refresh = () => {
    client.invalidateQueries({ queryKey: ["order", orderNumber] });
    client.invalidateQueries({ queryKey: ["timeline", orderNumber] });
    onDone();
  };

  const fulfill = useMutation({
    mutationFn: () =>
      expect<unknown>("fulfillOrder", { orderNumber, ...ship, commandId: commandId() }),
    onSuccess: refresh,
  });
  const deliver = useMutation({
    mutationFn: () => expect<unknown>("markDelivered", { orderNumber, commandId: commandId() }),
    onSuccess: refresh,
  });
  const status = useMutation({
    mutationFn: (next: string) =>
      expect<unknown>("setOrderStatus", { orderNumber, status: next, commandId: commandId() }),
    onSuccess: refresh,
  });

  if (!detail.data) return <p className="dim">loading…</p>;
  const order = detail.data;

  return (
    <div className="drawer">
      <dl className="kv">
        <dt>payment</dt>
        <dd>{order.paymentStatus}</dd>
        <dt>subtotal</dt>
        <dd>{money(order.subtotalCents)}</dd>
        <dt>shipping</dt>
        <dd>{money(order.shippingCents)}</dd>
        <dt>tax</dt>
        <dd>{money(order.taxCents)}</dd>
        <dt>total</dt>
        <dd>{money(order.totalCents)}</dd>
        {order.refundedCents > 0 && (
          <>
            <dt>refunded</dt>
            <dd>{money(order.refundedCents)}</dd>
          </>
        )}
      </dl>

      <ul className="list">
        {order.items.map((item, index) => (
          <li key={index} className="row">
            <span className="grow">
              {item.title} · {item.size}
            </span>
            {item.preorder && <span className="pill">preorder</span>}
            <span className="dim">×{item.quantity}</span>
            <span className="num">{money(item.unitPriceCents)}</span>
          </li>
        ))}
      </ul>

      <div className="row gap wrap">
        <input
          value={ship.carrier}
          onChange={(e) => setShip({ ...ship, carrier: e.target.value })}
          placeholder="carrier"
        />
        <input
          value={ship.trackingNumber}
          onChange={(e) => setShip({ ...ship, trackingNumber: e.target.value })}
          placeholder="tracking"
        />
        <button onClick={() => fulfill.mutate()} disabled={!ship.trackingNumber}>
          Fulfil
        </button>
        <button className="ghost" onClick={() => deliver.mutate()}>
          Delivered
        </button>
        <button className="ghost" onClick={() => status.mutate("cancelled")}>
          Cancel
        </button>
      </div>
      <Outcome error={fulfill.error ?? deliver.error ?? status.error} />
      <p className="dim">
        Fulfilling an unpaid order is refused with <code>payment_incomplete</code>. The transitions
        are the domain's, not this form's.
      </p>

      <details>
        <summary>timeline ({timeline.data?.length ?? 0})</summary>
        <ul className="list">
          {timeline.data?.map((entry, index) => (
            <li key={index} className="row">
              <span className={`pill ${entry.source}`}>{entry.source}</span>
              <span className="grow">{entry.action}</span>
              <span className="dim">{entry.outcome}</span>
              <span className="dim">{when(entry.at)}</span>
            </li>
          ))}
        </ul>
        <p className="dim">
          `source` separates what a PERSON did from what the provider REPORTED — an audit trail that
          conflates the two cannot answer the question it exists for.
        </p>
      </details>
    </div>
  );
};
