import { printElementDocument } from "../lib/listDocuments";
import Modal from "./Modal";
import { Printer } from "lucide-react";
import { payrollDate, payrollDuration, payrollMoney } from "../lib/payroll";
export default function PayrollPayslipModal({ line, shop, payments = [], onClose }) {
  const run = line.payroll_runs || {};
  return <Modal title="Payroll payslip" onClose={onClose} wide><div className="payslip-sheet">
    <div className="payslip-header">{shop?.shop_logo_url && <img src={shop.shop_logo_url} alt="" />}<div><h2>{shop?.shop_name || "Tiny POS"}</h2><p>{shop?.shop_address || ""}</p><strong>PAYSLIP</strong></div><div><b>{run.run_number}</b><span>{payrollDate(run.pay_date)}</span></div></div>
    <div className="payslip-meta"><span><small>Staff</small><strong>{line.profiles?.full_name}</strong></span><span><small>Branch</small><strong>{line.branches?.name}</strong></span><span><small>Period</small><strong>{payrollDate(run.period_start)} – {payrollDate(run.period_end)}</strong></span><span><small>Status</small><strong>{line.status}</strong></span></div>
    <div className="payslip-columns"><section><h3>Earnings</h3><p><span>Base pay</span><b>{payrollMoney(line.base_pay, line.currency)}</b></p><p><span>Overtime · {payrollDuration(line.overtime_minutes)}</span><b>{payrollMoney(line.overtime_pay, line.currency)}</b></p><p><span>Allowances</span><b>{payrollMoney(line.allowances, line.currency)}</b></p><p><span>Commission due</span><b>{payrollMoney(line.commission_due, line.currency)}</b></p><p className="total"><span>Gross pay</span><b>{payrollMoney(line.gross_pay, line.currency)}</b></p></section><section><h3>Deductions & payment</h3><p><span>Deductions</span><b>{payrollMoney(line.deductions, line.currency)}</b></p><p><span>Net pay</span><b>{payrollMoney(line.net_pay, line.currency)}</b></p><p><span>Paid</span><b>{payrollMoney(line.paid_amount, line.currency)}</b></p><p className="total"><span>Outstanding</span><b>{payrollMoney(Math.max(0, line.net_pay-line.paid_amount), line.currency)}</b></p></section></div>
    <div className="payslip-work"><span>Worked <b>{payrollDuration(line.work_minutes)}</b></span><span>Scheduled days <b>{line.scheduled_days}</b></span><span>Attendance days <b>{line.paid_days}</b></span><span>Absent days <b>{line.absent_days}</b></span></div>
    {payments.length > 0 && <div className="payslip-payments"><h3>Payment history</h3>{payments.map((row) => <p key={row.id}><span>{row.payment_number} · {row.payment_method} · {new Date(row.paid_at).toLocaleDateString("en-US")}</span><b>{payrollMoney(row.amount, line.currency)}</b></p>)}</div>}
    <div className="payslip-signatures"><span>Prepared by</span><span>Employee signature</span><span>Approved by</span></div>
    <div className="modal-actions no-print"><button type="button" className="secondary-button" onClick={onClose}>Close</button><button type="button" className="primary-button" onClick={() => printElementDocument({ title: "Payroll Payslip", selector: ".payslip-sheet", page: "A4 portrait" })}><Printer size={18} />Print payslip</button></div>
  </div></Modal>;
}
