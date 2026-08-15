import Modal from "./Modal";
import { useEffect, useState } from "react";

export default function CompensationProfileModal({ value, staff, branches, busy, onClose, onSave }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    user_id: "", branch_id: "", currency: "USD", pay_basis: "monthly",
    base_salary: "0", hourly_rate: "0", overtime_rate: "0",
    standard_minutes_per_day: "480", fixed_allowance: "0", fixed_deduction: "0",
    prorate_monthly_by_attendance: false, effective_from: today, effective_to: "",
    is_active: true, notes: ""
  });
  useEffect(() => { if (value) setForm({ ...form, ...value, effective_to: value.effective_to || "" }); }, [value]);
  const set = (name, next) => setForm((current) => ({ ...current, [name]: next }));
  function submit(event) { event.preventDefault(); onSave(form); }
  return <Modal title={value ? "Edit compensation profile" : "New compensation profile"} onClose={onClose}>
    <form className="modal-form payroll-form" onSubmit={submit}>
      <div className="form-grid two">
        <label><span>Staff member</span><select value={form.user_id} onChange={(e) => set("user_id", e.target.value)} required disabled={Boolean(value)}><option value="">Select staff</option>{staff.map((row) => <option key={row.id} value={row.id}>{row.full_name} · {row.role}</option>)}</select></label>
        <label><span>Branch</span><select value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)} required><option value="">Select branch</option>{branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label><span>Payroll currency</span><select value={form.currency} onChange={(e) => set("currency", e.target.value)}><option>USD</option><option>KHR</option></select></label>
        <label><span>Pay basis</span><select value={form.pay_basis} onChange={(e) => set("pay_basis", e.target.value)}><option value="monthly">Monthly salary</option><option value="hourly">Hourly</option></select></label>
        <label><span>Monthly base salary</span><input type="number" min="0" step="0.01" value={form.base_salary} onChange={(e) => set("base_salary", e.target.value)} /></label>
        <label><span>Hourly rate</span><input type="number" min="0" step="0.0001" value={form.hourly_rate} onChange={(e) => set("hourly_rate", e.target.value)} /></label>
        <label><span>Overtime hourly rate</span><input type="number" min="0" step="0.0001" value={form.overtime_rate} onChange={(e) => set("overtime_rate", e.target.value)} /></label>
        <label><span>Standard minutes per day</span><input type="number" min="60" max="1440" value={form.standard_minutes_per_day} onChange={(e) => set("standard_minutes_per_day", e.target.value)} /></label>
        <label><span>Fixed allowance</span><input type="number" min="0" step="0.01" value={form.fixed_allowance} onChange={(e) => set("fixed_allowance", e.target.value)} /></label>
        <label><span>Fixed deduction</span><input type="number" min="0" step="0.01" value={form.fixed_deduction} onChange={(e) => set("fixed_deduction", e.target.value)} /></label>
        <label><span>Effective from</span><input type="date" value={form.effective_from} onChange={(e) => set("effective_from", e.target.value)} required /></label>
        <label><span>Effective to</span><input type="date" value={form.effective_to} onChange={(e) => set("effective_to", e.target.value)} /></label>
      </div>
      <label className="form-check form-switch"><input className="form-check-input" type="checkbox" checked={form.prorate_monthly_by_attendance} onChange={(e) => set("prorate_monthly_by_attendance", e.target.checked)} /><span className="form-check-label">Prorate monthly salary when recorded attendance is below scheduled time</span></label>
      <label className="form-check form-switch"><input className="form-check-input" type="checkbox" checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} /><span className="form-check-label">Active compensation profile</span></label>
      <label><span>Notes</span><textarea rows="3" value={form.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save compensation"}</button></div>
    </form>
  </Modal>;
}
