import {
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  Globe2,
  PackageSearch,
  RefreshCw,
  Search,
  Settings2,
  ShoppingBag,
  SlidersHorizontal
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ResponsiveDataList from "../components/ResponsiveDataList";
import MediaImage from "../components/MediaImage";
import MediaPreviewModal from "../components/MediaPreviewModal";
import OnlineOrderDetailModal from "../components/OnlineOrderDetailModal";
import OnlineProductModal from "../components/OnlineProductModal";
import OnlineStoreSettingsModal from "../components/OnlineStoreSettingsModal";
import DateRangePresetFields from "../components/DateRangePresetFields";
import {
  confirmOnlineOrder,
  loadOnlineStoreAdmin,
  onlineDateTime,
  onlineMoney,
  onlineStatusLabel,
  saveOnlineProduct,
  saveOnlineStoreSettings,
  setOnlineOrderStatus
} from "../lib/onlineStore";
import { downloadMediaFile } from "../lib/media";

function todayOffset(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function imageFor(product) {
  return [...(product.product_images || [])]
    .sort(
      (a, b) =>
        Number(b.is_primary)
        - Number(a.is_primary)
        || Number(a.sort_order)
        - Number(b.sort_order)
    )[0]?.secure_url;
}

function publicUnitCount(product) {
  return (product.product_units || []).filter((unit) => unit.is_active).length;
}

function textIncludes(product, term) {
  if (!term) return true;
  return [
    product.name,
    product.name_km,
    product.sku,
    product.barcode,
    product.categories?.name,
    product.online_description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function paymentLabel(value) {
  return String(value || "—")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function OnlineStorePage() {
  const navigate = useNavigate();
  const {
    supabase,
    session,
    profile,
    can,
    canAny
  } = useAuth();

  const initialQuery = useMemo(
    () => new URLSearchParams(window.location.search),
    []
  );
  const [tab, setTab] = useState(
    initialQuery.get("tab") === "products" ? "products" : "orders"
  );
  const [workspace, setWorkspace] = useState({
    settings: null,
    products: [],
    orders: []
  });
  const [filters, setFilters] = useState({
    from: todayOffset(0),
    to: todayOffset(0),
    status: initialQuery.get("status") || "current",
    payment: "all",
    fulfilment: "all",
    search: ""
  });
  const [productFilters, setProductFilters] = useState({
    search: "",
    category: "all",
    publication: "all"
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [previewMedia, setPreviewMedia] = useState(null);

  const canManageStore = can("online_store.manage");
  const canManageOrders = can("online_orders.manage");
  const canFulfillOrders = can("online_orders.fulfill");
  const canReceiveOrders = canAny([
    "online_orders.manage",
    "online_orders.fulfill"
  ]);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id) return;

    try {
      setLoading(true);
      const data = await loadOnlineStoreAdmin(supabase, profile, filters);
      setWorkspace(data);
      setSelectedOrder((current) => {
        if (!current) return null;
        return data.orders.find((row) => row.id === current.id) || null;
      });
    } catch (error) {
      setMessageType("error");
      setMessage(error.message || "Unable to load the Online Store workspace.");
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, filters]);

  useEffect(() => {
    const timer = window.setTimeout(refresh, filters.search ? 320 : 0);
    return () => window.clearTimeout(timer);
  }, [refresh, filters.search]);

  const stats = useMemo(() => {
    const result = { pending: 0, active: 0, usd: 0, khr: 0 };
    for (const order of workspace.orders) {
      if (order.status === "pending") result.pending += 1;
      if (!["fulfilled", "cancelled", "rejected"].includes(order.status)) {
        result.active += 1;
      }
      if (!["cancelled", "rejected"].includes(order.status)) {
        if (order.currency === "KHR") result.khr += Number(order.total_amount || 0);
        else result.usd += Number(order.total_amount || 0);
      }
    }
    return result;
  }, [workspace.orders]);

  const categories = useMemo(() => {
    const map = new Map();
    for (const product of workspace.products) {
      if (product.categories?.id) {
        map.set(product.categories.id, product.categories.name);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [workspace.products]);

  const filteredProducts = useMemo(() => {
    const term = productFilters.search.trim().toLowerCase();
    return workspace.products.filter((product) => {
      if (
        productFilters.category !== "all"
        && product.categories?.id !== productFilters.category
      ) return false;
      if (
        productFilters.publication === "published"
        && !product.online_enabled
      ) return false;
      if (
        productFilters.publication === "unpublished"
        && product.online_enabled
      ) return false;
      return textIncludes(product, term);
    });
  }, [workspace.products, productFilters]);

  const publicUrl = workspace.settings?.slug
    ? `${window.location.origin}/shop/${workspace.settings.slug}`
    : "";

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function openSettings() {
    setSelectedProduct(null);
    setSelectedOrder(null);
    setSettingsOpen(true);
  }

  function openProduct(product) {
    setSettingsOpen(false);
    setSelectedOrder(null);
    setSelectedProduct(product);
  }

  function openOrder(order) {
    setSettingsOpen(false);
    setSelectedProduct(null);
    setSelectedOrder(order);
  }

  async function saveSettings(values) {
    try {
      setBusy("settings");
      await saveOnlineStoreSettings(supabase, values);
      setSettingsOpen(false);
      announce("success", "Online Store settings saved.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function saveProduct(productId, values) {
    try {
      setBusy(`product:${productId}`);
      await saveOnlineProduct(supabase, productId, values);
      setSelectedProduct(null);
      announce("success", "Public product settings saved.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function confirmOrder(orderId) {
    if (!window.confirm(
      "Receive this online order and create a reserved Sales Order?"
    )) return;

    try {
      setBusy(`order:${orderId}`);
      const result = await confirmOnlineOrder(supabase, orderId);
      announce(
        "success",
        `Online order received. Reserved Sales Order ${result.sales_order_number} is ready for preparation and receipt processing.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function changeStatus(orderId, status, note) {
    if (
      ["cancelled", "rejected"].includes(status)
      && !window.confirm(`Change this order to ${status}?`)
    ) return;

    try {
      setBusy(`order:${orderId}`);
      await setOnlineOrderStatus(supabase, orderId, status, note);
      announce("success", "Online order status updated.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function copyStoreLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      announce("success", "Online Store link copied.");
    } catch {
      window.prompt("Copy the Online Store link:", publicUrl);
    }
  }

  const orderColumns = useMemo(() => [
    {
      label: "Order",
      width: 190,
      documentValue: (order) => order.order_number,
      render: (order) => (
        <div className="online-order-number-cell">
          <strong>{order.order_number}</strong>
          {order.sales_orders?.order_number && (
            <small>SO: {order.sales_orders.order_number}</small>
          )}
        </div>
      )
    },
    {
      label: "Customer",
      width: 190,
      documentValue: (order) => `${order.customer_name} · ${order.customer_phone}`,
      render: (order) => (
        <div className="online-order-customer-cell">
          <strong>{order.customer_name}</strong>
          <small>{order.customer_phone}</small>
        </div>
      )
    },
    {
      label: "Status",
      width: 130,
      value: (order) => onlineStatusLabel(order.status),
      render: (order) => (
        <span className={`status-badge ${order.status}`}>
          {onlineStatusLabel(order.status)}
        </span>
      )
    },
    {
      label: "Payment",
      width: 170,
      documentValue: (order) => `${paymentLabel(order.payment_method)} · ${paymentLabel(order.payment_status)}`,
      render: (order) => (
        <div className="online-order-payment-cell">
          <strong>{paymentLabel(order.payment_method)}</strong>
          <small>{paymentLabel(order.payment_status)}</small>
        </div>
      )
    },
    {
      label: "Fulfilment",
      width: 120,
      value: (order) => order.fulfilment_type === "delivery" ? "Delivery" : "Pickup"
    },
    {
      label: "Created",
      width: 170,
      value: (order) => onlineDateTime(order.created_at)
    },
    {
      label: "Total",
      width: 120,
      className: "right",
      value: (order) => onlineMoney(order.total_amount, order.currency)
    },
    {
      label: "Bank slip",
      width: 120,
      documentValue: (order) => order.bank_slip_url ? "Attached" : "—",
      render: (order) => order.bank_slip_url ? (
        <div className="online-order-slip-actions">
          <button
            type="button"
            className="online-order-slip-preview-button"
            title="Preview bank slip"
            onClick={() => setPreviewMedia({
              src: order.bank_slip_url,
              title: `${order.order_number} · Bank slip`,
              downloadName: `${order.order_number}-bank-slip`
            })}
          >
            <MediaImage src={order.bank_slip_url} alt="Bank slip" width={140} height={100} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Download bank slip"
            onClick={async () => {
              try {
                await downloadMediaFile(order.bank_slip_url, `${order.order_number}-bank-slip`);
              } catch (error) {
                announce("error", error.message);
              }
            }}
          >
            <Download size={16} />
          </button>
        </div>
      ) : <span className="muted">—</span>
    },
    {
      label: "View",
      width: 74,
      actionsOnly: true,
      excludeDocument: true,
      render: (order) => (
        <button
          type="button"
          className="icon-button"
          onClick={() => openOrder(order)}
          aria-label={`View ${order.order_number}`}
        >
          <Eye size={18} />
        </button>
      )
    }
  ], []);

  const productColumns = useMemo(() => [
    {
      label: "Product",
      width: 260,
      documentValue: (product) => [product.name, product.sku || product.barcode].filter(Boolean).join(" · "),
      render: (product) => (
        <div className="online-admin-product-table-name">
          <div className="online-admin-product-thumb">
            <MediaImage src={imageFor(product)} alt={product.name} width={140} height={110} />
          </div>
          <div>
            <strong>{product.name}</strong>
            {product.name_km && <small>{product.name_km}</small>}
            <small>{product.sku || product.barcode || "No product code"}</small>
          </div>
        </div>
      )
    },
    {
      label: "Category",
      width: 140,
      value: (product) => product.categories?.name || "Uncategorized"
    },
    {
      label: "Publication",
      width: 130,
      value: (product) => product.online_enabled ? "Published" : "Not published",
      render: (product) => (
        <span className={`status-badge ${product.online_enabled ? "completed" : "cancelled"}`}>
          {product.online_enabled ? "Published" : "Not published"}
        </span>
      )
    },
    {
      label: "Featured",
      width: 100,
      value: (product) => product.online_featured ? "Yes" : "No"
    },
    {
      label: "Units",
      width: 90,
      value: (product) => publicUnitCount(product)
    },
    {
      label: "Currency",
      width: 90,
      value: "currency"
    },
    {
      label: "Configure",
      width: 110,
      actionsOnly: true,
      excludeDocument: true,
      render: (product) => canManageStore ? (
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => openProduct(product)}
        >
          <SlidersHorizontal size={16} /> Configure
        </button>
      ) : <span className="muted">View only</span>
    }
  ], [canManageStore]);

  return (
    <div className="page-stack online-store-page">
      <div className="page-heading online-store-heading">
        <div>
          <p className="eyebrow">CUSTOMER WEB ORDERS</p>
          <h1>Online Store</h1>
          <p>
            Publish selected products, receive customer orders, verify bank slips,
            and convert accepted orders into reserved Sales Orders.
          </p>
        </div>

        <div className="page-actions">
          {publicUrl && (
            <>
              <button type="button" className="secondary-button" onClick={copyStoreLink}>
                <Globe2 size={18} /> Copy store link
              </button>
              <a className="secondary-button" href={publicUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={18} /> Open store
              </a>
            </>
          )}
          {canManageStore && (
            <button type="button" className="primary-button" onClick={openSettings}>
              <Settings2 size={18} /> Store settings
            </button>
          )}
        </div>
      </div>

      {message && <div className={`notice ${messageType}`} role="status">{message}</div>}

      <section className="panel online-store-status-card">
        <div>
          <span className={`online-publish-dot ${workspace.settings?.is_published ? "published" : ""}`} />
          <div>
            <strong>{workspace.settings?.is_published ? "Store is published" : "Store is not published"}</strong>
            <small>{workspace.settings?.slug ? `/shop/${workspace.settings.slug}` : "Configure the storefront before publishing."}</small>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={refresh} disabled={loading} aria-label="Refresh">
          <RefreshCw size={19} className={loading ? "spin" : ""} />
        </button>
      </section>

      <div className="metric-grid four online-store-metrics">
        <article className="metric-card"><span>Pending review</span><strong>{stats.pending}</strong><small>New customer orders</small></article>
        <article className="metric-card"><span>Active orders</span><strong>{stats.active}</strong><small>Not yet closed</small></article>
        <article className="metric-card"><span>Order value USD</span><strong>{onlineMoney(stats.usd, "USD")}</strong><small>Current filters</small></article>
        <article className="metric-card"><span>Order value KHR</span><strong>{onlineMoney(stats.khr, "KHR")}</strong><small>Current filters</small></article>
      </div>

      <div className="segmented-tabs online-store-tabs">
        <button type="button" className={tab === "orders" ? "active" : ""} onClick={() => { setTab("orders"); setSettingsOpen(false); setSelectedProduct(null); setSelectedOrder(null); }}>
          <ShoppingBag size={18} /> Online orders
        </button>
        <button type="button" className={tab === "products" ? "active" : ""} onClick={() => { setTab("products"); setSettingsOpen(false); setSelectedProduct(null); setSelectedOrder(null); }}>
          <PackageSearch size={18} /> Public products
        </button>
      </div>

      {tab === "orders" ? (
        <>
          <section className="panel online-admin-filters">
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
            <label><span>Status</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
              <option value="current">Current orders</option>
              <option value="all">All statuses</option>
              <option value="pending">Pending review</option>
              <option value="confirmed">Received</option>
              <option value="preparing">Preparing</option>
              <option value="ready">Ready</option>
              <option value="partially_fulfilled">Partially fulfilled</option>
              <option value="fulfilled">Fulfilled</option>
              <option value="cancelled">Cancelled</option>
              <option value="rejected">Rejected</option>
            </select></label>
            <label><span>Payment</span><select value={filters.payment} onChange={(event) => setFilters((current) => ({ ...current, payment: event.target.value }))}>
              <option value="all">All payments</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="cash_on_delivery">Cash on delivery</option>
              <option value="pay_at_store">Pay at store</option>
            </select></label>
            <label><span>Fulfilment</span><select value={filters.fulfilment} onChange={(event) => setFilters((current) => ({ ...current, fulfilment: event.target.value }))}>
              <option value="all">Pickup and delivery</option>
              <option value="pickup">Pickup</option>
              <option value="delivery">Delivery</option>
            </select></label>
            <label className="online-filter-search"><span>Search</span><div className="search-box"><Search size={17} /><input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Order, customer or phone" /></div></label>
          </section>

          <ResponsiveDataList
            storageKey="online-store-orders"
            title="Online orders"
            subtitle={`${profile?.branches?.name || "Current branch"} · ${filters.from} to ${filters.to}`}
            rows={workspace.orders}
            columns={orderColumns}
            filename={`online-orders-${filters.from}-${filters.to}.xls`}
            printTitle="Online orders"
            emptyTitle="No online orders found"
            emptyText="Customer web orders matching the selected filters appear here."
            renderCard={(order) => (
              <article className="online-order-card responsive-data-card">
                <header>
                  <div><strong>{order.order_number}</strong><small>{onlineDateTime(order.created_at)}</small></div>
                  <span className={`status-badge ${order.status}`}>{onlineStatusLabel(order.status)}</span>
                </header>
                <div className="online-order-card-customer"><strong>{order.customer_name}</strong><span>{order.customer_phone}</span></div>
                <div className="online-order-card-grid">
                  <div><small>Payment</small><strong>{paymentLabel(order.payment_method)}</strong><span>{paymentLabel(order.payment_status)}</span></div>
                  <div><small>Fulfilment</small><strong>{order.fulfilment_type === "delivery" ? "Delivery" : "Pickup"}</strong></div>
                  <div><small>Total</small><strong>{onlineMoney(order.total_amount, order.currency)}</strong></div>
                  <div><small>Sales Order</small><strong>{order.sales_orders?.order_number || "Not received"}</strong></div>
                </div>
                {order.bank_slip_url && (
                  <button
                    type="button"
                    className="online-order-card-slip"
                    onClick={() => setPreviewMedia({
                      src: order.bank_slip_url,
                      title: `${order.order_number} · Bank slip`,
                      downloadName: `${order.order_number}-bank-slip`
                    })}
                  >
                    <MediaImage src={order.bank_slip_url} alt="Bank slip" width={160} height={110} />
                    <span>View bank slip</span>
                  </button>
                )}
                <button type="button" className="secondary-button" onClick={() => openOrder(order)}><Eye size={17} /> View order</button>
              </article>
            )}
          />
        </>
      ) : (
        <>
          <section className="panel online-admin-filters online-product-filters">
            <label className="online-filter-search"><span>Search product</span><div className="search-box"><Search size={17} /><input value={productFilters.search} onChange={(event) => setProductFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Name, code, barcode or category" /></div></label>
            <label><span>Category / group</span><select value={productFilters.category} onChange={(event) => setProductFilters((current) => ({ ...current, category: event.target.value }))}>
              <option value="all">All categories</option>
              {categories.map(([id, name]) => <option value={id} key={id}>{name}</option>)}
            </select></label>
            <label><span>Publication</span><select value={productFilters.publication} onChange={(event) => setProductFilters((current) => ({ ...current, publication: event.target.value }))}>
              <option value="all">Published and unpublished</option>
              <option value="published">Published only</option>
              <option value="unpublished">Not published</option>
            </select></label>
          </section>

          <ResponsiveDataList
            storageKey="online-store-products"
            title="Public products"
            subtitle={`${filteredProducts.length} products matching the selected filters`}
            rows={filteredProducts}
            columns={productColumns}
            filename="online-store-public-products.xls"
            printTitle="Online Store public products"
            emptyTitle="No products found"
            emptyText="Change the search, category or publication filter."
            renderCard={(product) => (
              <article className={`online-admin-product-card responsive-data-card ${product.online_enabled ? "published" : ""}`}>
                <div className="online-admin-product-card-image">
                  <MediaImage src={imageFor(product)} alt={product.name} width={420} height={280} className="online-admin-product-card-media" />
                  <span className={`status-badge ${product.online_enabled ? "completed" : "cancelled"}`}>{product.online_enabled ? "Published" : "Not published"}</span>
                </div>
                <div className="online-admin-product-card-body">
                  <strong>{product.name}</strong>
                  {product.name_km && <span>{product.name_km}</span>}
                  <small>{product.categories?.name || "Uncategorized"}</small>
                  <small>{publicUnitCount(product)} selling units · {product.currency}</small>
                </div>
                {canManageStore && <button type="button" className="secondary-button" onClick={() => openProduct(product)}><SlidersHorizontal size={16} /> Configure</button>}
              </article>
            )}
          />
        </>
      )}

      <OnlineStoreSettingsModal
        open={settingsOpen}
        settings={workspace.settings}
        profile={profile}
        session={session}
        busy={busy === "settings"}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
      />

      <OnlineProductModal
        open={Boolean(selectedProduct)}
        product={selectedProduct}
        busy={selectedProduct && busy === `product:${selectedProduct.id}`}
        onClose={() => setSelectedProduct(null)}
        onSave={saveProduct}
      />



      <MediaPreviewModal
        open={Boolean(previewMedia)}
        src={previewMedia?.src}
        title={previewMedia?.title || "Image preview"}
        downloadName={previewMedia?.downloadName || "tiny-pos-image"}
        onClose={() => setPreviewMedia(null)}
      />

      <OnlineOrderDetailModal
        order={selectedOrder}
        busy={selectedOrder && busy === `order:${selectedOrder.id}`}
        canReceive={canReceiveOrders}
        canManage={canManageOrders}
        canFulfill={canFulfillOrders}
        onClose={() => setSelectedOrder(null)}
        onConfirm={confirmOrder}
        onStatus={changeStatus}
        onOpenSalesOrder={(orderId) => {
          setSelectedOrder(null);
          navigate(`/sales-orders?order=${orderId}`);
        }}
      />
    </div>
  );
}
