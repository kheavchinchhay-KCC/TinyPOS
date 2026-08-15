import { Plus, Trash2 } from "lucide-react";
import { stockNumber } from "../lib/catalog";

function defaultExpiry(product, receivedAt) {
  if (!product?.expiry_tracking || !product.default_shelf_life_days || !receivedAt) return "";
  const d = new Date(receivedAt);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + Number(product.default_shelf_life_days));
  return d.toISOString().slice(0, 10);
}

export function createBatchAllocation(product, receivedAt, quantity = "") {
  const key = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return {
    key,
    batch_number: "",
    expiry_date: defaultExpiry(product, receivedAt),
    quantity: String(quantity || ""),
    notes: ""
  };
}

export default function BatchAllocationEditor({
  item,
  receiptQuantity,
  receivedAt,
  allocations,
  onChange
}) {
  const product = item.products;
  if (!product?.batch_tracking || Number(receiptQuantity || 0) <= 0) return null;

  const rows = allocations?.length
    ? allocations
    : [createBatchAllocation(product, receivedAt)];

  const total = rows.reduce(
    (sum, row) => sum + Number(row.quantity || 0),
    0
  );

  function update(key, field, value) {
    onChange(
      rows.map((row) => row.key === key ? { ...row, [field]: value } : row)
    );
  }

  function remove(key) {
    const next = rows.filter((row) => row.key !== key);
    onChange(
      next.length
        ? next
        : [createBatchAllocation(product, receivedAt)]
    );
  }

  return (
    <section className="receipt-batch-editor">
      <header>
        <div>
          <strong>Batch / lot allocation</strong>
          <span>
            {product.picking_policy?.toUpperCase()} picking · {product.expiry_tracking ? "Expiry required" : "Expiry optional"}
          </span>
          <small>Batch / lot number is optional. Leave it blank and Tiny POS will generate one automatically.</small>
        </div>
        <b className={Math.abs(total - Number(receiptQuantity || 0)) < 0.0005 ? "balanced" : "unbalanced"}>
          {stockNumber(total)} / {stockNumber(receiptQuantity)}
        </b>
      </header>

      <div className="receipt-batch-rows">
        {rows.map((row) => (
          <article key={row.key}>
            <label>
              <span>Batch / lot</span>
              <input
                value={row.batch_number}
                onChange={(event) => update(row.key, "batch_number", event.target.value)}
                placeholder="Auto if blank"
              />
            </label>

            <label>
              <span>Quantity ({item.purchase_unit_name})</span>
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={row.quantity}
                onChange={(event) => update(row.key, "quantity", event.target.value)}
              />
            </label>

            <label>
              <span>Expiry date</span>
              <input
                type="date"
                value={row.expiry_date}
                onChange={(event) => update(row.key, "expiry_date", event.target.value)}
              />
            </label>

            <label>
              <span>Note</span>
              <input
                value={row.notes}
                onChange={(event) => update(row.key, "notes", event.target.value)}
                placeholder="Optional"
              />
            </label>

            <button
              type="button"
              className="icon-button"
              onClick={() => remove(row.key)}
              title="Remove batch"
            >
              <Trash2 size={17} />
            </button>
          </article>
        ))}
      </div>

      <button
        type="button"
        className="secondary-button compact"
        onClick={() => onChange([
          ...rows,
          createBatchAllocation(product, receivedAt)
        ])}
      >
        <Plus size={16} />
        Add another batch
      </button>
    </section>
  );
}
