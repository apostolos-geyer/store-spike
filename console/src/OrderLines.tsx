/**
 * The lines of an order, rendered the same way wherever they appear.
 *
 * The operator's order drawer and the customer's own lookup were rendering this
 * separately, and had already drifted: the customer's copy dropped the unit
 * price, so a buyer could see what they ordered but not what each item cost —
 * on the one screen that exists to answer that.
 *
 * They read from different shapes (the operator's line carries ids the customer
 * never receives), so this takes only the fields both actually have.
 */
import { money } from "./api.ts";

export interface Line {
  title: string;
  size: string;
  unitPriceCents: number;
  quantity: number;
  preorder: boolean;
}

export const OrderLines = ({ items }: { items: readonly Line[] }) => (
  <ul className="list">
    {items.map((item, index) => (
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
);
