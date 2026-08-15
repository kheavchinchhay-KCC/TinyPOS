import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  CloudOff,
  CloudUpload,
  RefreshCw,
  ReceiptText,
  Wifi,
  WifiOff
} from "lucide-react";
import ResponsiveDataList from "../components/ResponsiveDataList";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { money } from "../lib/catalog";
import {
  getOfflineDevice,
  listOfflineSales,
  loadOfflineCheckoutBundle,
  offlineBundleExpired,
  prepareOfflineCheckout,
  setOfflineDeviceName,
  subscribeOfflineQueue,
  synchronizeOfflineQueue,
  synchronizeOfflineSale
} from "../lib/offlineCheckout";

function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function statusClass(status) {
  if (status === "synced") return "success";
  if (status === "conflict") return "danger";
  if (status === "cancelled") return "neutral";
  return "warning";
}

export default function OfflineCheckoutPage() {
  const { supabase, profile } = useAuth();
  const { t } = useLanguage();
  const device = useMemo(() => getOfflineDevice(), []);
  const [deviceName, setDeviceName] = useState(device.name);
  const [validHours, setValidHours] = useState("24");
  const [bundle, setBundle] = useState(null);
  const [sales, setSales] = useState([]);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const refresh = useCallback(async () => {
    if (!profile?.id) return;
    const [nextBundle, nextSales] = await Promise.all([
      loadOfflineCheckoutBundle(profile),
      listOfflineSales(profile)
    ]);
    setBundle(nextBundle || null);
    setSales(nextSales || []);
  }, [profile]);

  useEffect(() => {
    const unsubscribe = subscribeOfflineQueue(refresh);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    refresh();
    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refresh]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function handlePrepare() {
    if (!online) {
      announce("error", t("Reconnect before preparing a new offline bundle."));
      return;
    }

    try {
      setBusy(true);
      setOfflineDeviceName(deviceName);
      await prepareOfflineCheckout(supabase, profile, {
        device_name: deviceName,
        valid_hours: Number(validHours)
      });
      await refresh();
      announce("success", t("This device is ready for offline checkout."));
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSync(sale) {
    if (!online) {
      announce("error", t("Reconnect before synchronizing."));
      return;
    }

    try {
      setBusy(true);
      const result = await synchronizeOfflineSale(supabase, sale);
      await refresh();
      announce(
        result?.ok ? "success" : "error",
        result?.ok
          ? `${sale.local_receipt_number} → ${result.invoice_number}`
          : result?.error_message || t("The offline sale requires review.")
      );
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncAll() {
    if (!online) {
      announce("error", t("Reconnect before synchronizing."));
      return;
    }

    try {
      setBusy(true);
      const result = await synchronizeOfflineQueue(supabase, profile);
      await refresh();
      announce(
        result.conflicts ? "error" : "success",
        `${result.synced} synchronized · ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"}`
      );
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  const pending = sales.filter((sale) => ["pending", "syncing"].includes(sale.status)).length;
  const conflicts = sales.filter((sale) => sale.status === "conflict").length;
  const synced = sales.filter((sale) => sale.status === "synced").length;
  const ready = Boolean(bundle && !offlineBundleExpired(bundle));

  const columns = [
    {
      label: t("Local receipt"),
      width: "190px",
      value: (sale) => sale.local_receipt_number,
      render: (sale) => <strong>{sale.local_receipt_number}</strong>
    },
    {
      label: t("Created"),
      width: "180px",
      value: (sale) => dateTime(sale.offline_created_at)
    },
    {
      label: t("Payment"),
      width: "120px",
      value: (sale) => t(sale.payload?.payment_method || "—")
    },
    {
      label: t("Total"),
      width: "120px",
      value: (sale) => money(sale.payload?.total_amount || 0, sale.payload?.currency || "USD")
    },
    {
      label: t("Status"),
      width: "150px",
      value: (sale) => sale.status,
      render: (sale) => (
        <div className="offline-status-cell">
          <span className={`status-pill ${statusClass(sale.status)}`}>{t(sale.status)}</span>
          {sale.error_message && (
            <small className="offline-error"><AlertTriangle size={14} />{sale.error_message}</small>
          )}
        </div>
      )
    },
    {
      label: t("Server invoice"),
      width: "190px",
      value: (sale) => sale.invoice_number || "—"
    },
    {
      label: t("Action"),
      width: "90px",
      actionsOnly: true,
      excludeDocument: true,
      render: (sale) => sale.status !== "synced" ? (
        <button
          type="button"
          className="secondary-button compact-button"
          disabled={busy || !online}
          onClick={() => handleSync(sale)}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
          {t("Sync")}
        </button>
      ) : <CheckCircle2 size={20} className="offline-synced-icon" />
    }
  ];

  return (
    <div className="page-stack offline-center-page">
      <div className="page-heading offline-page-heading">
        <div>
          <span className="eyebrow">{t("SAFE OFFLINE SALES")}</span>
          <h1>{t("Offline Checkout Center")}</h1>
          <p>{t("Prepare this device while online, complete restricted sales without a connection, then synchronize safely.")}</p>
        </div>
        <div className={`offline-live-connection ${online ? "online" : "offline"}`}>
          {online ? <Wifi size={20} /> : <WifiOff size={20} />}
          <span>{t("Connection")}</span>
          <strong>{online ? t("Online") : t("Offline")}</strong>
        </div>
      </div>

      {message && (
        <div className={`notice ${messageType}`} onClick={() => setMessage("")}>{message}</div>
      )}

      <div className="offline-metric-grid">
        <div className="metric-card"><span>{t("Pending sync")}</span><strong>{pending}</strong></div>
        <div className="metric-card"><span>{t("Conflicts")}</span><strong>{conflicts}</strong></div>
        <div className="metric-card"><span>{t("Synced on device")}</span><strong>{synced}</strong></div>
        <div className="metric-card"><span>{t("Device status")}</span><strong>{ready ? t("Ready") : t("Not ready")}</strong></div>
      </div>

      <section className="panel offline-prepare-card">
        <div className="section-heading">
          <div>
            <h2>{t("Prepare this device")}</h2>
            <p>{t("Downloads a trusted product, customer, stock and receipt snapshot for the current branch.")}</p>
          </div>
          {ready ? (
            <span className="status-pill success"><CheckCircle2 size={15} />{t("Ready")}</span>
          ) : (
            <span className="status-pill warning"><CloudOff size={15} />{t("Not ready")}</span>
          )}
        </div>

        <div className="form-grid three offline-device-form">
          <label><span>{t("Device name")}</span><input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <label><span>{t("Valid for")}</span><select value={validHours} onChange={(event) => setValidHours(event.target.value)}><option value="8">8 hours</option><option value="24">24 hours</option><option value="48">48 hours</option><option value="72">72 hours</option></select></label>
          <label><span>{t("Device ID")}</span><input value={device.id} readOnly /></label>
        </div>

        <div className="button-row offline-prepare-actions">
          <button type="button" className="primary-button" disabled={busy || !online} onClick={handlePrepare}>
            <CloudDownload size={18} />{busy ? t("Preparing…") : t("Prepare Offline Checkout")}
          </button>
          {(pending > 0 || conflicts > 0) && (
            <button type="button" className="secondary-button" disabled={busy || !online} onClick={handleSyncAll}>
              <CloudUpload size={18} />{t("Synchronize all")}
            </button>
          )}
        </div>

        {bundle && (
          <div className="offline-bundle-details">
            <div><span>{t("Prepared")}</span><strong>{dateTime(bundle.session?.prepared_at)}</strong></div>
            <div><span>{t("Expires")}</span><strong>{dateTime(bundle.session?.expires_at)}</strong></div>
            <div><span>{t("Products")}</span><strong>{bundle.catalog?.products?.length || 0}</strong></div>
            <div><span>{t("Customers")}</span><strong>{bundle.catalog?.customers?.length || 0}</strong></div>
            <div><span>{t("Cash register")}</span><strong>{bundle.settings?.cash_register_open ? t("Open at preparation") : t("Not open")}</strong></div>
          </div>
        )}
      </section>

      <ResponsiveDataList
        storageKey="offline-checkout-device-queue"
        title={t("Device sale queue")}
        subtitle={t("A pending receipt is not a final server invoice until synchronization succeeds.")}
        rows={sales}
        columns={columns}
        filename="offline-checkout-device-queue.xls"
        printTitle={t("Offline Checkout Device Queue")}
        emptyTitle={t("No offline sales on this device")}
        emptyText={t("Prepare the device, then complete a sale while disconnected.")}
        rowKey={(sale) => sale.offline_sale_id}
        renderCard={(sale) => (
          <article className="offline-sale-card">
            <header>
              <div><ReceiptText size={20} /><span><strong>{sale.local_receipt_number}</strong><small>{dateTime(sale.offline_created_at)}</small></span></div>
              <span className={`status-pill ${statusClass(sale.status)}`}>{t(sale.status)}</span>
            </header>
            <div className="offline-sale-card-grid">
              <div><span>{t("Payment")}</span><strong>{t(sale.payload?.payment_method || "—")}</strong></div>
              <div><span>{t("Total")}</span><strong>{money(sale.payload?.total_amount || 0, sale.payload?.currency || "USD")}</strong></div>
              <div><span>{t("Server invoice")}</span><strong>{sale.invoice_number || "—"}</strong></div>
            </div>
            {sale.error_message && <div className="notice error compact-offline-error"><AlertTriangle size={16} />{sale.error_message}</div>}
            {sale.status !== "synced" && (
              <button type="button" className="secondary-button" disabled={busy || !online} onClick={() => handleSync(sale)}>
                <RefreshCw size={17} className={busy ? "spin" : ""} />{t("Synchronize now")}
              </button>
            )}
          </article>
        )}
      />

      <div className="notice warning offline-restriction-note">
        <AlertTriangle size={20} />
        <span>{t("Offline checkout supports cached products, cached customers and cash/bank/KHQR/card/other payments. Coupons, manual discounts, credit sales, new customers, quotations and Sales Order deliveries remain online-only. Stock and register rules are checked again during synchronization.")}</span>
      </div>
    </div>
  );
}
