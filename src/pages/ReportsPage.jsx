import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeDollarSign,
  BarChart3,
  Boxes,
  CalendarRange,
  CircleDollarSign,
  PackageSearch,
  Percent,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  ShoppingBasket,
  TrendingUp,
  UserRoundCheck,
  UsersRound,
  WalletCards,
  Warehouse,
  Landmark,
  TrendingDown,
  ClipboardCheck
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { money, stockNumber } from "../lib/catalog";
import {
  defaultReportRange,
  formatPercent,
  formatReportDate,
  loadReports
} from "../lib/reports";
import ReportMetricCard from "../components/ReportMetricCard";
import ReportBarChart from "../components/ReportBarChart";
import ResponsiveDataList from "../components/ResponsiveDataList";
import EndOfDayReport from "../components/EndOfDayReport";
import DateRangePresetFields from "../components/DateRangePresetFields";
import { loadEndOfDay } from "../lib/endOfDay";

const tabs = [
  ["sales", "Sales Summary", ReceiptText],
  ["profit", "Profit & Loss", TrendingUp],
  ["stock", "Stock Analysis", Warehouse],
  ["customers", "Customer Analysis", UsersRound],
  ["endofday", "End of Day", ClipboardCheck]
];

function number(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits
  }).format(Number(value || 0));
}

function reportMoney(value, currency) {
  return money(Number(value || 0), currency || "USD");
}

function titlePeriod(data) {
  if (!data?.from || !data?.to) return "";
  return `${formatReportDate(data.from, { short: true })} – ${formatReportDate(data.to, { short: true })}`;
}

function reportDateKey(value) {
  if (!value) return "";
  const text = String(value);
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})$/);
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

function inSelectedRange(value, from, to) {
  const key = reportDateKey(value);
  return Boolean(key && key >= from && key <= to);
}

export default function ReportsPage() {
  const { supabase, profile, shop, can } = useAuth();
  const [filters, setFilters] = useState(() => ({
    ...defaultReportRange(),
    branchId: profile?.branch_id || "",
    cashierId: "",
    registerName: ""
  }));
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [activeTab, setActiveTab] = useState("sales");
  const [data, setData] = useState(null);
  const [endOfDay, setEndOfDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const reportRequestRef = useRef(0);

  const canAllBranches = can("branches.all");
  const currency = data?.base_currency || shop?.base_currency || "USD";
  const summary = data?.summary || {};
  const stockSummary = data?.stock_summary || {};
  const customerSummary = data?.customer_summary || {};
  const cashReport = data?.cash_report || {};
  const cashSummary = cashReport?.summary || {};
  const netProfit =
    Number(summary.gross_profit || 0)
    + Number(cashSummary.other_income || 0)
    - Number(cashSummary.operating_expenses || 0);

  useEffect(() => {
    setFilters((current) => ({
      ...current,
      branchId: current.branchId || profile?.branch_id || ""
    }));
  }, [profile?.branch_id]);

  useEffect(() => {
    if (activeTab !== "endofday" || !profile?.branch_id) return;
    setFilters((current) => {
      if (!current.allBranches && current.branchId) return current;
      return {
        ...current,
        allBranches: false,
        branchId: current.branchId || profile.branch_id,
        cashierId: "",
        registerName: ""
      };
    });
  }, [activeTab, profile?.branch_id]);

  useEffect(() => {
    if (!supabase || !profile?.organization_id || !canAllBranches) {
      setBranches([]);
      return;
    }

    let active = true;

    (async () => {
      const { data: branchData, error } = await supabase
        .from("branches")
        .select("id,name,code,is_active")
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name");

      if (!active || error) return;
      setBranches(branchData || []);
    })();

    return () => {
      active = false;
    };
  }, [supabase, profile?.organization_id, canAllBranches]);

  useEffect(() => {
    if (!supabase || !profile?.organization_id) {
      setStaff([]);
      return;
    }

    let active = true;
    const selectedBranch = filters.allBranches
      ? null
      : filters.branchId || profile.branch_id;

    (async () => {
      let staffQuery = supabase
        .from("profiles")
        .select("id,full_name,email,role,branch_id,is_active")
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("full_name");

      if (selectedBranch) {
        staffQuery = staffQuery.eq("branch_id", selectedBranch);
      }

      const staffResult = await staffQuery;

      if (!active) return;
      if (!staffResult.error) setStaff(staffResult.data || []);
    })();

    return () => { active = false; };
  }, [
    supabase,
    profile?.organization_id,
    profile?.branch_id,
    filters.branchId,
    filters.allBranches
  ]);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.branch_id) return;

    const requestId = reportRequestRef.current + 1;
    reportRequestRef.current = requestId;
    try {
      setLoading(true);
      setMessage("");
      // Never leave the previous date range available for print/export while a new range loads.
      setData(null);
      setEndOfDay(null);
      const resolvedFilters = { ...filters, branchId: filters.branchId || profile.branch_id };
      const [report, eod] = await Promise.all([
        loadReports(supabase, resolvedFilters),
        loadEndOfDay(supabase, resolvedFilters)
      ]);
      if (reportRequestRef.current !== requestId) return;
      setData(report);
      setEndOfDay(eod);
    } catch (error) {
      if (reportRequestRef.current === requestId) setMessage(error.message);
    } finally {
      if (reportRequestRef.current === requestId) setLoading(false);
    }
  }, [supabase, profile?.branch_id, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const trendForChart = useMemo(
    () => (data?.trend || []).map((row) => ({
      ...row,
      label: data?.granularity === "month"
        ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${row.period}T00:00:00Z`))
        : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${row.period}T00:00:00Z`))
    })),
    [data]
  );

  const salesDetailRows = useMemo(
    () => (data?.sales_rows || []).filter((row) => inSelectedRange(row.completed_at, filters.from, filters.to)),
    [data?.sales_rows, filters.from, filters.to]
  );
  const expenseDetailRows = useMemo(
    () => (cashReport?.entries || []).filter((row) => row.direction === "expense" && inSelectedRange(row.entry_at, filters.from, filters.to)),
    [cashReport?.entries, filters.from, filters.to]
  );
  const purchaseDetailRows = useMemo(
    () => (data?.purchase_rows || []).filter((row) => inSelectedRange(row.received_at, filters.from, filters.to)),
    [data?.purchase_rows, filters.from, filters.to]
  );

  function updateFilter(name, value) {
    setFilters((current) => ({
      ...current,
      [name]: value
    }));
  }

  function SalesReport() {
    return (
      <div className="report-section-stack">
        <div className="report-metric-grid">
          <ReportMetricCard icon={CircleDollarSign} label="Gross sales" value={reportMoney(summary.gross_sales, currency)} detail={`${number(summary.sale_count, 0)} completed sales`} />
          <ReportMetricCard icon={RotateCcw} label="Refunds" value={reportMoney(summary.refunds, currency)} detail={`${number(summary.refund_count, 0)} refunds`} tone="danger" />
          <ReportMetricCard icon={BadgeDollarSign} label="Net sales" value={reportMoney(summary.net_sales, currency)} detail={`Average ${reportMoney(summary.average_sale, currency)}`} tone="success" />
          <ReportMetricCard icon={ShoppingBasket} label="Net units" value={stockNumber(summary.net_units)} detail={`${stockNumber(summary.units_returned)} units returned`} />
          <ReportMetricCard icon={Percent} label="Discounts" value={reportMoney(summary.discounts, currency)} detail={`Tax collected ${reportMoney(summary.tax_collected, currency)}`} />
          <ReportMetricCard icon={TrendingUp} label="Gross profit" value={reportMoney(summary.gross_profit, currency)} detail={`${formatPercent(summary.gross_margin_percent)} gross margin`} tone="success" />
        </div>

        <div className="report-two-column">
          <section className="panel report-panel">
            <div className="report-panel-heading">
              <div><h2>Net sales trend</h2><p>{data?.granularity === "month" ? "Monthly" : "Daily"} sales after refunds</p></div>
            </div>
            <ReportBarChart data={trendForChart} labelKey="label" valueKey="net_sales" valueFormatter={(value) => reportMoney(value, currency)} />
          </section>

          <section className="panel report-panel">
            <div className="report-panel-heading"><div><h2>Payment methods</h2><p>Collections minus refunds</p></div></div>
            <ReportBarChart data={(data?.payment_methods || []).map((row) => ({ ...row, label: String(row.method).toUpperCase() }))} labelKey="label" valueKey="net" valueFormatter={(value) => reportMoney(value, currency)} />
          </section>
        </div>

        <div className="report-two-column">
          <section className="panel report-panel">
            <div className="report-panel-heading"><div><h2>Top products</h2><p>Ranked by net revenue</p></div></div>
            <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Product</th><th>Net qty</th><th>Net revenue</th><th>Profit</th></tr></thead><tbody>{(data?.top_products || []).map((row) => <tr key={`${row.product_id}-${row.product_name}`}><td>{row.product_name}</td><td>{stockNumber(row.net_quantity)}</td><td>{reportMoney(row.net_revenue, currency)}</td><td>{reportMoney(row.gross_profit, currency)}</td></tr>)}</tbody></table></div>
          </section>

          <section className="panel report-panel">
            <div className="report-panel-heading"><div><h2>Top categories</h2><p>Net sales by category</p></div></div>
            <ReportBarChart data={data?.top_categories || []} labelKey="category_name" valueKey="net_revenue" valueFormatter={(value) => reportMoney(value, currency)} />
          </section>
        </div>

        <ResponsiveDataList
          storageKey="report-sales-detail"
          title="Sales detail"
          subtitle={`${filters.from} to ${filters.to} · ${data?.scope?.branch_name || profile?.branches?.name || "Current branch"}`}
          rows={salesDetailRows}
          filename={`report-sales-detail-${filters.from}-to-${filters.to}.xls`}
          summary={[
            { label: "Gross sales", value: reportMoney(summary.gross_sales, currency) },
            { label: "Refunds", value: reportMoney(summary.refunds, currency) },
            { label: "Net sales", value: reportMoney(summary.net_sales, currency) },
            { label: "Gross profit", value: reportMoney(summary.gross_profit, currency) }
          ]}
          columns={[
            { label: "Invoice", width: 175, documentValue: (row) => row.invoice_number, render: (row) => <><strong>{row.invoice_number}</strong><small>{row.branch_name}</small></> },
            { label: "Date", width: 150, documentValue: (row) => formatReportDate(row.completed_at, { time: true }), render: (row) => formatReportDate(row.completed_at, { time: true }) },
            { label: "Customer", width: 160, value: "customer_name" },
            { label: "Cashier", width: 140, value: "cashier_name" },
            { label: "Payment", width: 130, value: "payment_methods" },
            { label: "Gross", width: 100, documentValue: (row) => reportMoney(row.gross_total, currency), render: (row) => reportMoney(row.gross_total, currency) },
            { label: "Refund", width: 100, documentValue: (row) => reportMoney(row.refund_total, currency), render: (row) => reportMoney(row.refund_total, currency) },
            { label: "Net", width: 100, documentValue: (row) => reportMoney(row.net_total, currency), render: (row) => <strong>{reportMoney(row.net_total, currency)}</strong> },
            { label: "Profit", width: 100, documentValue: (row) => reportMoney(row.gross_profit, currency), render: (row) => reportMoney(row.gross_profit, currency) },
            { label: "Status", width: 95, documentValue: (row) => String(row.status).replaceAll("_", " "), render: (row) => <span className={`status-pill ${row.status === "completed" ? "active" : "inactive"}`}>{String(row.status).replaceAll("_", " ")}</span> }
          ]}
          renderCard={(row) => <article className="responsive-data-card report-sale-card"><header><div><strong>{row.invoice_number}</strong><small>{formatReportDate(row.completed_at, { time: true })} · {row.branch_name}</small></div><span className={`status-pill ${row.status === "completed" ? "active" : "inactive"}`}>{String(row.status).replaceAll("_", " ")}</span></header><div><span>Customer</span><strong>{row.customer_name}</strong></div><div><span>Cashier / Payment</span><strong>{row.cashier_name}</strong><small>{row.payment_methods}</small></div><div><span>Gross / Refund</span><strong>{reportMoney(row.gross_total, currency)} / {reportMoney(row.refund_total, currency)}</strong></div><div><span>Net</span><strong>{reportMoney(row.net_total, currency)}</strong></div><div><span>Profit</span><strong>{reportMoney(row.gross_profit, currency)}</strong></div></article>}
        />
      </div>
    );
  }

  function ProfitReport() {
    const expenses = (cashReport?.entries || []).filter(
      (row) => row.direction === "expense"
    );

    return (
      <div className="report-section-stack">
        <div className="report-metric-grid">
          <ReportMetricCard icon={CircleDollarSign} label="Net sales" value={reportMoney(summary.net_sales, currency)} detail={`Gross ${reportMoney(summary.gross_sales, currency)}`} />
          <ReportMetricCard icon={WalletCards} label="Net COGS" value={reportMoney(summary.net_cogs, currency)} detail={`Returned cost ${reportMoney(summary.returned_cogs, currency)}`} />
          <ReportMetricCard icon={TrendingUp} label="Gross profit" value={reportMoney(summary.gross_profit, currency)} detail={`${formatPercent(summary.gross_margin_percent)} margin`} tone="success" />
          <ReportMetricCard icon={BadgeDollarSign} label="Other income" value={reportMoney(cashSummary.other_income, currency)} detail="Profit-affecting cash-in entries" />
          <ReportMetricCard icon={TrendingDown} label="Operating expenses" value={reportMoney(cashSummary.operating_expenses, currency)} detail={`${number(cashSummary.expense_count, 0)} expense entries`} tone="danger" />
          <ReportMetricCard icon={Landmark} label="Net profit" value={reportMoney(netProfit, currency)} detail="Gross profit + other income − expenses" tone={netProfit < 0 ? "danger" : "success"} />
          <ReportMetricCard icon={PackageSearch} label="Purchases received" value={reportMoney(summary.purchase_total, currency)} detail={`${number(summary.purchase_count, 0)} purchases`} />
          <ReportMetricCard icon={BadgeDollarSign} label="Purchase paid" value={reportMoney(summary.purchase_paid, currency)} detail={`Balance ${reportMoney(Number(summary.purchase_total || 0) - Number(summary.purchase_paid || 0), currency)}`} />
          <ReportMetricCard icon={RotateCcw} label="Profit reversed" value={reportMoney(summary.profit_reversal, currency)} detail="Gross profit removed by refunds" tone="danger" />
        </div>

        <div className="report-accounting-note">
          <strong>Profit & Loss:</strong> purchases increase inventory and become cost of goods when products are sold. Therefore purchases are not subtracted again from net profit. Only categories marked “Affects Profit & Loss” are included as other income or operating expenses.
        </div>

        <div className="report-two-column">
          <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Gross profit trend</h2><p>Sales profit after refund reversals</p></div></div><ReportBarChart data={trendForChart} labelKey="label" valueKey="gross_profit" valueFormatter={(value) => reportMoney(value, currency)} /></section>
          <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Expense categories</h2><p>All cash-out categories in this period</p></div></div><ReportBarChart data={cashReport?.expense_categories || []} labelKey="category_name" valueKey="total" valueFormatter={(value) => reportMoney(value, currency)} /></section>
        </div>

        <div className="report-two-column">
          <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Top suppliers</h2><p>Purchases received in this period</p></div></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Supplier</th><th>Purchases</th><th>Total</th><th>Balance</th></tr></thead><tbody>{(data?.top_suppliers || []).map((row) => <tr key={row.supplier_name}><td>{row.supplier_name}</td><td>{number(row.purchase_count, 0)}</td><td>{reportMoney(row.purchase_total, currency)}</td><td>{reportMoney(row.balance, currency)}</td></tr>)}</tbody></table></div></section>
          <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Profit bridge</h2><p>How net profit is calculated</p></div></div><div className="report-bridge"><div><span>Gross sales</span><strong>{reportMoney(summary.gross_sales, currency)}</strong></div><div className="minus"><span>Customer refunds</span><strong>-{reportMoney(summary.refunds, currency)}</strong></div><div><span>Net sales</span><strong>{reportMoney(summary.net_sales, currency)}</strong></div><div className="minus"><span>Net cost of goods</span><strong>-{reportMoney(summary.net_cogs, currency)}</strong></div><div><span>Gross profit</span><strong>{reportMoney(summary.gross_profit, currency)}</strong></div><div><span>Other income</span><strong>+{reportMoney(cashSummary.other_income, currency)}</strong></div><div className="minus"><span>Operating expenses</span><strong>-{reportMoney(cashSummary.operating_expenses, currency)}</strong></div><div className="total"><span>Net profit</span><strong>{reportMoney(netProfit, currency)}</strong></div></div></section>
        </div>

        <ResponsiveDataList
          storageKey="report-expense-detail"
          title="Expense detail"
          subtitle={`${filters.from} to ${filters.to} · ${data?.scope?.branch_name || profile?.branches?.name || "Current branch"}`}
          rows={expenseDetailRows}
          filename={`report-expenses-${filters.from}-to-${filters.to}.xls`}
          columns={[
            { label: "Code", width: 150, documentValue: (row) => row.entry_number, render: (row) => <><strong>{row.entry_number}</strong><small>{row.reference_number || "No reference"}</small></> },
            { label: "Date", width: 150, documentValue: (row) => formatReportDate(row.entry_at, { time: true }), render: (row) => formatReportDate(row.entry_at, { time: true }) },
            { label: "Branch", width: 130, value: "branch_name" },
            { label: "Category", width: 160, value: "category_name" },
            { label: "Payment", width: 95, value: (row) => String(row.method).toUpperCase() },
            { label: "Amount", width: 120, documentValue: (row) => reportMoney(row.base_amount, currency), render: (row) => <><strong>{reportMoney(row.base_amount, currency)}</strong>{row.currency !== currency && <small>{reportMoney(row.amount, row.currency)}</small>}</> },
            { label: "Profit & Loss", width: 105, value: (row) => row.affects_profit ? "Included" : "Cash only" },
            { label: "User", width: 140, value: "created_by_name" },
            { label: "Remark", width: 240, value: (row) => row.remark || "—" }
          ]}
          renderCard={(row) => <article className="responsive-data-card report-expense-card"><header><div><strong>{row.entry_number}</strong><small>{formatReportDate(row.entry_at, { time: true })}</small></div><span className="cash-direction-pill expense">Expense</span></header><div><span>Category</span><strong>{row.category_name}</strong></div><div><span>Branch / User</span><strong>{row.branch_name}</strong><small>{row.created_by_name}</small></div><div><span>Payment</span><strong>{String(row.method).toUpperCase()}</strong></div><div><span>Amount</span><strong>{reportMoney(row.base_amount, currency)}</strong></div><div><span>Remark</span><strong>{row.remark || "—"}</strong></div></article>}
        />

        <ResponsiveDataList
          storageKey="report-purchase-detail"
          title="Purchase detail"
          subtitle={`${filters.from} to ${filters.to} · ${data?.scope?.branch_name || profile?.branches?.name || "Current branch"}`}
          rows={purchaseDetailRows}
          filename={`report-purchases-${filters.from}-to-${filters.to}.xls`}
          columns={[
            { label: "Purchase", width: 170, documentValue: (row) => row.purchase_number, render: (row) => <><strong>{row.purchase_number}</strong><small>{row.branch_name}</small></> },
            { label: "Date", width: 150, documentValue: (row) => formatReportDate(row.received_at, { time: true }), render: (row) => formatReportDate(row.received_at, { time: true }) },
            { label: "Supplier", width: 170, value: "supplier_name" },
            { label: "Supplier invoice", width: 150, value: (row) => row.supplier_invoice_number || "—" },
            { label: "Total", width: 110, documentValue: (row) => reportMoney(row.total, currency), render: (row) => reportMoney(row.total, currency) },
            { label: "Paid", width: 110, documentValue: (row) => reportMoney(row.amount_paid, currency), render: (row) => reportMoney(row.amount_paid, currency) },
            { label: "Balance", width: 110, documentValue: (row) => reportMoney(row.balance, currency), render: (row) => <strong>{reportMoney(row.balance, currency)}</strong> },
            { label: "Status", width: 100, value: "status" }
          ]}
          renderCard={(row) => <article className="responsive-data-card report-purchase-card"><header><div><strong>{row.purchase_number}</strong><small>{formatReportDate(row.received_at, { time: true })} · {row.branch_name}</small></div><span className="status-pill active">{row.status}</span></header><div><span>Supplier</span><strong>{row.supplier_name}</strong><small>{row.supplier_invoice_number || "No supplier invoice"}</small></div><div><span>Total</span><strong>{reportMoney(row.total, currency)}</strong></div><div><span>Paid</span><strong>{reportMoney(row.amount_paid, currency)}</strong></div><div><span>Balance</span><strong>{reportMoney(row.balance, currency)}</strong></div></article>}
        />
      </div>
    );
  }

  function StockReport() {
    return (
      <div className="report-section-stack">
        <div className="report-metric-grid">
          <ReportMetricCard icon={Boxes} label="Tracked products" value={number(stockSummary.product_count, 0)} detail={`${stockNumber(stockSummary.stock_units)} units`} />
          <ReportMetricCard icon={Warehouse} label="Stock cost value" value={reportMoney(stockSummary.stock_cost_value, currency)} detail="Current average cost" />
          <ReportMetricCard icon={BadgeDollarSign} label="Retail value" value={reportMoney(stockSummary.stock_retail_value, currency)} detail={`Potential margin ${reportMoney(stockSummary.potential_margin, currency)}`} />
          <ReportMetricCard icon={PackageSearch} label="Low stock" value={number(stockSummary.low_stock_count, 0)} detail={`${number(stockSummary.out_of_stock_count, 0)} out of stock`} tone="danger" />
          <ReportMetricCard icon={BarChart3} label="Negative stock" value={number(stockSummary.negative_stock_count, 0)} detail="Needs immediate correction" tone={Number(stockSummary.negative_stock_count || 0) > 0 ? "danger" : "default"} />
          <ReportMetricCard icon={CalendarRange} label="Stock-aging basis" value="Last stock in" detail="Not FIFO batch aging" />
        </div>

        <div className="report-accounting-note"><strong>Stock-aging note:</strong> {data?.stock_age_note}</div>

        <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Stock age by cost value</h2><p>Current stock grouped by the latest positive stock movement</p></div></div><ReportBarChart data={data?.stock_age || []} labelKey="bucket" valueKey="stock_value" valueFormatter={(value) => reportMoney(value, currency)} /></section>

        <ResponsiveDataList
          storageKey="report-stock-analysis-detail"
          title="Current stock analysis"
          subtitle={`${data?.scope?.branch_name || profile?.branches?.name || "Current branch"} · Report selected ${filters.from} to ${filters.to}`}
          rows={data?.stock_rows || []}
          filename={`report-stock-analysis-${filters.from}-to-${filters.to}.xls`}
          columns={[
            { label: "Product", width: 210, documentValue: (row) => row.product_name, render: (row) => <><strong>{row.product_name}</strong><small>{row.sku || row.barcode || "No code"}</small></> },
            { label: "Category", width: 140, value: "category_name" },
            { label: "Quantity", width: 95, value: (row) => stockNumber(row.quantity) },
            { label: "Cost value", width: 110, documentValue: (row) => reportMoney(row.cost_value, currency), render: (row) => reportMoney(row.cost_value, currency) },
            { label: "Retail value", width: 110, documentValue: (row) => reportMoney(row.retail_value, currency), render: (row) => reportMoney(row.retail_value, currency) },
            { label: "Margin", width: 110, documentValue: (row) => reportMoney(row.potential_margin, currency), render: (row) => reportMoney(row.potential_margin, currency) },
            { label: "Last stock in", width: 120, documentValue: (row) => formatReportDate(row.last_inbound_at), render: (row) => formatReportDate(row.last_inbound_at) },
            { label: "Age", width: 80, value: (row) => `${number(row.age_days, 0)} days` },
            { label: "Status", width: 105, documentValue: (row) => row.stock_status, render: (row) => <span className={`report-stock-status ${row.stock_status}`}>{row.stock_status}</span> }
          ]}
          renderCard={(row) => <article className="responsive-data-card report-stock-card"><header><div><strong>{row.product_name}</strong><small>{row.sku || row.barcode || "No code"}</small></div><span className={`report-stock-status ${row.stock_status}`}>{row.stock_status}</span></header><div><span>Category</span><strong>{row.category_name}</strong></div><div><span>Quantity</span><strong>{stockNumber(row.quantity)}</strong></div><div><span>Cost / Retail</span><strong>{reportMoney(row.cost_value, currency)} / {reportMoney(row.retail_value, currency)}</strong></div><div><span>Margin</span><strong>{reportMoney(row.potential_margin, currency)}</strong></div><div><span>Last stock in / Age</span><strong>{formatReportDate(row.last_inbound_at)}</strong><small>{number(row.age_days, 0)} days</small></div></article>}
        />
      </div>
    );
  }

  function CustomerReport() {
    return (
      <div className="report-section-stack">
        <div className="report-metric-grid">
          <ReportMetricCard icon={UsersRound} label="Customers" value={number(customerSummary.total_customers, 0)} detail={`${number(customerSummary.active_customers, 0)} active`} />
          <ReportMetricCard icon={UserRoundCheck} label="Customers who bought" value={number(customerSummary.customers_with_sales, 0)} detail={`${number(customerSummary.repeat_customers, 0)} repeat customers`} />
          <ReportMetricCard icon={CalendarRange} label="New customers" value={number(customerSummary.new_customers, 0)} detail={titlePeriod(data)} />
          <ReportMetricCard icon={CircleDollarSign} label="Customer net spend" value={reportMoney(customerSummary.customer_net_spend, currency)} detail={`Refunds ${reportMoney(customerSummary.customer_refunds, currency)}`} />
          <ReportMetricCard icon={WalletCards} label="Loyalty outstanding" value={number(customerSummary.loyalty_points_outstanding)} detail="Current active-customer points" />
          <ReportMetricCard icon={Percent} label="Repeat rate" value={formatPercent(Number(customerSummary.customers_with_sales || 0) > 0 ? Number(customerSummary.repeat_customers || 0) * 100 / Number(customerSummary.customers_with_sales) : 0)} detail="2 or more sales in period" />
        </div>

        <div className="report-two-column">
          <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Top customers</h2><p>Ranked by net spending</p></div></div><ReportBarChart data={data?.top_customers || []} labelKey="customer_name" valueKey="net_spend" valueFormatter={(value) => reportMoney(value, currency)} /></section>
          <section className="panel report-panel"><div className="report-panel-heading"><div><h2>Customer types</h2><p>Active profiles by type</p></div></div><ReportBarChart data={(data?.customer_types || []).map((row) => ({ ...row, label: String(row.customer_type).replaceAll("_", " ") }))} labelKey="label" valueKey="customer_count" valueFormatter={(value) => number(value, 0)} /></section>
        </div>

        <ResponsiveDataList
          storageKey="report-customer-performance"
          title="Customer performance"
          subtitle={`${filters.from} to ${filters.to} · ${data?.scope?.branch_name || profile?.branches?.name || "Current branch"}`}
          rows={data?.top_customers || []}
          filename={`report-customer-performance-${filters.from}-to-${filters.to}.xls`}
          columns={[
            { label: "Customer", width: 210, documentValue: (row) => row.customer_name, render: (row) => <><strong>{row.customer_name}</strong><small>{row.customer_code}{row.phone ? ` · ${row.phone}` : ""}</small></> },
            { label: "Type", width: 100, value: "customer_type" },
            { label: "Sales", width: 70, value: (row) => number(row.sale_count, 0) },
            { label: "Refunds", width: 70, value: (row) => number(row.refund_count, 0) },
            { label: "Gross spend", width: 110, documentValue: (row) => reportMoney(row.gross_spend, currency), render: (row) => reportMoney(row.gross_spend, currency) },
            { label: "Net spend", width: 110, documentValue: (row) => reportMoney(row.net_spend, currency), render: (row) => <strong>{reportMoney(row.net_spend, currency)}</strong> },
            { label: "Average sale", width: 110, documentValue: (row) => reportMoney(row.average_sale, currency), render: (row) => reportMoney(row.average_sale, currency) },
            { label: "Points", width: 80, value: (row) => number(row.loyalty_points) },
            { label: "Last purchase", width: 120, documentValue: (row) => formatReportDate(row.last_purchase), render: (row) => formatReportDate(row.last_purchase) }
          ]}
          renderCard={(row) => <article className="responsive-data-card report-customer-card"><header><div><strong>{row.customer_name}</strong><small>{row.customer_code}{row.phone ? ` · ${row.phone}` : ""}</small></div><span className="status-pill active">{row.customer_type}</span></header><div><span>Sales / Refunds</span><strong>{number(row.sale_count, 0)} / {number(row.refund_count, 0)}</strong></div><div><span>Gross spend</span><strong>{reportMoney(row.gross_spend, currency)}</strong></div><div><span>Net spend</span><strong>{reportMoney(row.net_spend, currency)}</strong></div><div><span>Average sale</span><strong>{reportMoney(row.average_sale, currency)}</strong></div><div><span>Points / Last purchase</span><strong>{number(row.loyalty_points)}</strong><small>{formatReportDate(row.last_purchase)}</small></div></article>}
        />
      </div>
    );
  }

  if (!can("reports.view")) {
    return <section className="panel empty-state"><BarChart3 size={46} /><h2>Reports access is restricted</h2><p>Your role cannot open management reports.</p></section>;
  }

  return (
    <div className="page-stack reports-page">
      <div className="page-heading reports-heading">
        <div><p className="eyebrow">BUSINESS INTELLIGENCE</p><h1>Reports</h1><p className="muted">Sales, net profit, expenses, purchases, stock, and customer performance.</p></div>
        <div className="heading-actions report-heading-actions"><button type="button" className="primary-button" onClick={refresh} disabled={loading}><RefreshCw size={18} className={loading ? "spin" : ""} />Refresh</button></div>
      </div>

      {message && <div className="notice error">{message}</div>}

      <section className={`panel report-filters ${activeTab === "endofday" ? "end-of-day-filter-bar" : ""}`}>
        {activeTab === "endofday" ? (
          <>
            <label className="end-of-day-branch-filter">
              <span>Branch</span>
              <select
                value={filters.branchId || profile?.branch_id || ""}
                disabled={!canAllBranches}
                onChange={(event) => setFilters((current) => ({
                  ...current,
                  allBranches: false,
                  branchId: event.target.value,
                  cashierId: "",
                  registerName: ""
                }))}
              >
                {!canAllBranches && (
                  <option value={profile?.branch_id || ""}>{profile?.branches?.name || "Current branch"}</option>
                )}
                {canAllBranches && branches.map((branch) => (
                  <option value={branch.id} key={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>

            <DateRangePresetFields
              from={filters.from}
              to={filters.to}
              onChange={(range) =>
                setFilters((current) => ({
                  ...current,
                  from: range.from,
                  to: range.to
                }))
              }
            />

            <label className="end-of-day-user-filter">
              <span>User</span>
              <select value={filters.cashierId} onChange={(event) => updateFilter("cashierId", event.target.value)}>
                <option value="">All staff</option>
                {staff.map((member) => (
                  <option value={member.id} key={member.id}>
                    {member.full_name || member.email || "POS Staff"} · {String(member.role || "staff").replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <DateRangePresetFields
              from={filters.from}
              to={filters.to}
              onChange={(range) =>
                setFilters((current) => ({
                  ...current,
                  from: range.from,
                  to: range.to
                }))
              }
            />
            {canAllBranches && <label><span>Branch scope</span><select value={filters.allBranches ? "all" : filters.branchId} onChange={(event) => { if (event.target.value === "all") setFilters((current) => ({ ...current, allBranches: true, registerName: "" })); else setFilters((current) => ({ ...current, allBranches: false, branchId: event.target.value, registerName: "" })); }}><option value="all">All branches</option>{branches.map((branch) => <option value={branch.id} key={branch.id}>{branch.name}</option>)}</select></label>}
          </>
        )}
        <div className="report-filter-summary"><span>Report scope</span><strong>{activeTab === "endofday" ? (endOfDay?.branch_name || profile?.branches?.name || "Current branch") : (data?.scope?.branch_name || profile?.branches?.name || "Current branch")}</strong><small>{data ? titlePeriod(data) : "Choose dates"}</small></div>
      </section>

      <div className="report-tabs">{tabs.map(([key, label, Icon]) => <button type="button" key={key} className={activeTab === key ? "active" : ""} onClick={() => setActiveTab(key)}><Icon size={18} />{label}</button>)}</div>

      {loading && !data ? <section className="panel empty-state"><RefreshCw className="spin" /><h2>Loading reports…</h2></section> : null}
      {data && activeTab === "sales" && <SalesReport />}
      {data && activeTab === "profit" && <ProfitReport />}
      {data && activeTab === "stock" && <StockReport />}
      {data && activeTab === "customers" && <CustomerReport />}
      {endOfDay && activeTab === "endofday" && <EndOfDayReport report={endOfDay} />}
    </div>
  );
}
