import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { monthRange } from "../lib/staffOperations";

export default function CommissionPayoutModal({ staff, branches, defaults = null, busy, onClose, onSave }) {
  const range = monthRange();
  const [values, setValues] = useState({ user_id: "", branch_id: "", currency: "USD", period_start: range.start, period_end: range.end, amount: "", payment_method: "cash", reference_number: "", notes: "" });
  useEffect(() => {
    if (!defaults) return;
    setValues((current) => ({ ...current, ...defaults }));
  }, [defaults]);
  function change(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card staff-modal" role="dialog" aria-modal="true" aria-label="Commission payout">
        <div className="modal-header"><div><p className="eyebrow">COMMISSION PAYOUT</p><h2>Record staff payment</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={20} /></button></div>
        <div className="form-grid two-columns">
          <label><span>Staff member</span><select name="user_id" value={values.user_id} onChange={change}><option value="">Select staff</option>{staff.map((row) => <option key={row.id} value={row.id}>{row.full_name}</option>)}</select></label>
          <label><span>Branch</span><select name="branch_id" value={values.branch_id} onChange={change}><option value="">Select branch</option>{branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label><span>Currency</span><select name="currency" value={values.currency} onChange={change}><option>USD</option><option>KHR</option></select></label>
          <label><span>Amount</span><input type="number" min="0" step={values.currency === "KHR" ? "1" : "0.01"} name="amount" value={values.amount} onChange={change} /></label>
          <label><span>Period start</span><input type="date" name="period_start" value={values.period_start} onChange={change} /></label>
          <label><span>Period end</span><input type="date" name="period_end" value={values.period_end} onChange={change} /></label>
          <label><span>Payment method</span><select name="payment_method" value={values.payment_method} onChange={change}><option value="cash">Cash</option><option value="bank">Bank</option><option value="other">Other</option></select></label>
          <label><span>Reference number</span><input name="reference_number" value={values.reference_number} onChange={change} /></label>
          <label className="full-width"><span>Notes</span><textarea rows="3" name="notes" value={values.notes} onChange={change} /></label>
        </div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={busy || !values.user_id || !values.branch_id || Number(values.amount) <= 0} onClick={() => onSave(values)}>{busy ? "Saving..." : "Record payout"}</button></div>
      </section>
    </div>
  );
}
