import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  Building2,
  CircleDollarSign,
  ClipboardList,
  Edit3,
  Eye,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  Truck,
  WalletCards
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { money } from "../lib/catalog";
import {
  cancelPurchaseOrder,
  dateOnly,
  dateTime,
  loadPurchaseOrderWorkspace,
  purchaseBalance,
  purchasePaymentStatus,
  purchaseReceivingStatus,
  purchaseReceivingStatusLabel,
  purchaseReceivingTotals,
  receivePurchaseOrder,
  recordPurchasePayment,
  savePurchaseOrder,
  saveSupplier
} from "../lib/purchaseOrders";
import PurchaseOrderFormModal from "../components/PurchaseOrderFormModal";
import PurchaseOrderActionModal from "../components/PurchaseOrderActionModal";
import PurchaseOrderPrintModal from "../components/PurchaseOrderPrintModal";
import PurchaseReceiptModal from "../components/PurchaseReceiptModal";
import PurchaseReceiptPrintModal from "../components/PurchaseReceiptPrintModal";
import SupplierFormModal from "../components/SupplierFormModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import DateRangePresetFields from "../components/DateRangePresetFields";

function defaultFilters() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return {
    from: today,
    to: today,
    status: "all",
    supplier: "all"
  };
}

function searchablePurchase(purchase) {
  return [
    purchase.purchase_number,
    purchase.supplier_invoice_number,
    purchase.suppliers?.supplier_code,
    purchase.suppliers?.name,
    purchase.status,
    purchaseReceivingStatusLabel(purchase),
    ...(purchase.purchase_receipts || []).flatMap((receipt) => [
      receipt.receipt_number,
      receipt.supplier_invoice_number,
      receipt.notes
    ]),
    ...(purchase.purchase_items || []).flatMap((item) => [
      item.products?.name,
      item.products?.sku,
      item.products?.barcode
    ])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}




function convertToBase(amount, currency, baseCurrency, usdToKhrRate) {
  const value = Number(amount || 0);
  const rate = Number(usdToKhrRate || 4100);

  if (currency === baseCurrency) return value;
  if (currency === "KHR" && baseCurrency === "USD") return rate > 0 ? value / rate : 0;
  if (currency === "USD" && baseCurrency === "KHR") return value * rate;
  return value;
}

function searchableSupplier(supplier) {
  return [
    supplier.supplier_code,
    supplier.name,
    supplier.contact_name,
    supplier.phone,
    supplier.email,
    supplier.address,
    supplier.tax_id
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function PurchaseOrdersPage() {
  const { supabase, profile, shop, canAny } = useAuth();
  const canManage = canAny([
    "purchases.manage",
    "purchases.receive",
    "purchases.cancel",
    "purchases.supplier_return"
  ]);

  const [tab, setTab] = useState("orders");
  const [filters, setFilters] = useState(defaultFilters);
  const [search, setSearch] = useState("");
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [editingPurchase, setEditingPurchase] = useState(null);
  const [actionPurchase, setActionPurchase] = useState(null);
  const [actionType, setActionType] = useState(null);
  const [printPurchase, setPrintPurchase] = useState(null);
  const [receivingPurchase, setReceivingPurchase] = useState(null);
  const [receiptPrint, setReceiptPrint] = useState(null);
  const [supplierFormOpen, setSupplierFormOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) return;

    try {
      setLoading(true);
      const data = await loadPurchaseOrderWorkspace(supabase, profile, filters);
      setSuppliers(data.suppliers);
      setProducts(data.products);
      setPurchases(data.purchases);
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

  const filteredPurchases = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return purchases.filter((purchase) => {
      if (
        filters.status !== "all"
        && purchaseReceivingStatus(purchase) !== filters.status
      ) {
        return false;
      }
      if (filters.supplier !== "all" && purchase.supplier_id !== filters.supplier) {
        return false;
      }
      return !needle || searchablePurchase(purchase).includes(needle);
    });
  }, [purchases, filters.status, filters.supplier, search]);

  const filteredSuppliers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return suppliers.filter(
      (supplier) => !needle || searchableSupplier(supplier).includes(needle)
    );
  }, [suppliers, search]);

  const baseCurrency = shop?.base_currency || "USD";
  const usdToKhrRate = Number(shop?.usd_to_khr_rate || 4100);

  const metrics = useMemo(() => {
    const openOrders = purchases.filter(
      (purchase) =>
        ["draft", "ordered"].includes(
          purchaseReceivingStatus(purchase)
        )
    );

    const partial = purchases.filter(
      (purchase) =>
        purchaseReceivingStatus(purchase)
          === "partially_received"
    );

    const received = purchases.filter(
      (purchase) =>
        purchaseReceivingStatus(purchase)
          === "received"
    );

    const outstanding = purchases
      .filter(
        (purchase) =>
          purchase.status !== "cancelled"
      )
      .reduce(
        (sum, purchase) =>
          sum
          + convertToBase(
              purchaseBalance(purchase),
              purchase.currency,
              baseCurrency,
              usdToKhrRate
            ),
        0
      );

    const openValue = [...openOrders, ...partial]
      .reduce(
        (sum, purchase) =>
          sum
          + convertToBase(
              purchase.total_amount,
              purchase.currency,
              baseCurrency,
              usdToKhrRate
            ),
        0
      );

    return {
      openCount: openOrders.length,
      partialCount: partial.length,
      receivedCount: received.length,
      outstanding,
      openValue
    };
  }, [purchases, baseCurrency, usdToKhrRate]);

  function showSuccess(text) {
    setMessageType("success");
    setMessage(text);
  }

  function showError(error) {
    setMessageType("error");
    setMessage(error.message || String(error));
  }

  function openNewOrder() {
    setEditingPurchase(null);
    setOrderFormOpen(true);
  }

  function openEditOrder(purchase) {
    setEditingPurchase(purchase);
    setOrderFormOpen(true);
  }

  function openAction(purchase, action) {
    setActionPurchase(purchase);
    setActionType(action);
  }

  async function handleSaveOrder(values) {
    try {
      setBusy(true);
      const result = await savePurchaseOrder(supabase, values);
      setOrderFormOpen(false);
      setEditingPurchase(null);
      showSuccess(`${result.purchase_number} saved as ${result.status}.`);
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleReceivePurchase(values) {
    try {
      setBusy(true);

      const result = await receivePurchaseOrder(
        supabase,
        values
      );

      setReceivingPurchase(null);

      showSuccess(
        `${result.receipt_number} saved. ${
          result.fully_received
            ? `${result.purchase_number} is fully received.`
            : `${result.order_remaining_units.toLocaleString(
                "en-US",
                { maximumFractionDigits: 3 }
              )} purchase units remain on backorder.`
        }`
      );

      await refresh();
    } catch (error) {
      showError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function handleOrderAction(values) {
    if (!actionPurchase) return;

    try {
      setBusy(true);
      let result;

      if (values.action === "payment") {
        result = await recordPurchasePayment(supabase, {
          purchase_id: actionPurchase.id,
          amount: values.amount,
          method: values.method,
          reference_number: values.reference,
          notes: values.notes
        });
        showSuccess(
          `Payment recorded. Balance due: ${money(
            result.balance_due,
            actionPurchase.currency
          )}.`
        );
      } else {
        result = await cancelPurchaseOrder(
          supabase,
          actionPurchase.id,
          values.reason
        );
        showSuccess(`${result.purchase_number} cancelled.`);
      }

      setActionPurchase(null);
      setActionType(null);
      await refresh();
    } catch (error) {
      showError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSupplier(values) {
    try {
      setBusy(true);
      const result = await saveSupplier(supabase, values);
      setSupplierFormOpen(false);
      setEditingSupplier(null);
      showSuccess(`${result.supplier_code} · ${result.name} saved.`);
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <ClipboardList size={46} />
        <h2>Purchase-order access is restricted</h2>
        <p>Only an owner, admin, or manager can manage suppliers and purchases.</p>
      </section>
    );
  }

  return (
    <div className="page-stack purchase-orders-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROCUREMENT</p>
          <h1>Purchase Orders</h1>
          <p className="muted">
            Create supplier orders, receive inventory, track payments, and manage suppliers.
          </p>
        </div>

        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
            <RefreshCw size={18} className={loading ? "spin" : ""} /> Refresh
          </button>
          <button type="button" className="primary-button" onClick={openNewOrder}>
            <Plus size={18} /> New purchase order
          </button>
        </div>
      </div>

      {message && <div className={`notice ${messageType}`}>{message}</div>}

      <div className="po-metrics partial-enabled">
        <article>
          <ClipboardList />
          <span>Open orders</span>
          <strong>{metrics.openCount}</strong>
          <small>
            {money(metrics.openValue, baseCurrency)} open value
          </small>
        </article>

        <article>
          <Truck />
          <span>Partially received</span>
          <strong>{metrics.partialCount}</strong>
          <small>Has remaining backorders</small>
        </article>

        <article>
          <PackageCheck />
          <span>Fully received</span>
          <strong>{metrics.receivedCount}</strong>
          <small>Completed orders in range</small>
        </article>

        <article>
          <CircleDollarSign />
          <span>Outstanding</span>
          <strong>
            {money(metrics.outstanding, baseCurrency)}
          </strong>
          <small>Unpaid supplier balance</small>
        </article>
      </div>

      <div className="po-tabs">
        <button type="button" className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
          <ClipboardList size={18} /> Orders <span>{filteredPurchases.length}</span>
        </button>
        <button type="button" className={tab === "suppliers" ? "active" : ""} onClick={() => setTab("suppliers")}>
          <Building2 size={18} /> Suppliers <span>{filteredSuppliers.length}</span>
        </button>
      </div>

      <section className="panel po-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              tab === "orders"
                ? "Search order, supplier, invoice, product or barcode"
                : "Search supplier name, code, phone or email"
            }
          />
        </div>

        {tab === "orders" && (
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
            <label>
              <span>Status</span>
              <select
                value={filters.status}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, status: event.target.value }))
                }
              >
                <option value="all">All statuses</option>
                <option value="draft">Draft</option>
                <option value="ordered">Ordered</option>
                <option value="partially_received">
                  Partially received
                </option>
                <option value="received">Received</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label>
              <span>Supplier</span>
              <select
                value={filters.supplier}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, supplier: event.target.value }))
                }
              >
                <option value="all">All suppliers</option>
                {suppliers.map((supplier) => (
                  <option value={supplier.id} key={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {tab === "suppliers" && (
          <button
            type="button"
            className="primary-button compact"
            onClick={() => {
              setEditingSupplier(null);
              setSupplierFormOpen(true);
            }}
          >
            <Plus size={18} /> Add supplier
          </button>
        )}
      </section>

      {tab === "orders" ? (
        <ResponsiveDataList
          storageKey="purchase-orders-list"
          title="Purchase orders"
          subtitle={`${filters.from} to ${filters.to} · Current supplier and status filters`}
          rows={filteredPurchases}
          filename={`tiny-pos-purchase-orders-${filters.from}-to-${filters.to}.xls`}
          summary={[
            { label: "Open orders", value: metrics.openCount },
            { label: "Partially received", value: metrics.partialCount },
            { label: "Fully received", value: metrics.receivedCount },
            { label: "Outstanding", value: money(metrics.outstanding, baseCurrency) }
          ]}
          emptyTitle={loading ? "Loading purchase orders..." : "No purchase orders found"}
          emptyText="Create a new order or change the filters."
          columns={[
            { label: "Order", width: 170, documentValue: (purchase) => purchase.purchase_number, render: (purchase) => <><strong>{purchase.purchase_number}</strong><small>{dateTime(purchase.created_at)}</small></> },
            { label: "Supplier", width: 170, value: (purchase) => purchase.suppliers?.name || "No supplier" },
            { label: "Expected", width: 105, documentValue: (purchase) => dateOnly(purchase.expected_date), render: (purchase) => dateOnly(purchase.expected_date) },
            { label: "Items", width: 75, value: (purchase) => purchase.purchase_items?.length || 0 },
            { label: "Receiving", width: 140, documentValue: (purchase) => purchaseReceivingStatusLabel(purchase), render: (purchase) => <span className={`status-pill ${purchaseReceivingStatus(purchase)}`}>{purchaseReceivingStatusLabel(purchase)}</span> },
            { label: "Payment", width: 100, documentValue: (purchase) => purchasePaymentStatus(purchase), render: (purchase) => <span className={`payment-pill ${purchasePaymentStatus(purchase)}`}>{purchasePaymentStatus(purchase)}</span> },
            { label: "Total", width: 110, documentValue: (purchase) => money(purchase.total_amount, purchase.currency), render: (purchase) => <strong>{money(purchase.total_amount, purchase.currency)}</strong> },
            { label: "Received value", width: 120, documentValue: (purchase) => money(purchaseReceivingTotals(purchase).receivedValue, purchase.currency), render: (purchase) => money(purchaseReceivingTotals(purchase).receivedValue, purchase.currency) },
            { label: "Balance", width: 110, documentValue: (purchase) => money(purchaseBalance(purchase), purchase.currency), render: (purchase) => <strong>{money(purchaseBalance(purchase), purchase.currency)}</strong> },
            { label: "Actions", actionsOnly: true, excludeDocument: true, render: (purchase) => {
              const receivingTotals = purchaseReceivingTotals(purchase);
              const hasReceived = receivingTotals.receivedBaseUnits > 0;
              const remainingBase = Math.max(0, receivingTotals.orderedBaseUnits - receivingTotals.receivedBaseUnits);
              const editable = ["draft", "ordered"].includes(purchase.status) && !hasReceived && Number(purchase.amount_paid || 0) === 0;
              const receivable = ["draft", "ordered"].includes(purchase.status) && remainingBase > 0;
              const payable = purchase.status !== "cancelled" && purchaseBalance(purchase) > 0;
              const cancelable = receivable && !hasReceived && Number(purchase.amount_paid || 0) === 0;
              return <div className="po-card-actions table-actions"><button type="button" className="secondary-button compact-button" onClick={() => setPrintPurchase(purchase)}><Eye size={17} />View</button>{editable && <button type="button" className="secondary-button compact-button" onClick={() => openEditOrder(purchase)}><Edit3 size={17} />Edit</button>}{payable && <button type="button" className="secondary-button compact-button" onClick={() => openAction(purchase, "payment")}><WalletCards size={17} />Pay</button>}{receivable && <button type="button" className="primary-button compact-button" onClick={() => setReceivingPurchase(purchase)}><PackageCheck size={17} />{hasReceived ? "Receive more" : "Receive"}</button>}{cancelable && <button type="button" className="danger-button compact-button" onClick={() => openAction(purchase, "cancel")}><Ban size={17} />Cancel</button>}</div>;
            } }
          ]}
          renderCard={(purchase) => {
            const paymentStatus = purchasePaymentStatus(purchase);
            const receivingStatus = purchaseReceivingStatus(purchase);
            const receivingTotals = purchaseReceivingTotals(purchase);
            const hasReceived = receivingTotals.receivedBaseUnits > 0;
            const remainingBase = Math.max(0, receivingTotals.orderedBaseUnits - receivingTotals.receivedBaseUnits);
            const receivingProgress = receivingTotals.orderedBaseUnits > 0 ? Math.min(100, receivingTotals.receivedBaseUnits / receivingTotals.orderedBaseUnits * 100) : 0;
            const editable = ["draft", "ordered"].includes(purchase.status) && !hasReceived && Number(purchase.amount_paid || 0) === 0;
            const receivable = ["draft", "ordered"].includes(purchase.status) && remainingBase > 0;
            const payable = purchase.status !== "cancelled" && purchaseBalance(purchase) > 0;
            const cancelable = receivable && !hasReceived && Number(purchase.amount_paid || 0) === 0;
            return (
              <article className="responsive-data-card po-card">
                <header><div><strong>{purchase.purchase_number}</strong><small>{dateTime(purchase.created_at)} · {purchase.suppliers?.name || "No supplier"}</small></div><div className="po-status-group"><span className={`status-pill ${receivingStatus}`}>{purchaseReceivingStatusLabel(purchase)}</span><span className={`payment-pill ${paymentStatus}`}>{paymentStatus}</span></div></header>
                <div><span>Expected</span><strong>{dateOnly(purchase.expected_date)}</strong></div>
                <div><span>Items</span><strong>{purchase.purchase_items?.length || 0}</strong></div>
                <div><span>Received value</span><strong>{money(receivingTotals.receivedValue, purchase.currency)}</strong></div>
                <div><span>Total</span><strong>{money(purchase.total_amount, purchase.currency)}</strong></div>
                <div><span>Balance</span><strong>{money(purchaseBalance(purchase), purchase.currency)}</strong></div>
                <div className="po-receiving-progress"><div><span>Received {receivingProgress.toLocaleString("en-US", { maximumFractionDigits: 0 })}%</span><strong>{receivingTotals.receivedBaseUnits.toLocaleString("en-US", { maximumFractionDigits: 3 })} / {receivingTotals.orderedBaseUnits.toLocaleString("en-US", { maximumFractionDigits: 3 })} base units</strong></div><div className="po-receiving-track"><div style={{ width: `${receivingProgress}%` }} /></div></div>
                <footer className="po-card-actions"><button type="button" className="secondary-button compact-button" onClick={() => setPrintPurchase(purchase)}><Eye size={17} />View / Print</button>{editable && <button type="button" className="secondary-button compact-button" onClick={() => openEditOrder(purchase)}><Edit3 size={17} />Edit</button>}{payable && <button type="button" className="secondary-button compact-button" onClick={() => openAction(purchase, "payment")}><WalletCards size={17} />Pay</button>}{receivable && <button type="button" className="primary-button compact-button" onClick={() => setReceivingPurchase(purchase)}><PackageCheck size={17} />{hasReceived ? "Receive more" : "Receive"}</button>}{cancelable && <button type="button" className="danger-button compact-button" onClick={() => openAction(purchase, "cancel")}><Ban size={17} />Cancel</button>}</footer>
              </article>
            );
          }}
        />
      ) : (
        <ResponsiveDataList
          storageKey="purchase-suppliers-list"
          title="Suppliers"
          subtitle="Supplier directory and purchasing balances"
          rows={filteredSuppliers}
          filename={`tiny-pos-suppliers-${new Date().toISOString().slice(0, 10)}.xls`}
          emptyTitle={loading ? "Loading suppliers..." : "No suppliers found"}
          emptyText="Add your first supplier or change the search."
          columns={[
            { label: "Code", width: 100, value: (supplier) => supplier.supplier_code },
            { label: "Supplier", width: 190, documentValue: (supplier) => supplier.name, render: (supplier) => <><strong>{supplier.name}</strong><small>{supplier.contact_name || "No contact person"}</small></> },
            { label: "Phone", width: 120, value: (supplier) => supplier.phone || "—" },
            { label: "Email", width: 180, value: (supplier) => supplier.email || "—" },
            { label: "Address", width: 220, value: (supplier) => supplier.address || "—" },
            { label: "Orders", width: 80, value: (supplier) => purchases.filter((purchase) => purchase.supplier_id === supplier.id).length },
            { label: "Received value", width: 120, documentValue: (supplier) => {
              const amount = purchases.filter((purchase) => purchase.supplier_id === supplier.id).reduce((sum, purchase) => sum + convertToBase(purchaseReceivingTotals(purchase).receivedValue, purchase.currency, baseCurrency, usdToKhrRate), 0);
              return money(amount, baseCurrency);
            } },
            { label: "Balance due", width: 120, documentValue: (supplier) => {
              const balance = purchases.filter((purchase) => purchase.supplier_id === supplier.id && purchase.status !== "cancelled").reduce((sum, purchase) => sum + convertToBase(purchaseBalance(purchase), purchase.currency, baseCurrency, usdToKhrRate), 0);
              return money(balance, baseCurrency);
            } },
            { label: "Status", width: 90, documentValue: (supplier) => supplier.is_active ? "Active" : "Inactive", render: (supplier) => <span className={`status-pill ${supplier.is_active ? "active" : "inactive"}`}>{supplier.is_active ? "active" : "inactive"}</span> },
            { label: "Actions", actionsOnly: true, excludeDocument: true, render: (supplier) => <button type="button" className="secondary-button compact-button" onClick={() => { setEditingSupplier(supplier); setSupplierFormOpen(true); }}><Edit3 size={17} />Edit</button> }
          ]}
          renderCard={(supplier) => {
            const supplierPurchases = purchases.filter((purchase) => purchase.supplier_id === supplier.id);
            const totalPurchased = supplierPurchases.reduce((sum, purchase) => sum + convertToBase(purchaseReceivingTotals(purchase).receivedValue, purchase.currency, baseCurrency, usdToKhrRate), 0);
            const balanceDue = supplierPurchases.filter((purchase) => purchase.status !== "cancelled").reduce((sum, purchase) => sum + convertToBase(purchaseBalance(purchase), purchase.currency, baseCurrency, usdToKhrRate), 0);
            return <article className={`responsive-data-card supplier-card ${supplier.is_active ? "" : "inactive"}`}><header><div><small>{supplier.supplier_code}</small><strong>{supplier.name}</strong></div><span className={`status-pill ${supplier.is_active ? "active" : "inactive"}`}>{supplier.is_active ? "active" : "inactive"}</span></header><div><span>Contact</span><strong>{supplier.contact_name || supplier.phone || "—"}</strong><small>{supplier.email || ""}</small></div><div><span>Orders</span><strong>{supplierPurchases.length}</strong></div><div><span>Received value</span><strong>{money(totalPurchased, baseCurrency)}</strong></div><div><span>Balance due</span><strong>{money(balanceDue, baseCurrency)}</strong></div><footer><button type="button" className="secondary-button compact-button" onClick={() => { setEditingSupplier(supplier); setSupplierFormOpen(true); }}><Edit3 size={17} />Edit supplier</button></footer></article>;
          }}
        />
      )}

      <PurchaseOrderFormModal
        open={orderFormOpen}
        purchase={editingPurchase}
        suppliers={suppliers}
        products={products}
        busy={busy}
        onClose={() => {
          setOrderFormOpen(false);
          setEditingPurchase(null);
        }}
        onSave={handleSaveOrder}
        onOpenSuppliers={() => {
          setEditingSupplier(null);
          setSupplierFormOpen(true);
        }}
      />

      <PurchaseReceiptModal
        purchase={receivingPurchase}
        busy={busy}
        onClose={() =>
          setReceivingPurchase(null)
        }
        onSubmit={handleReceivePurchase}
      />

      <PurchaseOrderActionModal
        action={actionType}
        purchase={actionPurchase}
        busy={busy}
        onClose={() => {
          setActionType(null);
          setActionPurchase(null);
        }}
        onConfirm={handleOrderAction}
      />

      <PurchaseOrderPrintModal
        purchase={printPurchase}
        shop={shop}
        branch={profile?.branches}
        onClose={() => setPrintPurchase(null)}
        onPrintReceipt={(receipt) => {
          setReceiptPrint({
            receipt,
            purchase: printPurchase
          });
          setPrintPurchase(null);
        }}
      />

      <PurchaseReceiptPrintModal
        receipt={receiptPrint?.receipt}
        purchase={receiptPrint?.purchase}
        shop={shop}
        branch={profile?.branches}
        onClose={() => setReceiptPrint(null)}
      />

      <SupplierFormModal
        open={supplierFormOpen}
        supplier={editingSupplier}
        busy={busy}
        onClose={() => {
          setSupplierFormOpen(false);
          setEditingSupplier(null);
        }}
        onSave={handleSaveSupplier}
      />
    </div>
  );
}
