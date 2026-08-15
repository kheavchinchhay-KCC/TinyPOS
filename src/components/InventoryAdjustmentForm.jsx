import { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
import { adjustmentReasons } from "../lib/inventory";
import { stockNumber } from "../lib/catalog";

export default function InventoryAdjustmentForm({
  product,
  initialMode = "add",
  busy,
  onCancel,
  onSave
}) {
  const batchTracked = Boolean(product.batch_tracking || (product.inventory_batches || []).length);
  const availableBatches = useMemo(
    () => (product.inventory_batches || []).filter(
      (batch) => Number(batch.quantity || 0) > 0 && batch.status !== "depleted"
    ),
    [product.inventory_batches]
  );
  const [mode, setMode] = useState(initialMode);
  const [batchId, setBatchId] = useState(
    batchTracked && availableBatches.length === 1 ? availableBatches[0].id : ""
  );
  const selectedBatch = availableBatches.find((batch) => batch.id === batchId) || null;
  const [quantity, setQuantity] = useState(
    initialMode === "set"
      ? String(batchTracked ? (selectedBatch?.quantity ?? "") : product.stock_quantity)
      : ""
  );
  const [reason, setReason] = useState("count_correction");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const nextBatchId = batchTracked && availableBatches.length === 1 ? availableBatches[0].id : "";
    const nextBatch = availableBatches.find((batch) => batch.id === nextBatchId) || null;
    setMode(initialMode);
    setBatchId(nextBatchId);
    setQuantity(
      initialMode === "set"
        ? String(batchTracked ? (nextBatch?.quantity ?? "") : product.stock_quantity)
        : ""
    );
    setError("");
  }, [initialMode, product.id, product.stock_quantity, batchTracked, availableBatches]);

  function changeMode(nextMode) {
    setMode(nextMode);
    setError("");
    if (nextMode === "set") {
      setQuantity(String(batchTracked ? (selectedBatch?.quantity ?? "") : product.stock_quantity));
    } else if (mode === "set") {
      setQuantity("");
    }
  }

  function changeBatch(nextBatchId) {
    setBatchId(nextBatchId);
    setError("");
    if (mode === "set") {
      const nextBatch = availableBatches.find((batch) => batch.id === nextBatchId);
      setQuantity(nextBatch ? String(nextBatch.quantity) : "");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const numericQuantity = Number(quantity);

    if (batchTracked && !batchId) {
      setError("Choose the batch / lot you want to adjust.");
      return;
    }

    if (!Number.isFinite(numericQuantity) || numericQuantity < 0) {
      setError("Enter a valid quantity.");
      return;
    }

    if (mode !== "set" && numericQuantity <= 0) {
      setError("Quantity must be greater than zero.");
      return;
    }

    try {
      await onSave({
        product_id: product.id,
        mode,
        quantity: numericQuantity,
        batch_id: selectedBatch?.id || null,
        batch_number: selectedBatch?.batch_number || null,
        batch_quantity: selectedBatch ? Number(selectedBatch.quantity || 0) : null,
        reason,
        notes
      });
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  return (
    <form className="inventory-form" onSubmit={submit}>
      {error && <div className="notice error">{error}</div>}

      <div className="selected-product-card">
        <div>
          <strong>{product.name}</strong>
          <span>{product.sku || "No product code"} · {product.barcode || "No barcode"}</span>
        </div>
        <div>
          <small>Current stock</small>
          <strong>{stockNumber(product.stock_quantity)} {product.unit_name}</strong>
        </div>
      </div>

      {batchTracked && (
        <div className="inventory-batch-adjustment">
          <label>
            <span>Batch / lot</span>
            <select
              value={batchId}
              onChange={(event) => changeBatch(event.target.value)}
              disabled={availableBatches.length === 0}
            >
              <option value="">{availableBatches.length ? "Choose batch / lot" : "No available batch / lot"}</option>
              {availableBatches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.batch_number} · {stockNumber(batch.quantity)} {product.unit_name}
                  {batch.expiry_date ? ` · exp ${String(batch.expiry_date).slice(0, 10)}` : ""}
                  {batch.status && batch.status !== "active" ? ` · ${batch.status}` : ""}
                </option>
              ))}
            </select>
          </label>
          {selectedBatch && (
            <div className="inventory-selected-batch-summary">
              <div><span>Selected lot stock</span><strong>{stockNumber(selectedBatch.quantity)} {product.unit_name}</strong></div>
              <div><span>Expiry</span><strong>{selectedBatch.expiry_date ? String(selectedBatch.expiry_date).slice(0, 10) : "No expiry"}</strong></div>
              <div><span>Status</span><strong>{String(selectedBatch.status || "active").replaceAll("_", " ")}</strong></div>
            </div>
          )}
          {availableBatches.length === 0 && (
            <div className="notice warning">This product uses batch tracking. Add or restore a batch in Batch &amp; Expiry Center before adjusting its stock.</div>
          )}
        </div>
      )}

      <div className="form-grid two">
        <label>
          <span>Adjustment method</span>
          <select value={mode} onChange={(event) => changeMode(event.target.value)}>
            <option value="add">Add quantity</option>
            <option value="remove">Remove quantity</option>
            <option value="set">Set counted stock</option>
          </select>
        </label>

        <label>
          <span>{mode === "set" ? "Counted stock" : "Quantity"}</span>
          <input
            type="number"
            min="0"
            step="0.001"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            autoFocus
          />
        </label>
      </div>

      <label>
        <span>Reason</span>
        <select value={reason} onChange={(event) => setReason(event.target.value)}>
          {adjustmentReasons.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      <label>
        <span>Remark</span>
        <textarea
          rows="3"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Optional explanation"
        />
      </label>

      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || (batchTracked && availableBatches.length === 0)}>
          <Save size={18} /> {busy ? "Saving..." : "Save adjustment"}
        </button>
      </div>
    </form>
  );
}
