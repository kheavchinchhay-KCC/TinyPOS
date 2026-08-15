import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Eye,
  Printer,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Search
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ReceiptModal from "../components/ReceiptModal";
import RefundModal from "../components/RefundModal";
import ApprovalRequestModal from "../components/ApprovalRequestModal";
import ListViewControls, { defaultListView } from "../components/ListViewControls";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import ReturnReceiptModal from "../components/ReturnReceiptModal";
import DateRangePresetFields from "../components/DateRangePresetFields";
import { money, stockNumber } from "../lib/catalog";
import {
  defaultReturnDateRange,
  loadReturnsWorkspace,
  processSaleReturn
} from "../lib/returns";
import {
  estimateReturnAmount,
  refundApprovalRequirement,
  returnApprovalPayload
} from "../lib/permissions";

function dateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function searchableSale(sale) {
  return [
    sale.invoice_number,
    sale.customers?.name,
    sale.customers?.phone,
    sale.cashier_name,
    ...(sale.sale_items || []).flatMap((item) => [
      item.product_name,
      item.barcode
    ])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function searchableReturn(refund) {
  return [
    refund.return_number,
    refund.sales?.invoice_number,
    refund.sales?.customers?.name,
    refund.sales?.customers?.phone,
    refund.reason,
    ...(refund.return_items || []).flatMap((item) => [
      item.sale_items?.product_name,
      item.sale_items?.barcode
    ])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function ReturnsPage() {
  const {
    supabase,
    profile,
    shop,
    access,
    can
  } = useAuth();

  const [searchParams] = useSearchParams();
  const invoiceFromUrl =
    searchParams.get("invoice") || "";
  const dateFromUrl =
    searchParams.get("date") || "";
  const canRefund =
    can("returns.process");

  const [filters, setFilters] = useState(() =>
    dateFromUrl
      ? { from: dateFromUrl, to: dateFromUrl }
      : defaultReturnDateRange()
  );
  const [search, setSearch] = useState(invoiceFromUrl);
  const [tab, setTab] = useState("sales");
  const [sales, setSales] = useState([]);
  const [returns, setReturns] = useState([]);
  const [refundPolicy, setRefundPolicy] = useState(null);
  const [selectedSale, setSelectedSale] = useState(null);
  const [refundReceipt, setRefundReceipt] = useState(null);
  const [saleReceipt, setSaleReceipt] = useState(null);
  const [historyReceipt, setHistoryReceipt] = useState(null);
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [pendingRefund, setPendingRefund] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [salesViewMode, setSalesViewMode] = useState(defaultListView);
  const [historyViewMode, setHistoryViewMode] = useState(defaultListView);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) {
      return;
    }

    try {
      setLoading(true);
      const data = await loadReturnsWorkspace(
        supabase,
        profile,
        filters
      );
      setSales(data.sales);
      setReturns(data.returns);
      setRefundPolicy(data.refundPolicy || null);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!invoiceFromUrl) return;

    setSearch(invoiceFromUrl);
    setTab("sales");

    if (dateFromUrl) {
      setFilters({
        from: dateFromUrl,
        to: dateFromUrl
      });
    }
  }, [invoiceFromUrl, dateFromUrl]);

  const filteredSales = useMemo(() => {
    const needle = search.trim().toLowerCase();

    if (!needle) return sales;

    return sales.filter((sale) =>
      searchableSale(sale).includes(needle)
    );
  }, [sales, search]);

  const filteredReturns = useMemo(() => {
    const needle = search.trim().toLowerCase();

    if (!needle) return returns;

    return returns.filter((refund) =>
      searchableReturn(refund).includes(needle)
    );
  }, [returns, search]);

  useEffect(() => {
    setPage(1);
  }, [tab, search, filters.from, filters.to, pageSize]);

  const activeTotal = tab === "sales" ? filteredSales.length : filteredReturns.length;
  const totalPages = Math.max(1, Math.ceil(activeTotal / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedSales = filteredSales.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pagedReturns = filteredReturns.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const returnableColumns = [
    { label: "Invoice", value: (row) => row.invoice_number },
    { label: "Date", value: (row) => dateTime(row.completed_at || row.created_at) },
    { label: "Customer", value: (row) => row.customers?.name || "Walk-in" },
    { label: "Phone", value: (row) => row.customers?.phone || "—" },
    { label: "Cashier", value: (row) => row.cashier_name || "POS Staff" },
    { label: "Status", value: (row) => String(row.status || "").replaceAll("_", " ") },
    { label: "Total", value: (row) => money(row.total_amount, row.currency) },
    { label: "Refunded", value: (row) => money(row.refunded_amount, row.currency) },
    { label: "Returnable lines", value: (row) => (row.sale_items || []).filter((item) => Number(item.returnable_quantity || 0) > 0).length }
  ];

  const refundHistoryColumns = [
    { label: "Return", value: (row) => row.return_number },
    { label: "Original invoice", value: (row) => row.sales?.invoice_number || "—" },
    { label: "Customer", value: (row) => row.sales?.customers?.name || "Walk-in" },
    { label: "Date", value: (row) => dateTime(row.processed_at) },
    { label: "Method", value: (row) => String(row.refund_method || "").toUpperCase() },
    { label: "Amount", value: (row) => money(row.refund_amount, row.currency) },
    { label: "Reason", value: (row) => row.reason || "—" }
  ];

  function printActiveList() {
    const isSales = tab === "sales";
    printListDocument({
      title: isSales ? "Returnable Sales" : "Refund History",
      subtitle: `${filters.from} to ${filters.to} · ${activeTotal} record(s)`,
      summary: [{ label: "Search", value: search || "All records" }],
      columns: isSales ? returnableColumns : refundHistoryColumns,
      rows: isSales ? filteredSales : filteredReturns
    });
  }

  function exportActiveList() {
    const isSales = tab === "sales";
    exportListExcel({
      filename: `${isSales ? "returnable-sales" : "refund-history"}-${filters.from}-${filters.to}.xls`,
      title: isSales ? "Returnable Sales" : "Refund History",
      subtitle: `${filters.from} to ${filters.to}`,
      summary: [{ label: "Rows", value: activeTotal }],
      columns: isSales ? returnableColumns : refundHistoryColumns,
      rows: isSales ? filteredSales : filteredReturns
    });
  }

  async function openSaleReceipt(sale) {
    let receiptContext = null;

    try {
      const { data, error } = await supabase.rpc(
        "get_sale_receipt_context",
        { p_sale_id: sale.id }
      );
      if (error) throw error;
      receiptContext = data || null;
    } catch (error) {
      console.warn("Could not load exact receipt context:", error.message);
    }

    const payments = (sale.payments || []).map((payment) => ({
      id: payment.id,
      method: payment.method,
      settlement_currency: payment.currency || sale.currency,
      settlement_amount: Number(payment.amount || 0),
      tender_currency: payment.tender_currency || payment.currency || sale.currency,
      tender_amount: Number(payment.tender_amount ?? payment.tendered_amount ?? payment.amount ?? 0),
      change_amount: Number(payment.tender_change_amount ?? payment.change_amount ?? 0),
      exchange_rate: Number(payment.exchange_rate || shop?.usd_to_khr_rate || 4100),
      reference_number: payment.reference_number || null
    }));
    const payment = payments[0];
    const khmerNames = receiptContext?.product_names_km || {};

    setSaleReceipt({
      invoiceNumber: sale.invoice_number,
      completedAt: sale.completed_at || sale.created_at,
      shopName: shop?.shop_name || "Tiny POS",
      shopPhone: shop?.shop_phone,
      shopAddress: shop?.shop_address,
      footer: shop?.receipt_footer,
      cashierName: receiptContext?.cashier_name || sale.cashier_name || "POS Staff",
      customerName: sale.customers?.name,
      customerCode: sale.customers?.customer_code || null,
      customerType: sale.customers?.customer_type || null,
      cart: (sale.sale_items || []).map((item) => ({
        id: item.id,
        name: item.product_name,
        name_km: khmerNames[item.product_id] || null,
        quantity: Number(item.quantity),
        selling_price: Number(item.unit_price),
        selected_unit_price: Number(item.unit_price),
        selected_unit_name: item.sale_unit_name || "pcs",
        currency: sale.currency
      })),
      subtotal: Number(sale.subtotal || 0),
      discountAmount: Number(sale.discount_amount || 0),
      taxAmount: Number(sale.tax_amount || 0),
      totalAmount: Number(sale.total_amount || 0),
      refundedAmount: Number(sale.refunded_amount || 0),
      netTotal: Number(sale.net_total ?? Number(sale.total_amount || 0) - Number(sale.refunded_amount || 0)),
      amountReceived: sale.credit_account_id ? 0 : Number(payment?.tender_amount || sale.paid_amount || 0),
      changeAmount: sale.credit_account_id ? 0 : Number(payment?.change_amount || sale.change_amount || 0),
      paymentMethod: sale.credit_account_id
        ? "credit"
        : payments.length > 1
          ? "split"
          : payment?.method || "other",
      payments,
      exchangeRate: Number(payment?.exchange_rate || shop?.usd_to_khr_rate || 4100),
      creditDueDate: sale.credit_due_date || null,
      creditAmount: Number(sale.credit_amount || 0),
      creditOutstanding: Number(sale.credit_outstanding || 0),
      creditBalanceAfter: null,
      currency: sale.currency,
      saleStatus: sale.status
    });
  }

  function buildHistoryReceipt(refund) {
    return {
      returnNumber: refund.return_number,
      invoiceNumber: refund.sales?.invoice_number || "—",
      processedAt: refund.processed_at,
      processedBy: "POS Staff",
      customerName: refund.sales?.customers?.name,
      shopName: shop?.shop_name || "Tiny POS",
      shopPhone: shop?.shop_phone,
      shopAddress: shop?.shop_address,
      currency: refund.currency,
      refundAmount: Number(refund.refund_amount || 0),
      taxRefund: Number(refund.tax_refund || 0),
      refundMethod: refund.refund_method,
      refundReference: refund.refund_reference,
      reason: refund.reason,
      items: (refund.return_items || []).map((item) => ({
        sale_item_id: item.sale_item_id,
        product_name:
          item.sale_items?.product_name || "Returned item",
        quantity: Number(item.quantity || 0),
        unit_refund: Number(item.unit_refund || 0),
        line_refund: Number(item.line_refund || 0),
        unit_name: item.return_unit_name || item.sale_items?.sale_unit_name || "pcs",
        restock: Boolean(item.restock)
      }))
    };
  }

  async function submitRefund(
    values,
    approvalRequestId = null
  ) {
    if (!selectedSale) return;

    const refundAmount =
      estimateReturnAmount(
        selectedSale,
        values.items
      );

    const approvalNeed =
      refundApprovalRequirement(
        access,
        refundAmount,
        selectedSale.currency
      );

    if (
      approvalNeed.required
      && !approvalRequestId
    ) {
      setPendingRefund(values);

      setApprovalRequest({
        permission_key:
          "returns.refund.exceed_limit",
        action_type:
          "sale_refund",
        action_label:
          "Refund above limit",
        payload:
          returnApprovalPayload(values),
        summary: [
          `Approve ${money(
            refundAmount,
            selectedSale.currency
          )} refund`,
          selectedSale.invoice_number,
          selectedSale.customers?.name
            || "Walk-in customer"
        ].join(" · "),
        amount: refundAmount,
        currency:
          selectedSale.currency
      });

      setMessageType("error");
      setMessage(
        "This refund exceeds your individual limit. Manager approval is required."
      );
      return;
    }

    try {
      setBusy(true);
      setMessage("");

      const result =
        await processSaleReturn(
          supabase,
          {
            ...values,
            approval_request_id:
              approvalRequestId
          }
        );

      const receiptItems = values.items.map((selected) => {
        const saleItem = selectedSale.sale_items.find(
          (item) => item.id === selected.sale_item_id
        );

        const portion =
          Number(saleItem?.quantity || 0) > 0
            ? Number(selected.quantity)
              / Number(saleItem.quantity)
            : 0;

        const lineNet =
          Number(saleItem?.line_total || 0) * portion;
        const totalSaleLines = selectedSale.sale_items.reduce(
          (sum, item) => sum + Number(item.line_total || 0),
          0
        );
        const lineTax =
          totalSaleLines > 0
            ? Number(selectedSale.tax_amount || 0)
              * (Number(saleItem?.line_total || 0) / totalSaleLines)
              * portion
            : 0;
        const lineRefund =
          Math.round((lineNet + lineTax + Number.EPSILON) * 100)
          / 100;

        return {
          sale_item_id: selected.sale_item_id,
          product_name: saleItem?.product_name || "Returned item",
          quantity: Number(selected.quantity),
          unit_refund:
            Number(selected.quantity) > 0
              ? lineRefund / Number(selected.quantity)
              : 0,
          line_refund: lineRefund,
          unit_name: saleItem?.sale_unit_name || "pcs",
          restock: selected.restock
        };
      });

      setRefundReceipt({
        returnNumber: result.return_number,
        invoiceNumber: result.invoice_number,
        processedAt: result.processed_at,
        processedBy: profile.full_name || "POS Staff",
        customerName: selectedSale.customers?.name,
        shopName: shop?.shop_name || "Tiny POS",
        shopPhone: shop?.shop_phone,
        shopAddress: shop?.shop_address,
        currency: result.currency,
        refundAmount: Number(result.refund_amount || 0),
        taxRefund: Number(result.tax_refund || 0),
        refundMethod: values.refund_method,
        refundReference: values.refund_reference,
        reason: values.reason,
        items: receiptItems
      });

      setSelectedSale(null);
      setApprovalRequest(null);
      setPendingRefund(null);
      setMessageType("success");
      setMessage(
        `${result.return_number} completed. Refunded ${money(
          result.refund_amount,
          result.currency
        )}.`
      );
      await refresh();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  if (!canRefund) {
    return (
      <section className="panel empty-state">
        <RotateCcw size={46} />
        <h2>Refund access is restricted</h2>
        <p>
          This function is hidden for your account.
          Contact a manager when return access is
          required.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack returns-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">AFTER-SALES</p>
          <h1>Returns & Refunds</h1>
          <p className="muted">
            Find an invoice, refund selected quantities, and optionally
            return products to stock.
          </p>
        </div>

        <button
          type="button"
          className="secondary-button"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw
            size={18}
            className={loading ? "spin" : ""}
          />
          Refresh
        </button>
      </div>

      {message && (
        <div className={`notice ${messageType}`}>
          {message}
        </div>
      )}

      {refundPolicy && (
        <div className="refund-window-strip">
          <span>Refund permission</span>
          <strong>{refundPolicy.label || "Current date"}</strong>
          {refundPolicy.from && refundPolicy.to && (
            <small>{refundPolicy.from} to {refundPolicy.to}</small>
          )}
          {!refundPolicy.from && (
            <small>Any invoice date in the current branch</small>
          )}
        </div>
      )}

      <section className="panel returns-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search invoice, customer, phone, product or barcode"
          />
        </div>

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
      </section>

      <div className="returns-tabs">
        <button
          type="button"
          className={tab === "sales" ? "active" : ""}
          onClick={() => setTab("sales")}
        >
          <ReceiptText size={18} />
          Returnable sales
          <span>{filteredSales.length}</span>
        </button>
        <button
          type="button"
          className={tab === "history" ? "active" : ""}
          onClick={() => setTab("history")}
        >
          <CalendarDays size={18} />
          Refund history
          <span>{filteredReturns.length}</span>
        </button>
      </div>

      <ListViewControls
        viewMode={tab === "sales" ? salesViewMode : historyViewMode}
        onViewModeChange={tab === "sales" ? setSalesViewMode : setHistoryViewMode}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalRows={activeTotal}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setPage}
        onExport={exportActiveList}
        onPrint={printActiveList}
      />

      {tab === "sales" ? (
        <section className="panel return-sales-panel">
          {loading ? (
            <div className="empty-state">
              <RefreshCw className="spin" />
              <p>Loading sales...</p>
            </div>
          ) : filteredSales.length === 0 ? (
            <div className="empty-state">
              <ReceiptText size={44} />
              <h2>No sales found</h2>
              <p>Change the date range or search text.</p>
            </div>
          ) : (
            salesViewMode === "cards" ? (
              <div className="list-card-grid return-sales-list">
                {pagedSales.map((sale) => {
                  const remainingItems = (sale.sale_items || []).filter((item) => Number(item.returnable_quantity || 0) > 0);
                  const fullyRefunded = remainingItems.length === 0;
                  const refundAllowed = sale.refund_allowed !== false;
                  const refundDisabled = fullyRefunded || !refundAllowed;
                  return (
                    <article className="list-record-card return-sale-card compact-return-card" key={sale.id}>
                      <header><div><strong>{sale.invoice_number}</strong><small>{dateTime(sale.completed_at || sale.created_at)}</small></div><span className={`status-pill ${fullyRefunded ? "inactive" : "active"}`}>{String(sale.status).replaceAll("_", " ")}</span></header>
                      <div className="list-card-fields">
                        <div><span>Customer</span><strong>{sale.customers?.name || "Walk-in"}</strong></div>
                        <div><span>Cashier</span><strong>{sale.cashier_name || "POS Staff"}</strong></div>
                        <div><span>Total</span><strong>{money(sale.total_amount, sale.currency)}</strong></div>
                        <div><span>Refunded</span><strong>{money(sale.refunded_amount, sale.currency)}</strong></div>
                        <div><span>Returnable lines</span><strong>{remainingItems.length}</strong></div>
                      </div>
                      <div className="list-card-actions return-sale-actions">
                        <button type="button" className="secondary-button compact-button" onClick={() => openSaleReceipt(sale)}><Printer size={17} /> Original receipt</button>
                        <button type="button" className="danger-button compact-button" disabled={refundDisabled} title={!refundAllowed ? (sale.refund_block_reason || "Outside your refund date permission") : "Refund items"} onClick={() => setSelectedSale(sale)}><RotateCcw size={17} /> {fullyRefunded ? "Fully refunded" : !refundAllowed ? "Outside refund window" : "Refund items"}</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="wide-list-scroll returnable-sales-table-wrap">
                <table className="return-history-table returnable-sales-table">
                  <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Cashier</th><th>Status</th><th>Total</th><th>Refunded</th><th>Returnable lines</th><th>Actions</th></tr></thead>
                  <tbody>{pagedSales.map((sale) => {
                    const remainingItems = (sale.sale_items || []).filter((item) => Number(item.returnable_quantity || 0) > 0);
                    const fullyRefunded = remainingItems.length === 0;
                    const refundAllowed = sale.refund_allowed !== false;
                    const refundDisabled = fullyRefunded || !refundAllowed;
                    return <tr key={sale.id}>
                      <td><strong>{sale.invoice_number}</strong></td>
                      <td>{dateTime(sale.completed_at || sale.created_at)}</td>
                      <td>{sale.customers?.name || "Walk-in"}</td>
                      <td>{sale.cashier_name || "POS Staff"}</td>
                      <td><span className={`status-pill ${fullyRefunded ? "inactive" : "active"}`}>{String(sale.status).replaceAll("_", " ")}</span></td>
                      <td>{money(sale.total_amount, sale.currency)}</td>
                      <td>{money(sale.refunded_amount, sale.currency)}</td>
                      <td>{remainingItems.length}</td>
                      <td><div className="table-actions"><button type="button" title="Original receipt" onClick={() => openSaleReceipt(sale)}><Printer size={17} /></button><button type="button" title={!refundAllowed ? (sale.refund_block_reason || "Outside your refund date permission") : "Refund items"} disabled={refundDisabled} onClick={() => setSelectedSale(sale)}><RotateCcw size={17} /></button></div></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            )
          )}
        </section>
      ) : (
        <section className="panel return-history-panel">
          {loading ? (
            <div className="empty-state">
              <RefreshCw className="spin" />
              <p>Loading refunds...</p>
            </div>
          ) : filteredReturns.length === 0 ? (
            <div className="empty-state">
              <RotateCcw size={44} />
              <h2>No refunds found</h2>
              <p>There are no refunds in this date range.</p>
            </div>
          ) : (
            historyViewMode === "cards" ? (
              <div className="list-card-grid refund-history-card-grid">
                {pagedReturns.map((refund) => (
                  <article className="list-record-card" key={refund.id}>
                    <header><div><strong>{refund.return_number}</strong><small>{dateTime(refund.processed_at)}</small></div><span className="status-pill active">{String(refund.refund_method).toUpperCase()}</span></header>
                    <div className="list-card-fields">
                      <div><span>Original invoice</span><strong>{refund.sales?.invoice_number || "—"}</strong></div>
                      <div><span>Customer</span><strong>{refund.sales?.customers?.name || "Walk-in"}</strong></div>
                      <div><span>Amount</span><strong>{money(refund.refund_amount, refund.currency)}</strong></div>
                      <div><span>Reason</span><strong>{refund.reason || "—"}</strong></div>
                    </div>
                    <div className="list-card-actions"><button type="button" className="secondary-button compact-button" onClick={() => setHistoryReceipt(buildHistoryReceipt(refund))}><Eye size={17} /> View receipt</button></div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="return-history-table-wrap wide-list-scroll">
                <table className="return-history-table">
                  <thead><tr><th>Return</th><th>Original invoice</th><th>Customer</th><th>Date</th><th>Method</th><th>Amount</th><th>Reason</th><th /></tr></thead>
                  <tbody>{pagedReturns.map((refund) => (
                    <tr key={refund.id}>
                      <td data-label="Return"><strong>{refund.return_number}</strong></td>
                      <td data-label="Original invoice">{refund.sales?.invoice_number || "—"}</td>
                      <td data-label="Customer">{refund.sales?.customers?.name || "Walk-in"}</td>
                      <td data-label="Date">{dateTime(refund.processed_at)}</td>
                      <td data-label="Method">{String(refund.refund_method).toUpperCase()}</td>
                      <td data-label="Amount"><strong>{money(refund.refund_amount, refund.currency)}</strong></td>
                      <td data-label="Reason">{refund.reason || "—"}</td>
                      <td data-label="Receipt"><button type="button" className="icon-button" title="View refund receipt" onClick={() => setHistoryReceipt(buildHistoryReceipt(refund))}><Eye size={18} /></button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )
          )}
        </section>
      )}

      <ApprovalRequestModal
        request={approvalRequest}
        onClose={() => {
          setApprovalRequest(null);
          setPendingRefund(null);
        }}
        onApproved={(requestId) => {
          const values = pendingRefund;
          setApprovalRequest(null);
          setPendingRefund(null);

          if (values) {
            submitRefund(
              values,
              requestId
            );
          }
        }}
      />

      <RefundModal
        sale={selectedSale}
        busy={busy}
        onClose={() => setSelectedSale(null)}
        onSubmit={submitRefund}
      />

      <ReceiptModal
        receipt={saleReceipt}
        onClose={() => setSaleReceipt(null)}
      />

      <ReturnReceiptModal
        receipt={refundReceipt || historyReceipt}
        onClose={() => {
          setRefundReceipt(null);
          setHistoryReceipt(null);
        }}
      />
    </div>
  );
}
