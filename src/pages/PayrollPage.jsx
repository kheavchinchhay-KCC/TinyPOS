import {
  Banknote,
  Calculator,
  CheckCircle2,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  WalletCards
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import CompensationProfileModal from "../components/CompensationProfileModal";
import PayrollRunModal from "../components/PayrollRunModal";
import PayrollAdjustmentModal from "../components/PayrollAdjustmentModal";
import PayrollPaymentModal from "../components/PayrollPaymentModal";
import PayrollPayslipModal from "../components/PayrollPayslipModal";
import DateRangePresetFields from "../components/DateRangePresetFields";
import {
  adjustPayrollLine,
  approvePayrollRun,
  createPayrollRun,
  loadPayrollWorkspace,
  payPayrollLine,
  payrollDate,
  payrollDuration,
  payrollMoney,
  refreshPayrollRun,
  saveCompensationProfile
} from "../lib/payroll";

function todayIso() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function Field({ label, children }) {
  return <div className="payroll-card-field"><span>{label}</span><strong>{children}</strong></div>;
}

export default function PayrollPage() {
  const { supabase, profile, access, can, shop } = useAuth();
  const today = useMemo(() => todayIso(), []);
  const [filters, setFilters] = useState({
    date_from: today,
    date_to: today,
    branch_id: "",
    user_id: ""
  });
  const [workspace, setWorkspace] = useState({
    runs: [],
    lines: [],
    payments: [],
    profiles: [],
    staff: [],
    branches: []
  });
  const [tab, setTab] = useState("runs");
  const [selectedRun, setSelectedRun] = useState("");
  const [profileModal, setProfileModal] = useState(undefined);
  const [runModal, setRunModal] = useState(false);
  const [adjustLine, setAdjustLine] = useState(null);
  const [paymentLine, setPaymentLine] = useState(null);
  const [payslip, setPayslip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const canManage = can("payroll.manage");
  const canApprove = can("payroll.approve");
  const canPay = can("payroll.pay");
  const allBranches = can("branches.all");

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.id) return;
    try {
      setLoading(true);
      setWorkspace(await loadPayrollWorkspace(supabase, profile, access, filters));
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, access, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visibleLines = useMemo(
    () => selectedRun
      ? workspace.lines.filter((row) => row.payroll_run_id === selectedRun)
      : workspace.lines,
    [workspace.lines, selectedRun]
  );

  const totals = useMemo(() => visibleLines.reduce((result, row) => {
    const currency = row.currency === "KHR" ? "KHR" : "USD";
    result[currency].gross += Number(row.gross_pay || 0);
    result[currency].net += Number(row.net_pay || 0);
    result[currency].paid += Number(row.paid_amount || 0);
    return result;
  }, {
    USD: { gross: 0, net: 0, paid: 0 },
    KHR: { gross: 0, net: 0, paid: 0 }
  }), [visibleLines]);

  const runMap = useMemo(
    () => new Map(workspace.runs.map((row) => [row.id, row])),
    [workspace.runs]
  );

  function announce(type, value) {
    setMessageType(type);
    setMessage(value);
  }

  async function action(key, job, success) {
    try {
      setBusy(key);
      await job();
      announce("success", success);
      await refresh();
      return true;
    } catch (error) {
      announce("error", error.message);
      return false;
    } finally {
      setBusy("");
    }
  }

  function lineActions(line) {
    return (
      <div className="row-actions payroll-row-actions">
        {canManage && line.status === "draft" && (
          <button type="button" title="Adjust" onClick={() => setAdjustLine(line)}>
            <Pencil size={16} />
          </button>
        )}
        <button type="button" title="Payslip" onClick={() => setPayslip(line)}>
          <FileText size={16} />
        </button>
        {canPay
          && ["approved", "partially_paid"].includes(line.status)
          && Number(line.paid_amount) < Number(line.net_pay) && (
          <button type="button" title="Pay" onClick={() => setPaymentLine(line)}>
            <Banknote size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="page-stack payroll-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PAYROLL & PAYSLIPS</p>
          <h1>Payroll Center</h1>
          <p className="muted">Calculate salary from attendance, overtime and commissions, approve liabilities and record safe partial payments.</p>
        </div>
        <div className="page-heading-actions">
          {canManage && (
            <button type="button" className="primary-button" onClick={() => setRunModal(true)}>
              <Plus size={18} /> New payroll run
            </button>
          )}
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
            <RefreshCw size={18} className={loading ? "spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {message && <div className={`notice ${messageType}`} onClick={() => setMessage("")}>{message}</div>}

      <div className="payroll-metric-grid">
        <article><span>Net payroll USD</span><strong>{payrollMoney(totals.USD.net, "USD")}</strong><small>Paid {payrollMoney(totals.USD.paid, "USD")}</small></article>
        <article><span>Outstanding USD</span><strong>{payrollMoney(Math.max(0, totals.USD.net - totals.USD.paid), "USD")}</strong><small>Selected date range</small></article>
        <article><span>Net payroll KHR</span><strong>{payrollMoney(totals.KHR.net, "KHR")}</strong><small>Paid {payrollMoney(totals.KHR.paid, "KHR")}</small></article>
        <article><span>Outstanding KHR</span><strong>{payrollMoney(Math.max(0, totals.KHR.net - totals.KHR.paid), "KHR")}</strong><small>Selected date range</small></article>
      </div>

      <section className="panel payroll-filter-panel">
        <div className="form-grid payroll-filters">
          <DateRangePresetFields
            from={filters.date_from}
            to={filters.date_to}
            onChange={(range) =>
              setFilters((current) => ({
                ...current,
                date_from: range.from,
                date_to: range.to
              }))
            }
          />
          {canManage && <label><span>Branch</span><select value={filters.branch_id} onChange={(event) => setFilters((current) => ({ ...current, branch_id: event.target.value }))}><option value="">All accessible branches</option>{workspace.branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
          {canManage && <label><span>Staff</span><select value={filters.user_id} onChange={(event) => setFilters((current) => ({ ...current, user_id: event.target.value }))}><option value="">All staff</option>{workspace.staff.map((row) => <option key={row.id} value={row.id}>{row.full_name}</option>)}</select></label>}
        </div>
      </section>

      <div className="staff-tabs" role="tablist">
        <button type="button" className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}><Calculator size={18} /> Payroll runs</button>
        {canManage && <button type="button" className={tab === "profiles" ? "active" : ""} onClick={() => setTab("profiles")}><WalletCards size={18} /> Compensation</button>}
        <button type="button" className={tab === "payments" ? "active" : ""} onClick={() => setTab("payments")}><Banknote size={18} /> Payments</button>
      </div>

      {tab === "runs" && (
        <>
          <section className="panel payroll-runs-panel">
            <div className="panel-title-row">
              <div><p className="eyebrow">PAY PERIODS</p><h2>Payroll runs</h2></div>
              <select className="compact-select" value={selectedRun} onChange={(event) => setSelectedRun(event.target.value)}>
                <option value="">All payroll runs</option>
                {workspace.runs.map((run) => <option key={run.id} value={run.id}>{run.run_number} · {run.currency} · {run.period_start} → {run.period_end}</option>)}
              </select>
            </div>
            <div className="payroll-run-list">
              {workspace.runs.map((run) => (
                <article key={run.id} className={selectedRun === run.id ? "selected" : ""} onClick={() => setSelectedRun(run.id)}>
                  <div><strong>{run.run_number}</strong><span>{run.branches?.name || "All branches"} · {run.currency}</span><small>{payrollDate(run.period_start)} – {payrollDate(run.period_end)} · Pay {payrollDate(run.pay_date)}</small></div>
                  <div>
                    <span className={`status-pill ${run.status}`}>{run.status}</span>
                    <div className="row-actions">
                      {canManage && run.status === "draft" && <button type="button" title="Recalculate" onClick={(event) => { event.stopPropagation(); action(`refresh-${run.id}`, () => refreshPayrollRun(supabase, run.id), "Payroll run recalculated."); }}><RotateCcw size={16} /></button>}
                      {canApprove && run.status === "draft" && <button type="button" title="Approve" onClick={(event) => { event.stopPropagation(); if (window.confirm("Approve and lock this payroll run?")) action(`approve-${run.id}`, () => approvePayrollRun(supabase, run.id), "Payroll approved and payslips finalized."); }}><CheckCircle2 size={16} /></button>}
                    </div>
                  </div>
                </article>
              ))}
              {!workspace.runs.length && <div className="empty-state compact"><p>No payroll runs in this period.</p></div>}
            </div>
          </section>

          <section className="panel payroll-lines-panel">
            <div className="panel-title-row"><div><p className="eyebrow">PAYSLIPS</p><h2>{selectedRun ? runMap.get(selectedRun)?.run_number : "Payroll lines"}</h2></div><small>{visibleLines.length} staff records</small></div>

            <div className="payroll-mobile-card-list">
              {visibleLines.map((line) => (
                <article className="payroll-mobile-card" key={line.id}>
                  <header><div><strong>{line.profiles?.full_name}</strong><small>{line.branches?.name} · {line.currency}</small></div><span className={`status-pill ${line.status}`}>{line.status}</span></header>
                  <div className="payroll-mobile-card-grid">
                    <Field label="Attendance">{payrollDuration(line.work_minutes)} · {line.paid_days}/{line.scheduled_days} days</Field>
                    <Field label="Base + OT">{payrollMoney(Number(line.base_pay || 0) + Number(line.overtime_pay || 0), line.currency)}</Field>
                    <Field label="Allowance">{payrollMoney(line.allowances, line.currency)}</Field>
                    <Field label="Commission">{payrollMoney(line.commission_due, line.currency)}</Field>
                    <Field label="Deductions">{payrollMoney(line.deductions, line.currency)}</Field>
                    <Field label="Net / Paid">{payrollMoney(line.net_pay, line.currency)} / {payrollMoney(line.paid_amount, line.currency)}</Field>
                  </div>
                  <footer>{lineActions(line)}</footer>
                </article>
              ))}
              {!visibleLines.length && <div className="empty-state compact"><p>No payroll lines found.</p></div>}
            </div>

            <div className="responsive-table payroll-desktop-table">
              <table><thead><tr><th>Staff</th><th>Attendance</th><th>Base + OT</th><th>Allowance</th><th>Commission</th><th>Deductions</th><th>Net / Paid</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {visibleLines.map((line) => (
                    <tr key={line.id}>
                      <td><strong>{line.profiles?.full_name}</strong><small>{line.branches?.name} · {line.currency}</small></td>
                      <td>{payrollDuration(line.work_minutes)}<small>{line.paid_days}/{line.scheduled_days} days · OT {payrollDuration(line.overtime_minutes)}</small></td>
                      <td>{payrollMoney(line.base_pay, line.currency)}<small>+ {payrollMoney(line.overtime_pay, line.currency)}</small></td>
                      <td>{payrollMoney(line.allowances, line.currency)}</td>
                      <td>{payrollMoney(line.commission_due, line.currency)}<small>Earned {payrollMoney(line.commission_earned, line.currency)}</small></td>
                      <td>{payrollMoney(line.deductions, line.currency)}</td>
                      <td><strong>{payrollMoney(line.net_pay, line.currency)}</strong><small>Paid {payrollMoney(line.paid_amount, line.currency)}</small></td>
                      <td><span className={`status-pill ${line.status}`}>{line.status}</span></td>
                      <td>{lineActions(line)}</td>
                    </tr>
                  ))}
                  {!visibleLines.length && <tr><td colSpan="9" className="empty-table">No payroll lines found.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === "profiles" && canManage && (
        <section className="panel payroll-profiles-panel">
          <div className="panel-title-row"><div><p className="eyebrow">COMPENSATION RULES</p><h2>Staff compensation profiles</h2></div><button type="button" className="primary-button" onClick={() => setProfileModal(null)}><Plus size={18} /> New profile</button></div>
          <div className="payroll-mobile-card-list">
            {workspace.profiles.map((row) => (
              <article className="payroll-mobile-card" key={row.id}>
                <header><div><strong>{row.profiles?.full_name}</strong><small>{row.branches?.name} · {row.currency}</small></div><span className={`status-pill ${row.is_active ? "active" : "inactive"}`}>{row.is_active ? "active" : "inactive"}</span></header>
                <div className="payroll-mobile-card-grid">
                  <Field label="Basis">{row.pay_basis}</Field>
                  <Field label="Base rate">{row.pay_basis === "monthly" ? payrollMoney(row.base_salary, row.currency) : `${payrollMoney(row.hourly_rate, row.currency)}/hr`}</Field>
                  <Field label="Overtime">{payrollMoney(row.overtime_rate, row.currency)}/hr</Field>
                  <Field label="Allowance">{payrollMoney(row.fixed_allowance, row.currency)}</Field>
                  <Field label="Deduction">{payrollMoney(row.fixed_deduction, row.currency)}</Field>
                </div>
                <footer><button type="button" className="secondary-button" onClick={() => setProfileModal(row)}><Pencil size={16} /> Edit</button></footer>
              </article>
            ))}
            {!workspace.profiles.length && <div className="empty-state compact"><p>No compensation profiles yet.</p></div>}
          </div>
          <div className="responsive-table payroll-desktop-table"><table><thead><tr><th>Staff</th><th>Branch</th><th>Basis</th><th>Base rate</th><th>Overtime</th><th>Allowance</th><th>Deduction</th><th>Status</th><th /></tr></thead><tbody>{workspace.profiles.map((row) => <tr key={row.id}><td><strong>{row.profiles?.full_name}</strong><small>{row.currency}</small></td><td>{row.branches?.name}</td><td>{row.pay_basis}</td><td>{row.pay_basis === "monthly" ? payrollMoney(row.base_salary, row.currency) : `${payrollMoney(row.hourly_rate, row.currency)}/hr`}</td><td>{payrollMoney(row.overtime_rate, row.currency)}/hr</td><td>{payrollMoney(row.fixed_allowance, row.currency)}</td><td>{payrollMoney(row.fixed_deduction, row.currency)}</td><td><span className={`status-pill ${row.is_active ? "active" : "inactive"}`}>{row.is_active ? "active" : "inactive"}</span></td><td><button type="button" className="icon-button" onClick={() => setProfileModal(row)}><Pencil size={16} /></button></td></tr>)}{!workspace.profiles.length && <tr><td colSpan="9" className="empty-table">No compensation profiles yet.</td></tr>}</tbody></table></div>
        </section>
      )}

      {tab === "payments" && (
        <section className="panel payroll-payments-panel">
          <div className="panel-title-row"><div><p className="eyebrow">PAYMENT HISTORY</p><h2>Salary payments</h2></div></div>
          <div className="payroll-mobile-card-list">
            {workspace.payments.map((row) => (
              <article className="payroll-mobile-card" key={row.id}>
                <header><div><strong>{row.payment_number}</strong><small>{new Date(row.paid_at).toLocaleString("en-US")}</small></div><strong>{payrollMoney(row.amount, row.payroll_runs?.currency)}</strong></header>
                <div className="payroll-mobile-card-grid">
                  <Field label="Staff">{row.payroll_run_lines?.profiles?.full_name || "—"}</Field>
                  <Field label="Payroll run">{row.payroll_runs?.run_number || "—"}</Field>
                  <Field label="Method">{row.payment_method}</Field>
                  <Field label="Reference">{row.reference_number || "—"}</Field>
                </div>
              </article>
            ))}
            {!workspace.payments.length && <div className="empty-state compact"><p>No salary payments found.</p></div>}
          </div>
          <div className="responsive-table payroll-desktop-table"><table><thead><tr><th>Paid at</th><th>Payment</th><th>Staff</th><th>Payroll run</th><th>Method</th><th>Amount</th></tr></thead><tbody>{workspace.payments.map((row) => <tr key={row.id}><td>{new Date(row.paid_at).toLocaleString("en-US")}</td><td><strong>{row.payment_number}</strong><small>{row.reference_number || "—"}</small></td><td>{row.payroll_run_lines?.profiles?.full_name}</td><td>{row.payroll_runs?.run_number}<small>{row.payroll_runs?.period_start} → {row.payroll_runs?.period_end}</small></td><td>{row.payment_method}</td><td><strong>{payrollMoney(row.amount, row.payroll_runs?.currency)}</strong></td></tr>)}{!workspace.payments.length && <tr><td colSpan="6" className="empty-table">No salary payments found.</td></tr>}</tbody></table></div>
        </section>
      )}

      {profileModal !== undefined && <CompensationProfileModal value={profileModal} staff={workspace.staff} branches={workspace.branches} busy={busy === "profile"} onClose={() => setProfileModal(undefined)} onSave={(values) => action("profile", () => saveCompensationProfile(supabase, values), "Compensation profile saved.").then((ok) => ok && setProfileModal(undefined))} />}
      {runModal && <PayrollRunModal branches={workspace.branches} allowAllBranches={allBranches} busy={busy === "run"} onClose={() => setRunModal(false)} onSave={(values) => action("run", () => createPayrollRun(supabase, values), "Payroll run created and calculated.").then((ok) => ok && setRunModal(false))} />}
      {adjustLine && <PayrollAdjustmentModal line={adjustLine} busy={busy === "adjust"} onClose={() => setAdjustLine(null)} onSave={(values) => action("adjust", () => adjustPayrollLine(supabase, values), "Payroll adjustment saved.").then((ok) => ok && setAdjustLine(null))} />}
      {paymentLine && <PayrollPaymentModal line={paymentLine} busy={busy === "payment"} onClose={() => setPaymentLine(null)} onSave={(values) => action("payment", () => payPayrollLine(supabase, values), "Salary payment recorded.").then((ok) => ok && setPaymentLine(null))} />}
      {payslip && <PayrollPayslipModal line={payslip} shop={shop} payments={workspace.payments.filter((row) => row.payroll_line_id === payslip.id)} onClose={() => setPayslip(null)} />}
    </div>
  );
}
