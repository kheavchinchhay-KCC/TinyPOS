import Modal from "./Modal";
import { useState } from "react";
import { payrollMoney } from "../lib/payroll";
export default function PayrollPaymentModal({ line, busy, onClose, onSave }) {
  const outstanding = Math.max(0, Number(line.net_pay || 0) - Number(line.paid_amount || 0));
  const [form, setForm] = useState({ payroll_line_id: line.id, amount: outstanding, payment_method: "cash", reference_number: "", notes: "", paid_at: new Date().toISOString().slice(0, 16) });
  return <Modal title={`Pay salary · ${line.profiles?.full_name || "Staff"}`} onClose={onClose}><form className="modal-form" onSubmit={(e) => { e.preventDefault(); onSave({ ...form, paid_at: new Date(form.paid_at).toISOString() }); }}>
    <div className="payroll-adjust-summary"><span>Net pay <strong>{payrollMoney(line.net_pay, line.currency)}</strong></span><span>Outstanding <strong>{payrollMoney(outstanding, line.currency)}</strong></span></div>
    <div className="form-grid two">
      <label><span>Payment amount</span><input type="number" min="0.01" max={outstanding} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
      <label><span>Payment method</span><select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}><option value="cash">Cash</option><option value="bank">Bank</option><option value="other">Other</option></select></label>
      <label><span>Paid at</span><input type="datetime-local" value={form.paid_at} onChange={(e) => setForm({ ...form, paid_at: e.target.value })} required /></label>
      <label><span>Reference number</span><input value={form.reference_number} onChange={(e) => setForm({ ...form, reference_number: e.target.value })} /></label>
    </div>
    <label><span>Notes</span><textarea rows="3" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
    {form.payment_method === "cash" && <div className="notice warning">Cash salary payment requires an open Cash Register for the employee branch.</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Paying..." : "Record payment"}</button></div>
  </form></Modal>;
}
