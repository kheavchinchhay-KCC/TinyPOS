import { Download, Printer } from "lucide-react";
import ResponsiveDataList from "./ResponsiveDataList";
import { useLanguage } from "../context/LanguageContext";
import { money } from "../lib/catalog";
import { formatReportDate } from "../lib/reports";
import {
  endOfDayLabels,
  endOfDayPeriodLabel,
  endOfDayUserLabel,
  exportEndOfDayWorkbook,
  printEndOfDayReport
} from "../lib/endOfDay";

function count(value) {
  return Number(value || 0).toLocaleString();
}

function amount(value, currency) {
  return money(Number(value || 0), currency || "USD");
}

function dateKey(value) {
  if (!value) return "";
  const direct = String(value).match(/^(\d{4}-\d{2}-\d{2})$/);
  if (direct) return direct[1];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function withinReportPeriod(value, report) {
  const key = dateKey(value);
  return Boolean(key && (!report?.from || key >= report.from) && (!report?.to || key <= report.to));
}

export default function EndOfDayReport({ report }) {
  const { language } = useLanguage();
  const labels = endOfDayLabels(language);
  const summaries = report?.summary_by_currency || [];
  const payments = report?.payments || [];
  const refundDetails = report?.refunds_detail || [];
  const cashDetails = report?.expenses_detail || [];
  const supplierPayments = report?.supplier_payments || [];
  const cashiers = report?.cashiers || [];
  const registers = report?.registers || [];
  const sales = (report?.sales || []).filter((row) => withinReportPeriod(row.completed_at, report));
  const receiptCounts = report?.receipt_counts || {};
  const period = endOfDayPeriodLabel(report, language);
  const userLabel = endOfDayUserLabel(report, language);
  const scope = `${report?.branch_name || "Current branch"} · ${period} · ${userLabel}`;
  const fileScope = `${report?.from || "from"}-to-${report?.to || "to"}`;

  return (
    <div className="report-section-stack end-of-day-report">
      <div className="end-of-day-master-actions" data-print-hide>
        <button
          type="button"
          className="secondary-button"
          onClick={() => exportEndOfDayWorkbook(report, language)}
        >
          <Download size={18} /> {labels.export}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => printEndOfDayReport(report, language)}
        >
          <Printer size={18} /> {labels.print}
        </button>
      </div>

      <section className="panel end-of-day-print-header end-of-day-master-header">
        <h1>{labels.title}</h1>
        <p><strong>{labels.branch}:</strong> {report?.branch_name || "—"}</p>
        <p><strong>{labels.date}:</strong> {period}</p>
        <p><strong>{labels.user}:</strong> {userLabel}</p>
      </section>

      <div className="end-of-day-top-summary-grid">
        <section className="panel end-of-day-receipt-card">
          <h2>{labels.receipts}</h2>
          <div><span>{labels.saleReceipts}</span><strong>{count(receiptCounts.sales)}</strong></div>
          <div><span>{labels.refundReceipts}</span><strong>{count(receiptCounts.refunds)}</strong></div>
        </section>

        <div className="end-of-day-currency-grid end-of-day-closing-grid">
          {summaries.map((row) => (
            <section className="panel report-panel end-of-day-currency-card" key={row.currency}>
              <div className="end-of-day-currency-title">
                <h2>{row.currency}</h2>
                <span>{labels.summary}</span>
              </div>
              <div className="report-table-wrap">
                <table className="report-table end-of-day-summary-table">
                  <tbody>
                    <tr><th>{labels.sales}</th><td>{amount(row.gross_sales, row.currency)}</td></tr>
                    <tr><th>{labels.refunds}</th><td>-{amount(row.refunds, row.currency)}</td></tr>
                    <tr className="summary-strong"><th>{labels.netSales}</th><td>{amount(row.net_sales, row.currency)}</td></tr>
                    <tr><th>{labels.expenses}</th><td>-{amount(row.expenses, row.currency)}</td></tr>
                    <tr><th>{labels.cashReceived}</th><td>{amount(row.cash_received, row.currency)}</td></tr>
                    <tr><th>{labels.bankReceived}</th><td>{amount(row.bank_received, row.currency)}</td></tr>
                    <tr><th>{labels.cardReceived}</th><td>{amount(row.card_received, row.currency)}</td></tr>
                    <tr><th>{labels.creditSales}</th><td>{amount(row.credit_sales, row.currency)}</td></tr>
                    {Number(row.other_received || 0) !== 0 && (
                      <tr><th>{labels.otherReceived}</th><td>{amount(row.other_received, row.currency)}</td></tr>
                    )}
                    <tr className="summary-strong end-of-day-profit-row"><th>{labels.grossProfit}</th><td>{amount(row.gross_profit, row.currency)}</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      </div>

      <ResponsiveDataList
        storageKey="eod-sales-collections"
        title={labels.collections}
        subtitle={scope}
        rows={payments}
        filename={`end-of-day-sales-collections-${fileScope}.xls`}
        columns={[
          { label: "Method", width: 120, value: (row) => String(row.method || "other").toUpperCase() },
          { label: "Currency", width: 80, value: "currency" },
          { label: "Transactions", width: 100, value: (row) => count(row.transaction_count) },
          { label: "Amount", width: 120, documentValue: (row) => amount(row.amount, row.currency), render: (row) => <strong>{amount(row.amount, row.currency)}</strong> }
        ]}
      />

      <ResponsiveDataList
        storageKey="eod-refund-detail"
        title={labels.refundDetail}
        subtitle={scope}
        rows={refundDetails}
        filename={`end-of-day-refunds-${fileScope}.xls`}
        columns={[
          { label: "Refund", width: 160, value: "return_number" },
          { label: "Invoice", width: 170, value: "invoice_number" },
          { label: "Date", width: 150, documentValue: (row) => formatReportDate(row.processed_at, { time: true }), render: (row) => formatReportDate(row.processed_at, { time: true }) },
          { label: "Customer", width: 150, value: "customer_name" },
          { label: "User", width: 140, value: "processed_by_name" },
          { label: "Method", width: 100, value: (row) => String(row.method || "").toUpperCase() },
          { label: "Currency", width: 80, value: "currency" },
          { label: "Amount", width: 110, documentValue: (row) => amount(row.refund_amount, row.currency), render: (row) => <strong>{amount(row.refund_amount, row.currency)}</strong> },
          { label: "Reason", width: 220, value: (row) => row.reason || "—" }
        ]}
      />

      <ResponsiveDataList
        storageKey="eod-cash-entry-detail"
        title={labels.cashActivity}
        subtitle={scope}
        rows={cashDetails}
        filename={`end-of-day-cash-activity-${fileScope}.xls`}
        columns={[
          { label: "Entry", width: 150, value: "entry_number" },
          { label: "Date", width: 150, documentValue: (row) => formatReportDate(row.entry_at, { time: true }), render: (row) => formatReportDate(row.entry_at, { time: true }) },
          { label: "Type", width: 90, value: "direction" },
          { label: "Category", width: 180, value: "category_name" },
          { label: "Method", width: 100, value: (row) => String(row.method || "").toUpperCase() },
          { label: "Currency", width: 80, value: "currency" },
          { label: "Amount", width: 110, documentValue: (row) => amount(row.amount, row.currency), render: (row) => <strong>{amount(row.amount, row.currency)}</strong> },
          { label: "User", width: 140, value: "created_by_name" },
          { label: "Remark", width: 220, value: (row) => row.remark || "—" }
        ]}
      />

      <ResponsiveDataList
        storageKey="eod-supplier-payments"
        title={labels.supplierPayments}
        subtitle={scope}
        rows={supplierPayments}
        filename={`end-of-day-supplier-payments-${fileScope}.xls`}
        columns={[
          { label: "Method", width: 120, value: (row) => String(row.method || "").toUpperCase() },
          { label: "Currency", width: 80, value: "currency" },
          { label: "Transactions", width: 100, value: (row) => count(row.transaction_count) },
          { label: "Amount", width: 120, documentValue: (row) => amount(row.amount, row.currency), render: (row) => <strong>{amount(row.amount, row.currency)}</strong> }
        ]}
      />

      <ResponsiveDataList
        storageKey="eod-cashier-performance"
        title={labels.staffPerformance}
        subtitle={scope}
        rows={cashiers}
        filename={`end-of-day-user-performance-${fileScope}.xls`}
        columns={[
          { label: "User", width: 180, value: (row) => row.cashier_name || "POS Staff" },
          { label: "Currency", width: 80, value: "currency" },
          { label: "Invoices", width: 80, value: (row) => count(row.invoice_count) },
          { label: "Gross", width: 110, documentValue: (row) => amount(row.gross_sales, row.currency), render: (row) => amount(row.gross_sales, row.currency) },
          { label: "Refunds", width: 110, documentValue: (row) => amount(row.refunds, row.currency), render: (row) => amount(row.refunds, row.currency) },
          { label: "Net", width: 110, documentValue: (row) => amount(row.net_sales, row.currency), render: (row) => <strong>{amount(row.net_sales, row.currency)}</strong> },
          { label: "Cash", width: 110, documentValue: (row) => amount(row.cash_sales, row.currency), render: (row) => amount(row.cash_sales, row.currency) },
          { label: "Non-cash", width: 110, documentValue: (row) => amount(row.non_cash_sales, row.currency), render: (row) => amount(row.non_cash_sales, row.currency) }
        ]}
      />

      <ResponsiveDataList
        storageKey="eod-register-reconciliation"
        title={labels.registers}
        subtitle={scope}
        rows={registers}
        filename={`end-of-day-registers-${fileScope}.xls`}
        columns={[
          { label: "Counter", width: 130, value: "register_name" },
          { label: "Session", width: 150, value: "session_number" },
          { label: "User", width: 150, value: (row) => row.opened_by_name || "—" },
          { label: "Status", width: 90, value: "status" },
          { label: "Opened", width: 150, documentValue: (row) => formatReportDate(row.opened_at, { time: true }), render: (row) => formatReportDate(row.opened_at, { time: true }) },
          { label: "Expected USD", width: 105, documentValue: (row) => amount(row.expected_cash_usd, "USD"), render: (row) => amount(row.expected_cash_usd, "USD") },
          { label: "Counted USD", width: 105, documentValue: (row) => row.counted_cash_usd == null ? "—" : amount(row.counted_cash_usd, "USD"), render: (row) => row.counted_cash_usd == null ? "—" : amount(row.counted_cash_usd, "USD") },
          { label: "Variance USD", width: 105, documentValue: (row) => row.variance_usd == null ? "—" : amount(row.variance_usd, "USD"), render: (row) => row.variance_usd == null ? "—" : amount(row.variance_usd, "USD") },
          { label: "Expected KHR", width: 115, documentValue: (row) => amount(row.expected_cash_khr, "KHR"), render: (row) => amount(row.expected_cash_khr, "KHR") },
          { label: "Counted KHR", width: 115, documentValue: (row) => row.counted_cash_khr == null ? "—" : amount(row.counted_cash_khr, "KHR"), render: (row) => row.counted_cash_khr == null ? "—" : amount(row.counted_cash_khr, "KHR") },
          { label: "Variance KHR", width: 115, documentValue: (row) => row.variance_khr == null ? "—" : amount(row.variance_khr, "KHR"), render: (row) => row.variance_khr == null ? "—" : amount(row.variance_khr, "KHR") }
        ]}
      />

      <ResponsiveDataList
        storageKey="eod-sale-detail"
        title={labels.saleDetail}
        subtitle={scope}
        rows={sales}
        filename={`end-of-day-sales-${fileScope}.xls`}
        columns={[
          { label: "Invoice", width: 175, documentValue: (row) => row.invoice_number, render: (row) => <strong>{row.invoice_number}</strong> },
          { label: "Date", width: 150, documentValue: (row) => formatReportDate(row.completed_at, { time: true }), render: (row) => formatReportDate(row.completed_at, { time: true }) },
          { label: "Branch", width: 130, value: "branch_name" },
          { label: "Customer", width: 160, value: "customer_name" },
          { label: "User", width: 140, value: "cashier_name" },
          { label: "Counter", width: 130, value: "register_names" },
          { label: "Payment", width: 130, value: "payment_methods" },
          { label: "Currency", width: 80, value: "currency" },
          { label: "Gross", width: 100, documentValue: (row) => amount(row.gross_total, row.currency), render: (row) => amount(row.gross_total, row.currency) },
          { label: "Refund", width: 100, documentValue: (row) => amount(row.refund_total, row.currency), render: (row) => amount(row.refund_total, row.currency) },
          { label: "Net", width: 100, documentValue: (row) => amount(row.net_total, row.currency), render: (row) => <strong>{amount(row.net_total, row.currency)}</strong> },
          { label: "Status", width: 90, value: "status" }
        ]}
        renderCard={(row) => <article className="responsive-data-card eod-sale-card"><header><div><strong>{row.invoice_number}</strong><small>{formatReportDate(row.completed_at, { time: true })}</small></div><span className={`status-pill ${row.status === "completed" ? "active" : "inactive"}`}>{row.status}</span></header><div><span>Customer</span><strong>{row.customer_name}</strong></div><div><span>User / Counter</span><strong>{row.cashier_name}</strong><small>{row.register_names}</small></div><div><span>Payment</span><strong>{row.payment_methods}</strong></div><div><span>Gross / Refund</span><strong>{amount(row.gross_total, row.currency)} / {amount(row.refund_total, row.currency)}</strong></div><div><span>Net</span><strong>{amount(row.net_total, row.currency)}</strong></div></article>}
      />
    </div>
  );
}
