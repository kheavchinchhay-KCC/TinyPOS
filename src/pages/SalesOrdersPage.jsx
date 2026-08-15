import {
  Ban,
  CheckCircle2,
  ClipboardList,
  Eye,
  FileText,
  PackageCheck,
  RefreshCw,
  Search,
  ShoppingCart,
  Truck,
  XCircle
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  Link,
  useNavigate,
  useSearchParams
} from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import SalesOrderDeliveryModal from "../components/SalesOrderDeliveryModal";
import SalesOrderDocumentModal from "../components/SalesOrderDocumentModal";
import DateRangePresetFields from "../components/DateRangePresetFields";
import ResponsiveDataList from "../components/ResponsiveDataList";
import { money } from "../lib/catalog";
import {
  cancelSalesOrder,
  cancelSalesOrderDelivery,
  confirmSalesOrder,
  loadSalesOrders,
  orderRemainingQuantity,
  prepareDeliveryForSale,
  prepareSalesOrderDelivery,
  salesOrderDate,
  salesOrderDateTime,
  salesOrderStatusLabel
} from "../lib/salesOrders";

function monthRange() {
  const date = new Date();
  const now = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { from: now, to: now };
}

export default function SalesOrdersPage() {
  const {
    supabase,
    profile,
    shop,
    can
  } = useAuth();

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedOrderId = searchParams.get("order");
  const canManage = can("sales_orders.manage");
  const canDeliver = can("sales_orders.deliver");

  const defaults = monthRange();
  const [orders, setOrders] = useState([]);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] =
    useState("success");
  const [deliveryOrder, setDeliveryOrder] =
    useState(null);
  const [documentOrder, setDocumentOrder] =
    useState(null);

  const refresh = useCallback(async () => {
    if (
      !supabase
      || !profile?.organization_id
      || !profile?.branch_id
      || (!canManage && !canDeliver)
    ) {
      return [];
    }

    try {
      setLoading(true);
      const rows = await loadSalesOrders(
        supabase,
        profile,
        { from, to }
      );
      setOrders(rows);

      setDocumentOrder((current) =>
        current
          ? rows.find((row) => row.id === current.id)
            || null
          : null
      );

      return rows;
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [
    supabase,
    profile,
    from,
    to,
    canManage,
    canDeliver
  ]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!requestedOrderId || loading) return;

    const requested = orders.find((order) => order.id === requestedOrderId);
    if (!requested) return;

    setDocumentOrder(requested);
    const next = new URLSearchParams(searchParams);
    next.delete("order");
    setSearchParams(next, { replace: true });
  }, [requestedOrderId, loading, orders, searchParams, setSearchParams]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return orders.filter((order) => {
      if (status && order.status !== status) {
        return false;
      }

      if (!needle) return true;

      return [
        order.order_number,
        order.sales_quotes?.quote_number,
        order.customers?.name,
        order.customers?.customer_code,
        order.customers?.phone,
        ...(order.sales_order_items || [])
          .flatMap((item) => [
            item.product_name,
            item.sku,
            item.barcode
          ]),
        ...(order.sales_order_deliveries || [])
          .flatMap((delivery) => [
            delivery.delivery_number,
            delivery.invoice_number
          ])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [orders, search, status]);

  const metrics = useMemo(() => {
    const result = {
      draft: 0,
      confirmed: 0,
      partially_delivered: 0,
      delivered: 0,
      due: 0,
      openUsd: 0,
      openKhr: 0
    };

    const today = new Date().toISOString().slice(0, 10);

    for (const order of orders) {
      if (
        Object.prototype.hasOwnProperty.call(
          result,
          order.status
        )
      ) {
        result[order.status] += 1;
      }

      if (
        ["confirmed", "partially_delivered"]
          .includes(order.status)
      ) {
        if (
          order.requested_delivery_date
          && order.requested_delivery_date <= today
        ) {
          result.due += 1;
        }

        const remainingNet =
          order.sales_order_items.reduce(
            (sum, item) => {
              const ordered = Number(
                item.quantity || 0
              );
              const remaining =
                orderRemainingQuantity(item);

              if (ordered <= 0) return sum;

              return sum
                + Number(item.line_total || 0)
                  * remaining
                  / ordered;
            },
            0
          );

        const originalNet = Math.max(
          Number(order.subtotal || 0)
            - Number(order.discount_amount || 0),
          0
        );

        const remainingTax =
          originalNet > 0
            ? Number(order.tax_amount || 0)
              * remainingNet
              / originalNet
            : 0;

        const remainingValue =
          remainingNet + remainingTax;

        if (order.currency === "KHR") {
          result.openKhr += remainingValue;
        } else {
          result.openUsd += remainingValue;
        }
      }
    }

    return result;
  }, [orders]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function handleConfirm(order) {
    try {
      setBusy(`confirm-${order.id}`);
      const result = await confirmSalesOrder(
        supabase,
        order.id
      );
      announce(
        "success",
        `${result.order_number} confirmed and stock reserved.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleCancelOrder(order) {
    const reason = window.prompt(
      `Why are you cancelling ${order.order_number}?`
    );

    if (reason === null) return;
    if (reason.trim().length < 3) {
      announce(
        "error",
        "A cancellation reason is required."
      );
      return;
    }

    try {
      setBusy(`cancel-${order.id}`);
      await cancelSalesOrder(
        supabase,
        order.id,
        reason
      );
      announce(
        "success",
        `${order.order_number} cancelled. Remaining reservations were released.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleCancelDelivery(
    order,
    delivery
  ) {
    const reason = window.prompt(
      `Why are you cancelling ${delivery.delivery_number}?`
    );

    if (reason === null) return;
    if (reason.trim().length < 3) {
      announce(
        "error",
        "A cancellation reason is required."
      );
      return;
    }

    try {
      setBusy(`delivery-cancel-${delivery.id}`);
      await cancelSalesOrderDelivery(
        supabase,
        delivery.id,
        reason
      );
      announce(
        "success",
        `${delivery.delivery_number} cancelled. The order reservation remains available.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  function resumeDelivery(order, delivery) {
    try {
      prepareDeliveryForSale(
        profile,
        order,
        delivery
      );
      navigate("/sales");
    } catch (error) {
      announce("error", error.message);
    }
  }

  async function handlePrepareDelivery(values) {
    try {
      setBusy("prepare-delivery");
      const result = await prepareSalesOrderDelivery(
        supabase,
        values
      );
      const rows = await refresh();
      const order = rows.find(
        (row) => row.id === values.order_id
      );
      const delivery = order?.sales_order_deliveries
        ?.find((row) => row.id === result.delivery_id);

      if (!order || !delivery) {
        throw new Error(
          "Prepared delivery could not be reopened. Refresh Sales Orders."
        );
      }

      setDeliveryOrder(null);
      prepareDeliveryForSale(
        profile,
        order,
        delivery
      );
      navigate("/sales");
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  function renderOrderActions(order) {
    const draftDelivery = order.sales_order_deliveries.find((row) => row.status === "draft");
    return (
      <div className="sales-order-row-actions">
        <button type="button" className="icon-button" onClick={() => setDocumentOrder(order)} title="View and print documents"><Eye size={18} /></button>
        {canManage && order.status === "draft" && (
          <button type="button" className="icon-button" onClick={() => handleConfirm(order)} disabled={busy === `confirm-${order.id}`} title="Confirm and reserve stock"><PackageCheck size={18} /></button>
        )}
        {canDeliver && ["confirmed", "partially_delivered"].includes(order.status) && !draftDelivery && (
          <button type="button" className="icon-button" onClick={() => setDeliveryOrder(order)} title="Prepare partial delivery"><Truck size={18} /></button>
        )}
        {canDeliver && draftDelivery && (
          <>
            <button type="button" className="icon-button" onClick={() => resumeDelivery(order, draftDelivery)} title="Resume delivery checkout"><ShoppingCart size={18} /></button>
            <button type="button" className="icon-button danger-icon" onClick={() => handleCancelDelivery(order, draftDelivery)} disabled={busy === `delivery-cancel-${draftDelivery.id}`} title="Cancel draft delivery"><Ban size={18} /></button>
          </>
        )}
        {canManage && !["delivered", "cancelled"].includes(order.status) && (
          <button type="button" className="icon-button danger-icon" onClick={() => handleCancelOrder(order)} disabled={busy === `cancel-${order.id}`} title="Cancel remaining order"><XCircle size={18} /></button>
        )}
      </div>
    );
  }

  if (!canManage && !canDeliver) {
    return (
      <section className="panel empty-state">
        <ClipboardList size={46} />
        <h2>Sales-order access required</h2>
        <p>
          Your account cannot manage or deliver
          customer sales orders.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack sales-orders-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            RESERVED CUSTOMER ORDERS
          </p>
          <h1>Sales Orders</h1>
          <p className="muted">
            Reserve stock, deliver partially, print
            delivery notes, and invoice each delivery.
          </p>
        </div>

        <div className="page-heading-actions">
          {canManage && (
            <Link
              to="/quotes"
              className="primary-button"
            >
              <FileText size={18} />
              Create from quotation
            </Link>
          )}

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
      </div>

      {message && (
        <div
          className={`notice ${messageType}`}
          onClick={() => setMessage("")}
        >
          {message}
        </div>
      )}

      <div className="sales-order-metrics">
        <article>
          <ClipboardList size={20} />
          <span>Draft</span>
          <strong>{metrics.draft}</strong>
        </article>
        <article>
          <PackageCheck size={20} />
          <span>Confirmed</span>
          <strong>{metrics.confirmed}</strong>
        </article>
        <article>
          <Truck size={20} />
          <span>Partially delivered</span>
          <strong>
            {metrics.partially_delivered}
          </strong>
        </article>
        <article>
          <CheckCircle2 size={20} />
          <span>Delivered</span>
          <strong>{metrics.delivered}</strong>
        </article>
        <article className={metrics.due ? "attention" : ""}>
          <Truck size={20} />
          <span>Due or overdue</span>
          <strong>{metrics.due}</strong>
        </article>
        <article>
          <span>Open order value</span>
          <strong>
            {money(metrics.openUsd, "USD")}
          </strong>
          <small>
            {money(metrics.openKhr, "KHR")}
          </small>
        </article>
      </div>

      <section className="panel sales-order-filter-panel">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            placeholder="Search order, quotation, customer, product, delivery or invoice"
          />
        </div>

        <DateRangePresetFields
          from={from}
          to={to}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
        />

        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value)
            }
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="confirmed">Confirmed</option>
            <option value="partially_delivered">
              Partially delivered
            </option>
            <option value="delivered">
              Delivered
            </option>
            <option value="cancelled">
              Cancelled
            </option>
          </select>
        </label>
      </section>

      <ResponsiveDataList
        storageKey="sales-orders-list"
        title="Sales order list"
        subtitle={`${from} to ${to} · ${visible.length} matching order(s)`}
        rows={visible}
        filename={`tiny-pos-sales-orders-${from}-${to}.xls`}
        summary={[
          { label: "Date range", value: `${from} to ${to}` },
          { label: "Status", value: status || "All statuses" },
          { label: "Open USD", value: money(metrics.openUsd, "USD") },
          { label: "Open KHR", value: money(metrics.openKhr, "KHR") }
        ]}
        emptyTitle={loading ? "Loading sales orders..." : "No sales orders found"}
        emptyText="Open a customer quotation and create a sales order, or change the filters."
        className="sales-order-responsive-list"
        tableClassName="sales-order-table"
        orientation="landscape"
        columns={[
          {
            label: "Order",
            render: (order) => (
              <div>
                <strong>{order.order_number}</strong>
                <small>{order.sales_quotes?.quote_number ? `From ${order.sales_quotes.quote_number}` : salesOrderDateTime(order.created_at)}</small>
              </div>
            ),
            documentValue: (order) => order.order_number
          },
          {
            label: "Customer",
            render: (order) => (
              <div>
                <strong>{order.customers?.name || "Walk-in / no customer"}</strong>
                <small>{order.customers?.phone || order.customers?.customer_code || "No contact"}</small>
              </div>
            ),
            documentValue: (order) => order.customers?.name || "Walk-in / no customer"
          },
          { label: "Requested delivery", render: (order) => salesOrderDate(order.requested_delivery_date) },
          {
            label: "Status",
            render: (order) => <span className={`sales-order-status ${order.status}`}>{salesOrderStatusLabel(order.status)}</span>,
            documentValue: (order) => salesOrderStatusLabel(order.status)
          },
          {
            label: "Fulfilment",
            render: (order) => {
              const totalQuantity = order.sales_order_items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
              const deliveredQuantity = order.sales_order_items.reduce((sum, item) => sum + Number(item.delivered_quantity || 0), 0);
              const percent = totalQuantity > 0 ? deliveredQuantity / totalQuantity * 100 : 0;
              return (
                <div className="sales-order-progress">
                  <div><span style={{ width: `${Math.min(100, percent)}%` }} /></div>
                  <small>{percent.toLocaleString("en-US", { maximumFractionDigits: 0 })}% delivered</small>
                </div>
              );
            },
            documentValue: (order) => {
              const totalQuantity = order.sales_order_items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
              const deliveredQuantity = order.sales_order_items.reduce((sum, item) => sum + Number(item.delivered_quantity || 0), 0);
              return `${totalQuantity > 0 ? (deliveredQuantity / totalQuantity * 100).toLocaleString("en-US", { maximumFractionDigits: 0 }) : 0}% delivered`;
            }
          },
          {
            label: "Deliveries",
            render: (order) => {
              const completedCount = order.sales_order_deliveries.filter((row) => row.status === "completed").length;
              const draftDelivery = order.sales_order_deliveries.find((row) => row.status === "draft");
              return <div><strong>{completedCount}</strong>{draftDelivery && <small>{draftDelivery.delivery_number} draft</small>}</div>;
            },
            documentValue: (order) => String(order.sales_order_deliveries.filter((row) => row.status === "completed").length)
          },
          {
            label: "Total",
            render: (order) => <strong>{money(order.total_amount, order.currency)}</strong>,
            documentValue: (order) => money(order.total_amount, order.currency)
          },
          {
            label: "Actions",
            actionsOnly: true,
            excludeDocument: true,
            render: (order) => renderOrderActions(order)
          }
        ]}
        renderCard={(order) => {
          const totalQuantity = order.sales_order_items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
          const deliveredQuantity = order.sales_order_items.reduce((sum, item) => sum + Number(item.delivered_quantity || 0), 0);
          const percent = totalQuantity > 0 ? deliveredQuantity / totalQuantity * 100 : 0;
          const draftDelivery = order.sales_order_deliveries.find((row) => row.status === "draft");
          const completedCount = order.sales_order_deliveries.filter((row) => row.status === "completed").length;
          return (
            <article className="responsive-data-card sales-order-card">
              <header>
                <div>
                  <strong>{order.order_number}</strong>
                  <span className="sales-order-card-meta">{order.sales_quotes?.quote_number ? `From ${order.sales_quotes.quote_number}` : salesOrderDateTime(order.created_at)}</span>
                </div>
                <span className={`sales-order-status ${order.status}`}>{salesOrderStatusLabel(order.status)}</span>
              </header>
              <div className="sales-order-card-customer">
                <strong>{order.customers?.name || "Walk-in / no customer"}</strong>
                <span>{order.customers?.phone || order.customers?.customer_code || "No contact"}</span>
                <span className="sales-order-card-meta">Requested delivery: {salesOrderDate(order.requested_delivery_date)}</span>
              </div>
              <div className="sales-order-progress">
                <div><span style={{ width: `${Math.min(100, percent)}%` }} /></div>
                <small>{percent.toLocaleString("en-US", { maximumFractionDigits: 0 })}% delivered</small>
              </div>
              <div className="sales-order-card-summary">
                <div><span>Deliveries</span><strong>{completedCount}{draftDelivery ? ` · ${draftDelivery.delivery_number} draft` : ""}</strong></div>
                <div><span>Total</span><strong>{money(order.total_amount, order.currency)}</strong></div>
              </div>
              <footer className="sales-order-card-actions">{renderOrderActions(order)}</footer>
            </article>
          );
        }}
      />

      <SalesOrderDeliveryModal
        order={deliveryOrder}
        busy={busy === "prepare-delivery"}
        onClose={() => setDeliveryOrder(null)}
        onSubmit={handlePrepareDelivery}
      />

      <SalesOrderDocumentModal
        order={documentOrder}
        shop={shop}
        branch={profile?.branches}
        onClose={() => setDocumentOrder(null)}
      />
    </div>
  );
}
