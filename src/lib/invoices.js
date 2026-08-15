export function defaultInvoiceDateRange() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return {
    from: today,
    to: today
  };
}

export function invoiceDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function invoiceDate(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(
    new Date(`${String(value).slice(0, 10)}T00:00:00`)
  );
}

export function invoiceStatusLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function paymentMethodLabel(value) {
  if (!value) return "Other";

  return String(value)
    .split(",")
    .map((part) => invoiceStatusLabel(part.trim()))
    .join(", ");
}

export async function loadInvoiceCenter(
  supabase,
  filters
) {
  const { data, error } = await supabase.rpc(
    "get_invoice_center",
    {
      p_from: filters.from,
      p_to: filters.to,
      p_search: filters.search?.trim() || null,
      p_sale_status: filters.sale_status || null,
      p_payment_status: filters.payment_status || null,
      p_payment_method: filters.payment_method || null,
      p_currency: filters.currency || null,
      p_branch_id: filters.branch_id || null,
      p_page: filters.cashier_id ? 1 : Number(filters.page || 1),
      p_page_size: filters.cashier_id ? 1000 : Number(filters.page_size || 25)
    }
  );

  if (error) throw error;

  const allRows = Array.isArray(data?.rows) ? data.rows : [];
  if (!filters.cashier_id) {
    return { meta: data?.meta || {}, summary: data?.summary || { USD: {}, KHR: {} }, rows: allRows };
  }

  const filteredRows = allRows.filter((row) => row.cashier_id === filters.cashier_id);
  const pageSize = Number(filters.page_size || 25);
  const page = Number(filters.page || 1);
  const start = (page - 1) * pageSize;
  const summary = { USD: {}, KHR: {} };
  for (const currency of ["USD", "KHR"]) {
    const rows = filteredRows.filter((row) => row.currency === currency);
    summary[currency] = rows.reduce((acc, row) => ({
      invoice_count: acc.invoice_count + 1,
      gross_sales: acc.gross_sales + Number(row.total_amount || 0),
      refunds: acc.refunds + Number(row.refunded_amount || 0),
      net_sales: acc.net_sales + Number(row.net_total || 0),
      paid_amount: acc.paid_amount + Number(row.paid_amount || 0),
      credit_outstanding: acc.credit_outstanding + Number(row.credit_outstanding || 0),
      gross_profit: acc.gross_profit + Number(row.gross_profit || 0),
      net_profit: acc.net_profit + Number(row.net_profit || 0)
    }), { invoice_count: 0, gross_sales: 0, refunds: 0, net_sales: 0, paid_amount: 0, credit_outstanding: 0, gross_profit: 0, net_profit: 0 });
  }
  return {
    meta: {
      ...(data?.meta || {}),
      page,
      page_size: pageSize,
      total_rows: filteredRows.length,
      total_pages: Math.max(1, Math.ceil(filteredRows.length / pageSize))
    },
    summary,
    rows: filteredRows.slice(start, start + pageSize)
  };
}

export function buildInvoiceReceipt(invoice, shop) {
  const salePayments = (invoice.payments || [])
    .filter((payment) => !payment.is_credit_collection);
  const initialPayment = salePayments[0] || null;
  const receiptPayments = salePayments.map((payment) => ({
    id: payment.id,
    method: payment.method,
    settlement_currency: payment.currency || invoice.currency,
    settlement_amount: Number(payment.amount || 0),
    tender_currency: payment.tender_currency || payment.currency || invoice.currency,
    tender_amount: Number(
      payment.tender_amount
      ?? payment.tendered_amount
      ?? payment.amount
      ?? 0
    ),
    change_amount: Number(
      payment.tender_change_amount
      ?? payment.change_amount
      ?? 0
    ),
    exchange_rate: Number(
      payment.exchange_rate
      || shop?.usd_to_khr_rate
      || 4100
    ),
    reference_number: payment.reference_number || null
  }));

  return {
    invoiceNumber: invoice.invoice_number,
    sourceQuoteNumber: invoice.source_quote_number,
    completedAt: invoice.completed_at || invoice.created_at,
    shopName: shop?.shop_name || "Tiny POS",
    shopPhone: shop?.shop_phone,
    shopAddress: shop?.shop_address,
    footer: shop?.receipt_footer,
    cashierName: invoice.cashier_name || "POS Staff",
    customerName: invoice.customer?.name || null,
    customerCode: invoice.customer?.customer_code || null,
    customerType: invoice.customer?.customer_type || null,
    priceListName: invoice.price_list_name || null,
    priceAdjustmentAmount: Number(invoice.price_adjustment_amount || 0),
    cart: (invoice.items || []).map((item) => ({
      id: item.id,
      name: item.product_name,
      name_km: item.product_name_km || null,
      quantity: Number(item.quantity || 0),
      selected_unit_price: Number(item.unit_price || 0),
      selected_unit_name: item.sale_unit_name || "pcs",
      currency: invoice.currency
    })),
    subtotal: Number(invoice.subtotal || 0),
    discountAmount: Number(invoice.discount_amount || 0),
    taxAmount: Number(invoice.tax_amount || 0),
    totalAmount: Number(invoice.total_amount || 0),
    refundedAmount: Number(invoice.refunded_amount || 0),
    netTotal: Number(invoice.net_total || 0),
    amountReceived: invoice.credit_account_id
      ? 0
      : Number(initialPayment?.tendered_amount || invoice.paid_amount || 0),
    changeAmount: invoice.credit_account_id
      ? 0
      : Number(initialPayment?.change_amount || invoice.change_amount || 0),
    paymentMethod: invoice.credit_account_id
      ? "credit"
      : receiptPayments.length > 1
        ? "split"
        : initialPayment?.method || invoice.payment_method || "other",
    payments: receiptPayments,
    exchangeRate: Number(
      initialPayment?.exchange_rate
      || shop?.usd_to_khr_rate
      || 4100
    ),
    creditDueDate: invoice.credit_due_date || null,
    creditAmount: Number(invoice.credit_amount || 0),
    creditOutstanding: Number(invoice.credit_outstanding || 0),
    creditBalanceAfter: null,
    currency: invoice.currency,
    saleStatus: invoice.status
  };
}

function csvCell(value) {
  const text = value === null || value === undefined
    ? ""
    : String(value);

  return `"${text.replaceAll('"', '""')}"`;
}

export function downloadInvoiceCsv(
  rows,
  filename = "tiny-pos-invoices.csv"
) {
  const headers = [
    "invoice_number",
    "completed_at",
    "branch",
    "customer_code",
    "customer_name",
    "customer_phone",
    "cashier",
    "sale_status",
    "payment_status",
    "payment_method",
    "currency",
    "subtotal",
    "price_list",
    "price_adjustment",
    "discount",
    "tax",
    "gross_total",
    "refunds",
    "net_total",
    "paid_amount",
    "credit_outstanding",
    "quotation",
    "payment_references"
  ];

  const body = rows.map((invoice) => [
    invoice.invoice_number,
    invoice.completed_at || invoice.created_at,
    invoice.branch_name,
    invoice.customer?.customer_code,
    invoice.customer?.name,
    invoice.customer?.phone,
    invoice.cashier_name,
    invoice.status,
    invoice.payment_status,
    invoice.payment_method,
    invoice.currency,
    invoice.subtotal,
    invoice.price_list_name,
    invoice.price_adjustment_amount,
    invoice.discount_amount,
    invoice.tax_amount,
    invoice.total_amount,
    invoice.refunded_amount,
    invoice.net_total,
    invoice.paid_amount,
    invoice.credit_outstanding,
    invoice.source_quote_number,
    (invoice.payments || [])
      .map((payment) => payment.reference_number)
      .filter(Boolean)
      .join(" | ")
  ]);

  const csv = [
    headers,
    ...body
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  const blob = new Blob(
    ["\uFEFF", csv],
    { type: "text/csv;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
