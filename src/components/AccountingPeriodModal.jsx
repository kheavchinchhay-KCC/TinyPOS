import { useState } from "react";
import Modal from "./Modal";

export default function AccountingPeriodModal({ branches, busy, onClose, onSave }) {
  const now = new Date();
  const [values, setValues] = useState({ branch_id: "", year: now.getFullYear(), month: now.getMonth() + 1, status: "closed", notes: "" });
  function set(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  return <Modal title="Accounting period" onClose={onClose}>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); onSave(values); }}>
      <label><span>Scope</span><select value={values.branch_id} onChange={(e) => set("branch_id", e.target.value)}><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <div className="form-grid two-columns"><label><span>Year</span><input type="number" min="2000" max="2200" value={values.year} onChange={(e) => set("year", e.target.value)} /></label><label><span>Month</span><select value={values.month} onChange={(e) => set("month", e.target.value)}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(2026, i, 1))}</option>)}</select></label></div>
      <label><span>Status</span><select value={values.status} onChange={(e) => set("status", e.target.value)}><option value="closed">Close period</option><option value="open">Reopen period</option></select></label>
      <label><span>Notes</span><textarea rows="3" value={values.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Optional closing note" /></label>
      <div className="notice warning">Closing a period blocks new, edited or voided manual accounting journals for that period. It does not stop normal POS sales or purchases.</div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save period"}</button></div>
    </form>
  </Modal>;
}
