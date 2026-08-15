import { useEffect, useMemo, useState } from "react";
import { Boxes, Save } from "lucide-react";
import Modal from "./Modal";
import { money, stockNumber } from "../lib/catalog";

function today() { return new Date().toISOString().slice(0, 10); }

export default function BatchFormModal({ open, products, busy, onClose, onSubmit }) {
  const [categoryId, setCategoryId] = useState("all");
  const [productId, setProductId] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [receivedDate, setReceivedDate] = useState(today());
  const [expiryDate, setExpiryDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [assignExisting, setAssignExisting] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  const tracked = useMemo(() => products.filter((p) => p.batch_tracking), [products]);
  const categories = useMemo(() => {
    const map = new Map();
    for (const productRow of tracked) {
      if (productRow.categories?.id) map.set(productRow.categories.id, productRow.categories.name);
    }
    return [...map.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }, [tracked]);
  const selectableProducts = useMemo(
    () => tracked.filter((productRow) => categoryId === "all" || productRow.categories?.id === categoryId),
    [tracked, categoryId]
  );
  const product = selectableProducts.find((p) => p.id === productId) || null;

  useEffect(() => {
    if (!open) return;
    setCategoryId("all"); setProductId(tracked[0]?.id || ""); setBatchNumber(""); setReceivedDate(today());
    setExpiryDate(""); setQuantity(""); setUnitCost(""); setAssignExisting(true); setNotes(""); setError("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!selectableProducts.some((row) => row.id === productId)) {
      setProductId(selectableProducts[0]?.id || "");
    }
  }, [open, categoryId, selectableProducts, productId]);

  useEffect(() => {
    if (!product) return;
    setUnitCost(String(product.average_cost || 0));
    if (product.expiry_tracking && product.default_shelf_life_days) {
      const d = new Date(`${receivedDate}T00:00:00`); d.setDate(d.getDate() + Number(product.default_shelf_life_days));
      setExpiryDate(d.toISOString().slice(0, 10));
    }
  }, [productId, receivedDate]);

  if (!open) return null;
  async function submit(e) {
    e.preventDefault(); setError("");
    if (!product) return setError("Choose a batch-tracked product.");
    if (!batchNumber.trim()) return setError("Batch or lot number is required.");
    if (!(Number(quantity) > 0)) return setError("Quantity must be greater than zero.");
    if (product.expiry_tracking && !expiryDate) return setError("Expiry date is required.");
    await onSubmit({ product_id: product.id, batch_number: batchNumber, received_date: receivedDate,
      expiry_date: expiryDate, quantity, unit_cost: unitCost, assign_existing_stock: assignExisting, notes });
  }

  return <Modal title="Add inventory batch" onClose={onClose}>
    <form className="batch-form" onSubmit={submit}>
      <div className="form-grid two batch-product-picker">
        <label><span>Category</span><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label><span>Product</span><select value={productId} onChange={(e) => setProductId(e.target.value)}>
          {selectableProducts.map((p) => <option key={p.id} value={p.id}>{p.name} · {stockNumber(p.stock_quantity)} {p.unit_name}</option>)}
        </select></label>
      </div>
      {tracked.length === 0 && <div className="notice warning">Enable Batch Tracking in Product Management first.</div>}
      <div className="form-grid two">
        <label><span>Batch / lot number</span><input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} /></label>
        <label><span>Quantity ({product?.unit_name || "base units"})</span><input type="number" min="0.001" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label><span>Received date</span><input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} /></label>
        <label><span>Expiry date</span><input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></label>
        <label><span>Base-unit cost</span><input type="number" min="0" step="0.0001" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} /></label>
        <div className="batch-cost-preview"><span>Batch value</span><strong>{money(Number(quantity || 0) * Number(unitCost || 0), product?.currency || "USD")}</strong></div>
      </div>
      <label className="check-row"><input type="checkbox" checked={assignExisting} onChange={(e) => setAssignExisting(e.target.checked)} /><span>Assign existing unbatched stock (do not increase total stock)</span></label>
      {!assignExisting && <div className="notice warning">This mode adds new stock to the inventory balance and creates a stock movement.</div>}
      <label><span>Notes</span><textarea rows="3" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {error && <div className="notice error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !product}><Save size={18}/>{busy ? "Saving..." : "Save batch"}</button></div>
    </form>
  </Modal>;
}
