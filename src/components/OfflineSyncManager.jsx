import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CloudOff, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  listOfflineSales,
  subscribeOfflineQueue,
  synchronizeOfflineQueue
} from "../lib/offlineCheckout";
import { useLanguage } from "../context/LanguageContext";

export default function OfflineSyncManager() {
  const { supabase, profile, can } = useAuth();
  const { t } = useLanguage();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [summary, setSummary] = useState({ pending: 0, conflicts: 0 });
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    if (!profile?.id) return;
    const sales = await listOfflineSales(profile);
    setSummary({
      pending: sales.filter((sale) => ["pending", "syncing"].includes(sale.status)).length,
      conflicts: sales.filter((sale) => sale.status === "conflict").length
    });
  }, [profile]);

  const sync = useCallback(async () => {
    if (!online || !supabase || !profile?.id || syncing) return;
    try {
      setSyncing(true);
      await synchronizeOfflineQueue(supabase, profile);
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [online, supabase, profile, syncing, refresh]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const unsubscribe = subscribeOfflineQueue(refresh);
    refresh();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (online && summary.pending > 0) sync();
  }, [online, summary.pending, sync]);

  if (!can("offline_checkout.use")) return null;
  if (online && summary.pending === 0 && summary.conflicts === 0) return null;

  return (
    <div className={`offline-sync-bar ${summary.conflicts ? "has-conflict" : ""}`}>
      {online ? (
        summary.conflicts ? <AlertTriangle size={18} /> : <RefreshCw size={18} className={syncing ? "spin" : ""} />
      ) : (
        <CloudOff size={18} />
      )}
      <span>
        {!online
          ? t("Offline checkout is active on this device.")
          : summary.conflicts
            ? t("Offline sales need review before they can post.")
            : t("Synchronizing offline sales…")}
      </span>
      <strong>{summary.pending + summary.conflicts}</strong>
      <Link to="/offline-checkout">{t("Open Offline Center")}</Link>
    </div>
  );
}
