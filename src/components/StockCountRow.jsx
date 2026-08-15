import { useEffect, useMemo, useState } from "react";
import { money, stockNumber } from "../lib/catalog";

function batchOptionLabel(batch, unitName) {
  const parts = [
    batch.batch_number || "Unnamed lot",
    `${stockNumber(batch.quantity)} ${unitName || "pcs"}`,
    batch.status
  ];
  if (batch.expiry_date) parts.push(`exp ${String(batch.expiry_date).slice(0, 10)}`);
  return parts.filter(Boolean).join(" · ");
}

export default function StockCountRow({
  item,
  blind,
  busy,
  onDraftChange,
  asCard = false
}) {
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState("");

  useEffect(() => {
    setQuantity(item.counted_quantity === null ? "" : String(item.counted_quantity));
    setNote(item.note || "");
    setSelectedBatchId(item.selected_batch_id || "");
  }, [item.id, item.counted_quantity, item.note, item.selected_batch_id]);

  const product = item.products || {};
  const batches = product.inventory_batches || [];
  const counted = quantity.trim() === "" ? null : Number(quantity);

  const variance = useMemo(() => {
    if (counted === null || !Number.isFinite(counted)) return null;
    return counted - Number(item.expected_quantity || 0);
  }, [counted, item.expected_quantity]);

  const changed = (
    item.counted_quantity === null
      ? quantity.trim() !== ""
      : Number(quantity) !== Number(item.counted_quantity)
  )
    || note.trim() !== String(item.note || "").trim()
    || String(selectedBatchId || "") !== String(item.selected_batch_id || "");

  const valueVariance = variance === null
    ? null
    : variance * Number(item.unit_cost_snapshot || 0);

  const tone = variance === null
    ? ""
    : variance === 0
      ? "stock-count-balanced"
      : variance > 0
        ? "stock-count-over"
        : "stock-count-short";

  function emitDraft(nextQuantity, nextNote, nextBatchId) {
    onDraftChange(
      item,
      nextQuantity,
      nextNote,
      nextBatchId || null
    );
  }

  function updateQuantity(value) {
    setQuantity(value);
    const parsed = value.trim() === "" ? null : Number(value);
    emitDraft(parsed, note, selectedBatchId);
  }

  function updateNote(value) {
    setNote(value);
    const parsed = quantity.trim() === "" ? null : Number(quantity);
    emitDraft(parsed, value, selectedBatchId);
  }

  function updateBatch(value) {
    setSelectedBatchId(value);
    const parsed = quantity.trim() === "" ? null : Number(quantity);
    emitDraft(parsed, note, value);
  }

  function batchControl() {
    if (!product.batch_tracking) {
      return <span className="stock-count-no-batch">—</span>;
    }

    if (batches.length === 0) {
      return (
        <div className="stock-count-batch-empty">
          <strong>Auto recovery lot</strong>
          <small>Tiny POS will create a count lot if stock is greater than 0.</small>
        </div>
      );
    }

    return (
      <select
        className="stock-count-batch-select"
        value={selectedBatchId}
        onChange={(event) => updateBatch(event.target.value)}
        disabled={busy}
        aria-label={`Batch or lot for ${product.name || "product"}`}
      >
        <option value="">Choose batch / lot</option>
        {batches.map((batch) => (
          <option value={batch.id} key={batch.id}>
            {batchOptionLabel(batch, product.unit_name)}
          </option>
        ))}
      </select>
    );
  }

  if (asCard) {
    return (
      <article className={`responsive-data-card stock-count-item-card ${tone}`}>
        <header className="stock-count-card-header">
          <div>
            <strong>{product.name}</strong>
            <small>{[product.sku, product.barcode, product.categories?.name].filter(Boolean).join(" · ") || "No product code"}</small>
          </div>
          <span className={`status-pill ${changed ? "pending" : "active"}`}>
            {changed ? "Unsaved" : "Saved"}
          </span>
        </header>

        <div className="stock-count-card-meta">
          <div>
            <span>Base unit</span>
            <strong>{product.unit_name || "pcs"}</strong>
          </div>
          <div>
            <span>System stock</span>
            <strong>{blind ? "Hidden" : stockNumber(item.expected_quantity)}</strong>
          </div>
        </div>

        {product.batch_tracking && (
          <label className="stock-count-card-batch">
            <span>Batch / lot</span>
            {batchControl()}
          </label>
        )}

        <label className="stock-count-card-counted">
          <span>Counted quantity</span>
          <input
            className="stock-count-input"
            type="number"
            min="0"
            step="0.001"
            value={quantity}
            onChange={(event) => updateQuantity(event.target.value)}
            disabled={busy}
            placeholder="Not counted"
            inputMode="decimal"
          />
        </label>

        <div className="stock-count-card-results">
          <div>
            <span>Variance</span>
            <strong>{blind ? "Hidden" : variance === null ? "—" : `${variance > 0 ? "+" : ""}${stockNumber(variance)}`}</strong>
          </div>
          <div>
            <span>Value variance</span>
            <strong>{blind ? "Hidden" : valueVariance === null ? "—" : money(valueVariance, product.currency || "USD")}</strong>
          </div>
        </div>

        <label className="stock-count-card-note">
          <span>Note</span>
          <input
            className="stock-count-note-input"
            value={note}
            onChange={(event) => updateNote(event.target.value)}
            disabled={busy}
            placeholder="Optional note"
          />
        </label>
      </article>
    );
  }

  return (
    <tr className={tone}>
      <td data-label="Product">
        <strong>{product.name}</strong>
        <small>{[product.sku, product.barcode, product.categories?.name].filter(Boolean).join(" · ") || "No product code"}</small>
      </td>
      <td data-label="Base unit">{product.unit_name || "pcs"}</td>
      <td data-label="Batch / lot">{batchControl()}</td>
      <td data-label="System stock">
        {blind
          ? <span className="stock-count-hidden">Hidden</span>
          : <strong>{stockNumber(item.expected_quantity)}</strong>}
      </td>
      <td data-label="Counted">
        <input
          className="stock-count-input"
          type="number"
          min="0"
          step="0.001"
          value={quantity}
          onChange={(event) => updateQuantity(event.target.value)}
          disabled={busy}
          placeholder="Not counted"
          inputMode="decimal"
        />
      </td>
      <td data-label="Variance">
        {blind
          ? <span className="stock-count-hidden">Hidden</span>
          : variance === null
            ? <span className="muted">—</span>
            : <strong>{variance > 0 ? "+" : ""}{stockNumber(variance)}</strong>}
      </td>
      <td data-label="Value variance">
        {blind
          ? <span className="stock-count-hidden">Hidden</span>
          : valueVariance === null
            ? <span className="muted">—</span>
            : <strong>{money(valueVariance, product.currency || "USD")}</strong>}
      </td>
      <td data-label="Note">
        <input
          className="stock-count-note-input"
          value={note}
          onChange={(event) => updateNote(event.target.value)}
          disabled={busy}
          placeholder="Optional note"
        />
      </td>
      <td data-label="Status">
        <span className={`status-pill ${changed ? "pending" : "active"}`}>
          {changed ? "Unsaved" : "Saved"}
        </span>
      </td>
    </tr>
  );
}
