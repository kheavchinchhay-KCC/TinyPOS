import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import Modal from "./Modal";
import { accountingMoney, isoDate } from "../lib/accounting";

const blankLine = () => ({ account_id: "", description: "", debit: "", credit: "" });

export default function ManualJournalModal({ journal, accounts, branches, defaultBranchId, busy, onClose, onSave }) {
  const [values, setValues] = useState({ entry_date: isoDate(), branch_id: defaultBranchId || "", currency: "USD", description: "", reference_number: "", source_type: "manual", lines: [blankLine(), blankLine()] });
  useEffect(() => {
    if (journal) setValues({ ...journal, branch_id: journal.branch_id || "", reference_number: journal.reference_number || "", lines: (journal.lines || []).map((line) => ({ ...line, debit: line.debit || "", credit: line.credit || "" })) });
  }, [journal]);
  const totals = useMemo(() => values.lines.reduce((sum, line) => ({ debit: sum.debit + Number(line.debit || 0), credit: sum.credit + Number(line.credit || 0) }), { debit: 0, credit: 0 }), [values.lines]);
  const balanced = totals.debit > 0 && Math.abs(totals.debit - totals.credit) < 0.005;
  function set(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  function setLine(index, key, value) { setValues((current) => ({ ...current, lines: current.lines.map((line, i) => i === index ? { ...line, [key]: value, ...(key === "debit" && value ? { credit: "" } : {}), ...(key === "credit" && value ? { debit: "" } : {}) } : line) })); }
  function removeLine(index) { setValues((current) => ({ ...current, lines: current.lines.filter((_, i) => i !== index) })); }
  function submit(event) { event.preventDefault(); if (!balanced) return; onSave(values); }
  return <Modal title={journal ? "Edit manual journal" : "New manual journal"} onClose={onClose} wide>
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid four-columns">
        <label><span>Entry date</span><input type="date" value={values.entry_date} onChange={(e) => set("entry_date", e.target.value)} required /></label>
        <label><span>Branch</span><select value={values.branch_id} onChange={(e) => set("branch_id", e.target.value)} required><option value="">Select branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label><span>Currency</span><select value={values.currency} onChange={(e) => set("currency", e.target.value)}><option value="USD">USD</option><option value="KHR">KHR</option></select></label>
        <label><span>Journal type</span><select value={values.source_type} onChange={(e) => set("source_type", e.target.value)}><option value="manual">Manual</option><option value="opening">Opening balance</option><option value="adjustment">Adjustment</option></select></label>
      </div>
      <label><span>Description</span><input value={values.description} onChange={(e) => set("description", e.target.value)} required placeholder="Month-end adjustment" /></label>
      <label><span>Reference number</span><input value={values.reference_number} onChange={(e) => set("reference_number", e.target.value)} placeholder="Optional external reference" /></label>
      <div className="journal-lines-editor">
        <div className="journal-line-head"><span>Account</span><span>Description</span><span>Debit</span><span>Credit</span><span /></div>
        {values.lines.map((line, index) => <div className="journal-line-row" key={index}>
          <select value={line.account_id} onChange={(e) => setLine(index, "account_id", e.target.value)} required><option value="">Select account</option>{accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select>
          <input value={line.description || ""} onChange={(e) => setLine(index, "description", e.target.value)} placeholder="Line description" />
          <input type="number" min="0" step="0.01" value={line.debit} onChange={(e) => setLine(index, "debit", e.target.value)} placeholder="0.00" />
          <input type="number" min="0" step="0.01" value={line.credit} onChange={(e) => setLine(index, "credit", e.target.value)} placeholder="0.00" />
          <button type="button" className="icon-button" disabled={values.lines.length <= 2} onClick={() => removeLine(index)}><Trash2 size={17} /></button>
        </div>)}
        <button type="button" className="secondary-button compact" onClick={() => set("lines", [...values.lines, blankLine()])}><Plus size={17} />Add line</button>
      </div>
      <div className={`journal-balance ${balanced ? "balanced" : "unbalanced"}`}><span>Debits <strong>{accountingMoney(totals.debit, values.currency)}</strong></span><span>Credits <strong>{accountingMoney(totals.credit, values.currency)}</strong></span><span>Difference <strong>{accountingMoney(Math.abs(totals.debit - totals.credit), values.currency)}</strong></span></div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !balanced}>{busy ? "Posting..." : "Post journal"}</button></div>
    </form>
  </Modal>;
}
