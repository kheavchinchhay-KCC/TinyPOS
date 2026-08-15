import Modal from "./Modal";
import { useState } from "react";
import { currentMonthRange } from "../lib/payroll";

export default function PayrollRunModal({ branches, allowAllBranches, busy, onClose, onSave }) {
  const range = currentMonthRange();
  const [form, setForm] = useState({ branch_id: "", period_start: range.start, period_end: range.end, pay_date: range.payDate, currency: "USD", notes: "" });
  const set = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  return <Modal title="Create payroll run" onClose={onClose}><form className="modal-form" onSubmit={(e) => { e.preventDefault(); onSave(form); }}>
    <div className="form-grid two">
      <label><span>Branch scope</span><select value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)}>{allowAllBranches && <option value="">All branches</option>}{!allowAllBranches && <option value="">Select branch</option>}{branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label><span>Currency</span><select value={form.currency} onChange={(e) => set("currency", e.target.value)}><option>USD</option><option>KHR</option></select></label>
      <label><span>Period start</span><input type="date" value={form.period_start} onChange={(e) => set("period_start", e.target.value)} required /></label>
      <label><span>Period end</span><input type="date" value={form.period_end} onChange={(e) => set("period_end", e.target.value)} required /></label>
      <label><span>Pay date</span><input type="date" value={form.pay_date} onChange={(e) => set("pay_date", e.target.value)} required /></label>
    </div>
    <label><span>Notes</span><textarea rows="3" value={form.notes} onChange={(e) => set("notes", e.target.value)} /></label>
    <div className="notice info">The draft calculation uses closed attendance sessions, overtime rules, fixed allowance/deduction, and unpaid commissions for this exact period.</div>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Calculating..." : "Create and calculate"}</button></div>
  </form></Modal>;
}
