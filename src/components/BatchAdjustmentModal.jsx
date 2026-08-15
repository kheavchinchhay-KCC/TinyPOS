import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import Modal from "./Modal";
import { stockNumber } from "../lib/catalog";

export default function BatchAdjustmentModal({ batch, busy, onClose, onSubmit }) {
  const [change, setChange] = useState(""); const [reason, setReason] = useState("");
  const [notes, setNotes] = useState(""); const [error, setError] = useState("");
  useEffect(() => { if (batch) { setChange(""); setReason(""); setNotes(""); setError(""); } }, [batch?.id]);
  if (!batch) return null;
  const after = Number(batch.quantity || 0) + Number(change || 0);
  async function submit(e) { e.preventDefault(); setError("");
    if (!Number.isFinite(Number(change)) || Math.abs(Number(change)) < 0.0005) return setError("Enter a positive or negative quantity change.");
    if (after < 0) return setError("The batch quantity cannot become negative.");
    if (reason.trim().length < 3) return setError("Adjustment reason is required.");
    await onSubmit({ batch_id: batch.id, quantity_change: change, reason, notes });
  }
  return <Modal title={`Adjust batch ${batch.batch_number}`} onClose={onClose}>
    <form className="batch-form" onSubmit={submit}>
      <section className="batch-adjust-summary"><div><span>Product</span><strong>{batch.products?.name}</strong></div>
        <div><span>Current quantity</span><strong>{stockNumber(batch.quantity)} {batch.products?.unit_name}</strong></div>
        <div><span>After adjustment</span><strong>{stockNumber(after)} {batch.products?.unit_name}</strong></div></section>
      <label><span>Quantity change</span><input type="number" step="0.001" value={change} onChange={(e) => setChange(e.target.value)} placeholder="Example: -5 or 10" /></label>
      <label><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damage, expiry write-off, correction..." /></label>
      <label><span>Notes</span><textarea rows="3" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {error && <div className="notice error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}><Save size={18}/>{busy ? "Saving..." : "Save adjustment"}</button></div>
    </form>
  </Modal>;
}
