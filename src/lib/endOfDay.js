import { exportCsv } from "./reports";
import { money } from "./catalog";
import { printHtmlDocument } from "./listDocuments";

export async function loadEndOfDay(supabase, filters) {
  const { data, error } = await supabase.rpc("get_end_of_day_report", {
    p_from: filters.from,
    p_to: filters.to,
    p_branch_id: filters.allBranches ? null : filters.branchId || null,
    p_cashier_id: filters.cashierId || null,
    p_register_name: filters.registerName?.trim() || null
  });
  if (error) throw error;
  return data || {};
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function number(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function amount(value, currency) {
  return money(Number(value || 0), currency || "USD");
}

function dateOnly(value, language = "en") {
  if (!value) return "—";
  const raw = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(language === "km" ? "km-KH" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? "UTC" : undefined
  }).format(date);
}

function dateTime(value, language = "en") {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(language === "km" ? "km-KH" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function endOfDayLabels(language = "en") {
  if (language === "km") {
    return {
      title: "របាយការណ៍ចុងថ្ងៃ",
      branch: "សាខា",
      date: "កាលបរិច្ឆេទ",
      user: "បុគ្គលិក",
      allStaff: "បុគ្គលិកទាំងអស់",
      receipts: "បង្កាន់ដៃ",
      saleReceipts: "ការលក់",
      refundReceipts: "ការសងប្រាក់",
      sales: "ការលក់",
      refunds: "ការសងប្រាក់",
      netSales: "ការលក់សុទ្ធ",
      expenses: "ចំណាយ",
      cashReceived: "ទទួលសាច់ប្រាក់",
      bankReceived: "ទទួលតាមធនាគារ / KHQR",
      cardReceived: "ទទួលតាមកាត",
      creditSales: "លក់ជំពាក់",
      otherReceived: "ទទួលផ្សេងៗ",
      grossProfit: "ចំណេញដុល",
      export: "នាំចេញ",
      print: "បោះពុម្ព",
      summary: "សង្ខេប",
      collections: "ការទូទាត់ពីការលក់",
      cashActivity: "ចំណូល និងចំណាយ",
      refundDetail: "លម្អិតការសងប្រាក់",
      supplierPayments: "ការទូទាត់អ្នកផ្គត់ផ្គង់",
      staffPerformance: "លទ្ធផលបុគ្គលិក",
      registers: "ការផ្ទៀងផ្ទាត់បញ្ជរសាច់ប្រាក់",
      saleDetail: "លម្អិតការលក់"
    };
  }

  return {
    title: "End of Day Report",
    branch: "Branch",
    date: "Date",
    user: "User",
    allStaff: "All staff",
    receipts: "Receipts",
    saleReceipts: "Sale",
    refundReceipts: "Refunds",
    sales: "Sales",
    refunds: "Refunds",
    netSales: "Net sales",
    expenses: "Expenses",
    cashReceived: "Cash received",
    bankReceived: "Bank / KHQR received",
    cardReceived: "Card received",
    creditSales: "Credit sales",
    otherReceived: "Other received",
    grossProfit: "Gross profit",
    export: "Export",
    print: "Print",
    summary: "Summary",
    collections: "Sales collections",
    cashActivity: "Income & expense activity",
    refundDetail: "Refund detail",
    supplierPayments: "Supplier payments",
    staffPerformance: "Staff performance",
    registers: "Counter / register reconciliation",
    saleDetail: "Sale detail"
  };
}

export function endOfDayPeriodLabel(report, language = "en") {
  if (!report?.from && !report?.to) return "—";
  if (report?.from === report?.to) return dateOnly(report.from, language);
  return `${dateOnly(report?.from, language)} – ${dateOnly(report?.to, language)}`;
}

export function endOfDayUserLabel(report, language = "en") {
  const value = String(report?.cashier_name || "").trim();
  if (!value || value.toLowerCase() === "all users" || value.toLowerCase() === "all staff") {
    return endOfDayLabels(language).allStaff;
  }
  return value;
}

function detailTableHtml(title, columns, rows) {
  if (!rows?.length) return "";
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(column.value(row))}</td>`).join("")}</tr>`).join("");
  return `
    <section class="eod-print-section">
      <h2>${escapeHtml(title)}</h2>
      <table class="eod-print-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

function summaryRows(report, language) {
  const labels = endOfDayLabels(language);
  return (report?.summary_by_currency || []).map((row) => ({
    currency: row.currency,
    metrics: [
      [labels.sales, amount(row.gross_sales, row.currency)],
      [labels.refunds, `-${amount(row.refunds, row.currency)}`],
      [labels.netSales, amount(row.net_sales, row.currency)],
      [labels.expenses, `-${amount(row.expenses, row.currency)}`],
      [labels.cashReceived, amount(row.cash_received, row.currency)],
      [labels.bankReceived, amount(row.bank_received, row.currency)],
      [labels.cardReceived, amount(row.card_received, row.currency)],
      [labels.creditSales, amount(row.credit_sales, row.currency)],
      ...(Number(row.other_received || 0) !== 0 ? [[labels.otherReceived, amount(row.other_received, row.currency)]] : []),
      [labels.grossProfit, amount(row.gross_profit, row.currency)]
    ]
  }));
}

export function printEndOfDayReport(report, language = "en") {
  const labels = endOfDayLabels(language);
  const receiptCounts = report?.receipt_counts || {};
  const summaries = summaryRows(report, language);
  const userLabel = endOfDayUserLabel(report, language);
  const period = endOfDayPeriodLabel(report, language);

  const summaryHtml = summaries.map((group) => `
    <section class="eod-print-summary-card">
      <h2>${escapeHtml(group.currency)} ${escapeHtml(labels.summary)}</h2>
      <table>${group.metrics.map(([label, value], index) => `<tr class="${index === 2 || index === group.metrics.length - 1 ? "strong" : ""}"><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</table>
    </section>`).join("");

  const html = `
    <article class="eod-master-print">
      <header class="eod-master-print-header">
        <h1>${escapeHtml(labels.title)}</h1>
        <p><strong>${escapeHtml(labels.branch)}:</strong> ${escapeHtml(report?.branch_name || "—")}</p>
        <p><strong>${escapeHtml(labels.date)}:</strong> ${escapeHtml(period)}</p>
        <p><strong>${escapeHtml(labels.user)}:</strong> ${escapeHtml(userLabel)}</p>
      </header>

      <section class="eod-print-receipts">
        <h2>${escapeHtml(labels.receipts)}</h2>
        <div><span>${escapeHtml(labels.saleReceipts)}</span><strong>${escapeHtml(number(receiptCounts.sales))}</strong></div>
        <div><span>${escapeHtml(labels.refundReceipts)}</span><strong>${escapeHtml(number(receiptCounts.refunds))}</strong></div>
      </section>

      <div class="eod-print-summary-grid">${summaryHtml}</div>

      ${detailTableHtml(labels.collections, [
        { label: "Method", value: (row) => String(row.method || "other").toUpperCase() },
        { label: "Currency", value: (row) => row.currency },
        { label: "Transactions", value: (row) => number(row.transaction_count) },
        { label: "Amount", value: (row) => amount(row.amount, row.currency) }
      ], report?.payments || [])}

      ${detailTableHtml(labels.refundDetail, [
        { label: "Refund", value: (row) => row.return_number || "—" },
        { label: "Invoice", value: (row) => row.invoice_number || "—" },
        { label: "Date", value: (row) => dateTime(row.processed_at, language) },
        { label: "User", value: (row) => row.processed_by_name || "—" },
        { label: "Method", value: (row) => String(row.method || "").toUpperCase() },
        { label: "Currency", value: (row) => row.currency },
        { label: "Amount", value: (row) => amount(row.refund_amount, row.currency) },
        { label: "Reason", value: (row) => row.reason || "—" }
      ], report?.refunds_detail || [])}

      ${detailTableHtml(labels.cashActivity, [
        { label: "Entry", value: (row) => row.entry_number || "—" },
        { label: "Date", value: (row) => dateTime(row.entry_at, language) },
        { label: "Type", value: (row) => row.direction || "—" },
        { label: "Category", value: (row) => row.category_name || "—" },
        { label: "Method", value: (row) => String(row.method || "").toUpperCase() },
        { label: "Currency", value: (row) => row.currency },
        { label: "Amount", value: (row) => amount(row.amount, row.currency) },
        { label: "User", value: (row) => row.created_by_name || "—" }
      ], report?.expenses_detail || [])}

      ${detailTableHtml(labels.supplierPayments, [
        { label: "Method", value: (row) => String(row.method || "").toUpperCase() },
        { label: "Currency", value: (row) => row.currency },
        { label: "Transactions", value: (row) => number(row.transaction_count) },
        { label: "Amount", value: (row) => amount(row.amount, row.currency) }
      ], report?.supplier_payments || [])}

      ${detailTableHtml(labels.staffPerformance, [
        { label: "User", value: (row) => row.cashier_name || "POS Staff" },
        { label: "Currency", value: (row) => row.currency },
        { label: "Invoices", value: (row) => number(row.invoice_count) },
        { label: "Sales", value: (row) => amount(row.gross_sales, row.currency) },
        { label: "Refunds", value: (row) => amount(row.refunds, row.currency) },
        { label: "Net", value: (row) => amount(row.net_sales, row.currency) }
      ], report?.cashiers || [])}

      ${detailTableHtml(labels.registers, [
        { label: "Counter", value: (row) => row.register_name || "—" },
        { label: "User", value: (row) => row.opened_by_name || "—" },
        { label: "Status", value: (row) => row.status || "—" },
        { label: "Expected USD", value: (row) => amount(row.expected_cash_usd, "USD") },
        { label: "Counted USD", value: (row) => row.counted_cash_usd == null ? "—" : amount(row.counted_cash_usd, "USD") },
        { label: "Variance USD", value: (row) => row.variance_usd == null ? "—" : amount(row.variance_usd, "USD") },
        { label: "Expected KHR", value: (row) => amount(row.expected_cash_khr, "KHR") },
        { label: "Counted KHR", value: (row) => row.counted_cash_khr == null ? "—" : amount(row.counted_cash_khr, "KHR") },
        { label: "Variance KHR", value: (row) => row.variance_khr == null ? "—" : amount(row.variance_khr, "KHR") }
      ], report?.registers || [])}

      ${detailTableHtml(labels.saleDetail, [
        { label: "Invoice", value: (row) => row.invoice_number || "—" },
        { label: "Date", value: (row) => dateTime(row.completed_at, language) },
        { label: "Customer", value: (row) => row.customer_name || "—" },
        { label: "User", value: (row) => row.cashier_name || "—" },
        { label: "Payment", value: (row) => row.payment_methods || "—" },
        { label: "Currency", value: (row) => row.currency },
        { label: "Sales", value: (row) => amount(row.gross_total, row.currency) },
        { label: "Refund", value: (row) => amount(row.refund_total, row.currency) },
        { label: "Net", value: (row) => amount(row.net_total, row.currency) }
      ], report?.sales || [])}
    </article>`;

  const styles = `
.tiny-pos-print-frame-content{font-size:8.5px;padding:0!important;color:#111!important}
.eod-master-print{width:100%;max-width:100%;margin:0 auto}
.eod-master-print-header{text-align:center;padding:0 0 5mm;border-bottom:2px solid #111;break-inside:avoid}
.eod-master-print-header h1{margin:0 0 2.5mm;font-size:22px;line-height:1.2}
.eod-master-print-header p{margin:1mm 0;font-size:10px}
.eod-print-receipts{width:52%;margin:4mm auto;padding:3mm 4mm;border:1px solid #cbd5e1;break-inside:avoid}
.eod-print-receipts h2{margin:0 0 2mm;font-size:12px;text-align:center}
.eod-print-receipts div{display:flex;justify-content:space-between;gap:10mm;padding:1mm 0;border-bottom:1px solid #e5e7eb}.eod-print-receipts div:last-child{border:0}
.eod-print-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin:4mm 0}
.eod-print-summary-card{border:1px solid #cbd5e1;padding:3mm;break-inside:avoid}.eod-print-summary-card h2{margin:0 0 2mm;font-size:12px;text-align:center}
.eod-print-summary-card table{width:100%;border-collapse:collapse}.eod-print-summary-card th,.eod-print-summary-card td{padding:1.2mm;border-bottom:1px solid #e5e7eb}.eod-print-summary-card th{text-align:left;font-weight:500}.eod-print-summary-card td{text-align:right;font-weight:700}.eod-print-summary-card tr.strong th,.eod-print-summary-card tr.strong td{font-weight:900;border-top:1.5px solid #111}
.eod-print-section{margin-top:5mm;break-inside:auto}.eod-print-section h2{margin:0 0 2mm;font-size:12px}
.eod-print-table{width:100%!important;border-collapse:collapse!important;table-layout:fixed!important;font-size:7.5px}
.eod-print-table th,.eod-print-table td{border:1px solid #cbd5e1;padding:1.2mm;vertical-align:top;overflow-wrap:anywhere;word-break:normal}.eod-print-table th{background:#f3f4f6!important;font-weight:800}.eod-print-table thead{display:table-header-group}.eod-print-table tr{break-inside:avoid}
`;

  return printHtmlDocument({
    title: `${labels.title} - ${report?.branch_name || "Tiny POS"}`,
    html,
    styles,
    page: "A4 landscape"
  });
}

async function deliverWorkbook(blob, filename) {
  if (typeof File !== "undefined" && navigator.share) {
    try {
      const file = new File([blob], filename, { type: "application/vnd.ms-excel" });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ title: filename, files: [file] });
        return;
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function xlsRow(cells, style = "Body") {
  return `<Row>${cells.map((cell) => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>`).join("")}</Row>`;
}

function xlsSection(title, headers, rows) {
  return [
    `<Row><Cell ss:MergeAcross="${Math.max(0, headers.length - 1)}" ss:StyleID="Section"><Data ss:Type="String">${escapeXml(title)}</Data></Cell></Row>`,
    xlsRow(headers, "Header"),
    ...(rows?.length ? rows.map((row) => xlsRow(row)) : [xlsRow(["No records"])]),
    `<Row/>`
  ].join("");
}

export function exportEndOfDayWorkbook(report, language = "en") {
  const labels = endOfDayLabels(language);
  const receiptCounts = report?.receipt_counts || {};
  const period = endOfDayPeriodLabel(report, language);
  const user = endOfDayUserLabel(report, language);
  const rows = [];

  rows.push(`<Row><Cell ss:MergeAcross="11" ss:StyleID="Title"><Data ss:Type="String">${escapeXml(labels.title)}</Data></Cell></Row>`);
  rows.push(`<Row><Cell ss:MergeAcross="11" ss:StyleID="Subtitle"><Data ss:Type="String">${escapeXml(`${labels.branch}: ${report?.branch_name || "—"}`)}</Data></Cell></Row>`);
  rows.push(`<Row><Cell ss:MergeAcross="11" ss:StyleID="Subtitle"><Data ss:Type="String">${escapeXml(`${labels.date}: ${period}`)}</Data></Cell></Row>`);
  rows.push(`<Row><Cell ss:MergeAcross="11" ss:StyleID="Subtitle"><Data ss:Type="String">${escapeXml(`${labels.user}: ${user}`)}</Data></Cell></Row>`);
  rows.push(`<Row/>`);

  rows.push(xlsSection(labels.receipts, ["Type", "Count"], [
    [labels.saleReceipts, number(receiptCounts.sales)],
    [labels.refundReceipts, number(receiptCounts.refunds)]
  ]));

  for (const group of summaryRows(report, language)) {
    rows.push(xlsSection(`${group.currency} ${labels.summary}`, ["Metric", "Amount"], group.metrics));
  }

  rows.push(xlsSection(labels.collections, ["Method", "Currency", "Transactions", "Amount"], (report?.payments || []).map((row) => [
    String(row.method || "other").toUpperCase(), row.currency, number(row.transaction_count), amount(row.amount, row.currency)
  ])));

  rows.push(xlsSection(labels.refundDetail, ["Refund", "Invoice", "Date", "Customer", "User", "Method", "Currency", "Amount", "Reason"], (report?.refunds_detail || []).map((row) => [
    row.return_number || "—", row.invoice_number || "—", dateTime(row.processed_at, language), row.customer_name || "—", row.processed_by_name || "—", String(row.method || "").toUpperCase(), row.currency, amount(row.refund_amount, row.currency), row.reason || "—"
  ])));

  rows.push(xlsSection(labels.cashActivity, ["Entry", "Date", "Type", "Category", "Method", "Currency", "Amount", "User", "Reference", "Remark"], (report?.expenses_detail || []).map((row) => [
    row.entry_number || "—", dateTime(row.entry_at, language), row.direction || "—", row.category_name || "—", String(row.method || "").toUpperCase(), row.currency, amount(row.amount, row.currency), row.created_by_name || "—", row.reference_number || "—", row.remark || "—"
  ])));

  rows.push(xlsSection(labels.supplierPayments, ["Method", "Currency", "Transactions", "Amount"], (report?.supplier_payments || []).map((row) => [
    String(row.method || "").toUpperCase(), row.currency, number(row.transaction_count), amount(row.amount, row.currency)
  ])));

  rows.push(xlsSection(labels.staffPerformance, ["User", "Currency", "Invoices", "Sales", "Refunds", "Net", "Cash", "Non-cash"], (report?.cashiers || []).map((row) => [
    row.cashier_name || "POS Staff", row.currency, number(row.invoice_count), amount(row.gross_sales, row.currency), amount(row.refunds, row.currency), amount(row.net_sales, row.currency), amount(row.cash_sales, row.currency), amount(row.non_cash_sales, row.currency)
  ])));

  rows.push(xlsSection(labels.registers, ["Counter", "Session", "User", "Status", "Expected USD", "Counted USD", "Variance USD", "Expected KHR", "Counted KHR", "Variance KHR"], (report?.registers || []).map((row) => [
    row.register_name || "—", row.session_number || "—", row.opened_by_name || "—", row.status || "—", amount(row.expected_cash_usd, "USD"), row.counted_cash_usd == null ? "—" : amount(row.counted_cash_usd, "USD"), row.variance_usd == null ? "—" : amount(row.variance_usd, "USD"), amount(row.expected_cash_khr, "KHR"), row.counted_cash_khr == null ? "—" : amount(row.counted_cash_khr, "KHR"), row.variance_khr == null ? "—" : amount(row.variance_khr, "KHR")
  ])));

  rows.push(xlsSection(labels.saleDetail, ["Invoice", "Date", "Branch", "Customer", "User", "Counter", "Payment", "Currency", "Sales", "Refund", "Net", "Status"], (report?.sales || []).map((row) => [
    row.invoice_number || "—", dateTime(row.completed_at, language), row.branch_name || "—", row.customer_name || "—", row.cashier_name || "—", row.register_names || "—", row.payment_methods || "—", row.currency, amount(row.gross_total, row.currency), amount(row.refund_total, row.currency), amount(row.net_total, row.currency), row.status || "—"
  ])));

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top" ss:WrapText="1"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="Title"><Font ss:Bold="1" ss:Size="18"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>
  <Style ss:ID="Subtitle"><Font ss:Bold="1" ss:Size="11"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>
  <Style ss:ID="Section"><Font ss:Bold="1" ss:Size="12"/><Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/></Style>
  <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2563EB" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/></Style>
  <Style ss:ID="Body"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>
 </Styles>
 <Worksheet ss:Name="End of Day">
  <Table>
   <Column ss:Width="115"/><Column ss:Width="115"/><Column ss:Width="120"/><Column ss:Width="130"/><Column ss:Width="120"/><Column ss:Width="105"/><Column ss:Width="105"/><Column ss:Width="105"/><Column ss:Width="150"/><Column ss:Width="150"/><Column ss:Width="105"/><Column ss:Width="95"/>
   ${rows.join("")}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Selected/><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>
 </Worksheet>
</Workbook>`;

  const filename = `end-of-day-${report?.branch_name || "branch"}-${report?.from || "from"}-to-${report?.to || "to"}.xls`
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-");
  const blob = new Blob(["\uFEFF", xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  void deliverWorkbook(blob, filename);
}

// Kept for compatibility with older callers.
export function exportEndOfDayCsv(report, filename) {
  const rows = [];

  for (const row of report.summary_by_currency || []) {
    for (const [metric, value] of Object.entries(row)) {
      if (["currency", "invoice_count"].includes(metric)) continue;
      rows.push({ section: "Currency summary", group: row.currency, name: metric.replaceAll("_", " "), method: "", currency: row.currency, count: "", amount: value, note: "" });
    }
    rows.push({ section: "Currency summary", group: row.currency, name: "invoice count", method: "", currency: row.currency, count: row.invoice_count, amount: "", note: "" });
  }

  for (const row of report.payments || []) rows.push({ section: "Sales collection", group: "", name: "Sales payment", method: row.method, currency: row.currency, count: row.transaction_count, amount: row.amount, note: "" });
  for (const row of report.cash_activity || []) rows.push({ section: "Cash activity", group: row.direction, name: row.category_name, method: row.method, currency: row.currency, count: row.transaction_count, amount: row.amount, note: row.affects_profit ? "Affects profit" : "Does not affect profit" });
  for (const row of report.supplier_payments || []) rows.push({ section: "Supplier payment", group: "", name: "Purchase payment", method: row.method, currency: row.currency, count: row.transaction_count, amount: row.amount, note: "" });
  for (const row of report.cashiers || []) rows.push({ section: "User", group: row.cashier_name, name: "Net sales", method: `Cash ${row.cash_sales}; Non-cash ${row.non_cash_sales}`, currency: row.currency, count: row.invoice_count, amount: row.net_sales, note: `Gross ${row.gross_sales}; Refunds ${row.refunds}` });
  for (const row of report.registers || []) {
    rows.push({ section: "Register", group: row.register_name, name: row.session_number, method: row.status, currency: "USD", count: "", amount: row.expected_cash_usd, note: `Counted ${row.counted_cash_usd ?? ""}; variance ${row.variance_usd ?? ""}` });
    rows.push({ section: "Register", group: row.register_name, name: row.session_number, method: row.status, currency: "KHR", count: "", amount: row.expected_cash_khr, note: `Counted ${row.counted_cash_khr ?? ""}; variance ${row.variance_khr ?? ""}` });
  }
  for (const row of report.sales || []) rows.push({ section: "Sale detail", group: row.cashier_name, name: row.invoice_number, method: row.payment_methods, currency: row.currency, count: 1, amount: row.net_total, note: `${row.completed_at} | ${row.customer_name} | ${row.register_names} | gross ${row.gross_total} | refund ${row.refund_total}` });

  exportCsv(filename, [
    { label: "Section", value: "section" },
    { label: "Group / User", value: "group" },
    { label: "Metric / Document", value: "name" },
    { label: "Method / Status", value: "method" },
    { label: "Currency", value: "currency" },
    { label: "Count", value: "count" },
    { label: "Amount", value: "amount" },
    { label: "Note", value: "note" }
  ], rows);
}
