import {
  CheckCircle2,
  ClipboardCheck,
  Eye,
  PackageSearch,
  RefreshCw,
  XCircle
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { useAuth } from "../context/AuthContext";
import BarcodeScanner from "../components/BarcodeScanner";
import StockCountCompleteModal from "../components/StockCountCompleteModal";
import StockCountHistoryModal from "../components/StockCountHistoryModal";
import StockCountStartModal from "../components/StockCountStartModal";
import StockCountWorkspaceModal from "../components/StockCountWorkspaceModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import DateRangePresetFields from "../components/DateRangePresetFields";
import {
  money,
  stockNumber
} from "../lib/catalog";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import { dateRangeForPreset, localDateKey } from "../lib/dateRangePresets";
import {
  cancelStockCount,
  completeStockCount,
  exactStockCountMatch,
  loadStockCountHistorySessions,
  loadStockCountItems,
  loadStockCountWorkspace,
  saveAllStockCountItems,
  scanStockCountItem,
  startStockCount
} from "../lib/stockCounts";

function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export default function StockCountsPage() {
  const { supabase, profile, can } = useAuth();
  const canManage = can("stock_counts.manage");

  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [countFilter, setCountFilter] = useState("all");

  const initialHistoryRange = useMemo(() => dateRangeForPreset("today"), []);
  const [historyFrom, setHistoryFrom] = useState(initialHistoryRange.from);
  const [historyTo, setHistoryTo] = useState(initialHistoryRange.to);

  const [startOpen, setStartOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);

  const [historySession, setHistorySession] = useState(null);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [draftItems, setDraftItems] = useState({});
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const refresh = useCallback(async () => {
    if (
      !supabase
      || !profile?.organization_id
      || !profile?.branch_id
      || !canManage
    ) {
      return;
    }

    try {
      setLoading(true);
      const [workspace, historyRows] = await Promise.all([
        loadStockCountWorkspace(supabase, profile),
        loadStockCountHistorySessions(supabase, profile, {
          from: historyFrom,
          to: historyTo
        })
      ]);
      setSessions(historyRows);
      setActiveSession(workspace.activeSession);
      setItems(workspace.activeItems);
      setProducts(workspace.products);
      setCategories(workspace.categories);
      setDraftItems({});
      if (!workspace.activeSession) setWorkspaceOpen(false);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, canManage, historyFrom, historyTo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const metrics = useMemo(() => {
    let discrepancies = 0;
    let shortages = 0;
    let overages = 0;
    let valueUsd = 0;
    let valueKhr = 0;
    let counted = 0;

    for (const item of items) {
      if (item.counted_quantity === null) continue;
      counted += 1;
      const variance = item.counted_quantity - item.expected_quantity;
      if (variance !== 0) {
        discrepancies += 1;
        if (variance < 0) shortages += 1;
        else overages += 1;
      }
      const value = variance * Number(item.unit_cost_snapshot || 0);
      if (item.products?.currency === "KHR") valueKhr += value;
      else valueUsd += value;
    }

    return {
      total: items.length,
      counted,
      uncounted: items.length - counted,
      discrepancies,
      shortages,
      overages,
      valueUsd,
      valueKhr,
      progress: items.length > 0 ? counted / items.length * 100 : 0
    };
  }, [items]);

  const historySessions = useMemo(() => {
    return sessions.filter((session) => {
      if (session.id === activeSession?.id) return false;
      if (!session.started_at) return false;

      const startedKey = localDateKey(new Date(session.started_at));
      if (historyFrom && startedKey < historyFrom) return false;
      if (historyTo && startedKey > historyTo) return false;
      return true;
    });
  }, [sessions, activeSession, historyFrom, historyTo]);

  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return items.filter((item) => {
      const product = item.products || {};
      const variance = item.counted_quantity === null
        ? null
        : item.counted_quantity - item.expected_quantity;

      if (categoryFilter && product.category_id !== categoryFilter) return false;
      if (countFilter === "uncounted" && item.counted_quantity !== null) return false;
      if (countFilter === "counted" && item.counted_quantity === null) return false;
      if (countFilter === "difference" && (variance === null || variance === 0)) return false;
      if (countFilter === "shortage" && (variance === null || variance >= 0)) return false;
      if (countFilter === "overage" && (variance === null || variance <= 0)) return false;
      if (!needle) return true;

      return [
        product.name,
        product.name_km,
        product.sku,
        product.barcode,
        product.categories?.name,
        ...(product.product_units || []).flatMap((unit) => [
          unit.name,
          unit.short_name,
          unit.barcode
        ])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, search, categoryFilter, countFilter]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function handleStart(values) {
    try {
      setBusy("start");
      const result = await startStockCount(supabase, values);
      setStartOpen(false);
      announce(
        "success",
        `${result.count_number} started with ${result.expected_items} products.`
      );
      await refresh();
      setWorkspaceOpen(true);
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  function handleDraftChange(item, countedQuantity, note, selectedBatchId = null) {
    setDraftItems((current) => {
      const originalQuantity = item.counted_quantity === null
        ? null
        : Number(item.counted_quantity);
      const normalizedQuantity = countedQuantity === null
        ? null
        : Number(countedQuantity);
      const originalNote = String(item.note || "").trim();
      const normalizedNote = String(note || "").trim();
      const originalBatchId = String(item.selected_batch_id || "");
      const normalizedBatchId = String(selectedBatchId || "");
      const next = { ...current };
      const unchanged =
        originalQuantity === normalizedQuantity
        && originalNote === normalizedNote
        && originalBatchId === normalizedBatchId;

      if (unchanged) delete next[item.product_id];
      else {
        next[item.product_id] = {
          product_id: item.product_id,
          counted_quantity: normalizedQuantity,
          note: normalizedNote,
          selected_batch_id: normalizedBatchId || null
        };
      }
      return next;
    });
  }

  async function handleSaveAll() {
    const pending = Object.values(draftItems);
    if (pending.length === 0) {
      announce("error", "Enter or change at least one counted quantity first.");
      return;
    }

    const invalid = pending.find((item) =>
      item.counted_quantity !== null
      && (!Number.isFinite(item.counted_quantity) || item.counted_quantity < 0)
    );
    if (invalid) {
      announce("error", "Every counted quantity must be zero or greater.");
      return;
    }

    const missingBatch = pending.find((draft) => {
      if (draft.counted_quantity === null) return false;
      const row = items.find((item) => item.product_id === draft.product_id);
      const product = row?.products || {};
      return Boolean(
        product.batch_tracking
        && (product.inventory_batches || []).length > 0
        && !draft.selected_batch_id
      );
    });
    if (missingBatch) {
      const row = items.find((item) => item.product_id === missingBatch.product_id);
      announce("error", `Choose a batch / lot for ${row?.products?.name || "the batch-tracked product"}.`);
      return;
    }

    try {
      setBusy("save-all");
      const result = await saveAllStockCountItems(supabase, {
        session_id: activeSession.id,
        items: pending
      });
      announce(
        "success",
        `${result.saved_items || pending.length} product counts saved together.`
      );
      await refresh();
      setWorkspaceOpen(true);
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleScan(code) {
    const match = exactStockCountMatch(items, code);
    if (!match) {
      announce("error", `No product or package in this count matches ${code}.`);
      throw new Error(`No product or package in this count matches ${code}.`);
    }

    try {
      setBusy("scan");
      const result = await scanStockCountItem(supabase, {
        session_id: activeSession.id,
        product_id: match.product.id,
        product_unit_id: match.unit?.id || null,
        unit_quantity: 1
      });
      announce(
        "success",
        [
          match.product.name,
          `+${stockNumber(result.base_increment)}`,
          match.product.unit_name,
          `from 1 ${result.unit?.name || match.product.unit_name}`
        ].join(" · ")
      );
      await refresh();
      setWorkspaceOpen(true);
      return true;
    } catch (error) {
      announce("error", error.message);
      throw error;
    } finally {
      setBusy("");
    }
  }

  async function handleComplete(note) {
    try {
      setBusy("complete");
      const result = await completeStockCount(supabase, activeSession.id, note);
      setCompleteOpen(false);
      setWorkspaceOpen(false);
      announce(
        "success",
        result.adjustment_number
          ? `${result.count_number} completed. Adjustment ${result.adjustment_number} applied.`
          : `${result.count_number} completed with no stock differences.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleCancel() {
    if (!activeSession) return;
    const reason = window.prompt(
      `Enter a cancellation reason for ${activeSession.count_number}:`
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      announce("error", "A cancellation reason is required.");
      return;
    }

    try {
      setBusy("cancel");
      await cancelStockCount(supabase, activeSession.id, reason);
      setWorkspaceOpen(false);
      announce(
        "success",
        `${activeSession.count_number} cancelled. Inventory was not changed.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function viewHistory(session) {
    try {
      setHistorySession(session);
      setHistoryItems([]);
      setHistoryLoading(true);
      const rows = await loadStockCountItems(supabase, session.id);
      setHistoryItems(rows);
    } catch (error) {
      announce("error", error.message);
      setHistorySession(null);
    } finally {
      setHistoryLoading(false);
    }
  }

  const stockCountDocumentColumns = [
    { label: "Product", width: 210, value: (item) => item.products?.name || "" },
    { label: "Khmer name", width: 160, value: (item) => item.products?.name_km || "" },
    { label: "Code", width: 110, value: (item) => item.products?.sku || item.products?.barcode || "" },
    { label: "Unit", width: 80, value: (item) => item.products?.unit_name || "pcs" },
    { label: "Batch / lot", width: 150, value: (item) => {
      if (!item.products?.batch_tracking) return "—";
      const selected = (item.products?.inventory_batches || []).find((batch) => batch.id === item.selected_batch_id);
      if (selected) return selected.batch_number;
      return (item.products?.inventory_batches || []).length === 0 ? "Auto recovery lot" : "Not selected";
    } },
    { label: "System stock", width: 100, value: (item) => activeSession?.blind_count ? "Hidden" : stockNumber(item.expected_quantity) },
    { label: "Counted", width: 100, value: (item) => item.counted_quantity === null ? "" : stockNumber(item.counted_quantity) },
    { label: "Variance", width: 100, value: (item) => {
      if (activeSession?.blind_count || item.counted_quantity === null) return "";
      return stockNumber(Number(item.counted_quantity) - Number(item.expected_quantity));
    } },
    { label: "Value variance", width: 120, value: (item) => {
      if (activeSession?.blind_count || item.counted_quantity === null) return "";
      const variance = Number(item.counted_quantity) - Number(item.expected_quantity);
      return money(variance * Number(item.unit_cost_snapshot || 0), item.products?.currency || "USD");
    } },
    { label: "Note", width: 220, value: (item) => item.note || "" }
  ];

  function stockCountDocumentSummary() {
    return [
      { label: "Stock count", value: activeSession?.count_number || "" },
      { label: "Name", value: activeSession?.name || "" },
      { label: "Started", value: dateTime(activeSession?.started_at) },
      { label: "Counted", value: `${metrics.counted}/${metrics.total}` },
      { label: "Discrepancies", value: activeSession?.blind_count ? "Hidden" : metrics.discrepancies }
    ];
  }

  function exportActiveCount() {
    if (!activeSession) return;
    exportListExcel({
      filename: `${activeSession.count_number}.xls`,
      title: `${activeSession.count_number} · ${activeSession.name}`,
      subtitle: `${profile?.branches?.name || "Current branch"} · Started ${dateTime(activeSession.started_at)}`,
      summary: stockCountDocumentSummary(),
      columns: stockCountDocumentColumns,
      rows: visibleItems
    });
  }

  function printActiveCount() {
    if (!activeSession) return;
    printListDocument({
      title: `${activeSession.count_number} · ${activeSession.name}`,
      subtitle: `${profile?.branches?.name || "Current branch"} · Started ${dateTime(activeSession.started_at)}`,
      summary: stockCountDocumentSummary(),
      columns: stockCountDocumentColumns,
      rows: visibleItems,
      orientation: "landscape"
    });
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <ClipboardCheck size={46} />
        <h2>Management access required</h2>
        <p>Only an owner, admin or manager can run stock counts.</p>
      </section>
    );
  }

  return (
    <div className="page-stack stock-count-page">
      <div className="page-heading stock-count-page-heading">
        <div>
          <p className="eyebrow">INVENTORY CONTROL</p>
          <h1>Stock Count</h1>
          <p className="muted">
            Start a count, open only the count you are working on, then save all entered quantities together.
          </p>
        </div>

        <div className="page-heading-actions">
          {!activeSession && (
            <button
              type="button"
              className="primary-button"
              onClick={() => setStartOpen(true)}
              disabled={loading}
            >
              <ClipboardCheck size={18} />
              Start stock count
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={18} className={loading ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {message && (
        <div className={`notice ${messageType}`} onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      {activeSession ? (
        <section className="panel stock-count-session-card active">
          <div className="stock-count-session-index">1</div>
          <div className="stock-count-session-main">
            <p className="eyebrow">ACTIVE COUNT</p>
            <h2>{activeSession.count_number} · {activeSession.name}</h2>
            <span>
              {dateTime(activeSession.started_at)} · {metrics.counted}/{metrics.total} counted · {Math.round(metrics.progress)}%
            </span>
            <div className="stock-count-card-progress">
              <div style={{ width: `${metrics.progress}%` }} />
            </div>
          </div>
          <div className="stock-count-session-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => setWorkspaceOpen(true)}
            >
              <ClipboardCheck size={18} />
              Open count
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={handleCancel}
              disabled={busy === "cancel"}
              title="Cancel this stock count"
            >
              <XCircle size={18} />
            </button>
          </div>
        </section>
      ) : (
        <section className="panel stock-count-empty-active compact">
          <ClipboardCheck size={42} />
          <h2>No active stock count</h2>
          <p>Start a full, category or selected-product count.</p>
          <button
            type="button"
            className="primary-button"
            onClick={() => setStartOpen(true)}
          >
            Start stock count
          </button>
        </section>
      )}

      <section className="panel stock-count-history-date-filter">
        <div className="stock-count-history-date-filter-copy">
          <p className="eyebrow">HISTORY RANGE</p>
          <strong>Stock count sessions</strong>
          <small>Defaults to today. Choose another preset or enter a custom date range.</small>
        </div>
        <div className="stock-count-history-date-filter-fields">
          <DateRangePresetFields
            from={historyFrom}
            to={historyTo}
            onChange={(range) => {
              setHistoryFrom(range.from);
              setHistoryTo(range.to);
            }}
          />
        </div>
      </section>

      <ResponsiveDataList
        storageKey="stock-count-history"
        title="Previous stock counts"
        subtitle={`${profile?.branches?.name || "Current branch"} · ${historyFrom === historyTo ? historyFrom : `${historyFrom} to ${historyTo}`} · Completed, cancelled and earlier count sessions`}
        rows={historySessions}
        filename={`stock-count-history-${new Date().toISOString().slice(0, 10)}.xls`}
        emptyTitle="No stock count history yet"
        emptyText="Completed or cancelled stock counts will appear here."
        columns={[
          { label: "Count", width: 190, documentValue: (row) => row.count_number, render: (row) => <><strong>{row.count_number}</strong><small>{row.name}</small></> },
          { label: "Started", width: 150, documentValue: (row) => dateTime(row.started_at), render: (row) => dateTime(row.started_at) },
          { label: "Scope", width: 120, value: (row) => row.scope || "full" },
          { label: "Products", width: 85, value: (row) => row.expected_items || 0 },
          { label: "Differences", width: 95, value: (row) => row.discrepancy_items || 0 },
          { label: "Variance USD", width: 115, documentValue: (row) => money(row.value_variance_usd, "USD"), render: (row) => money(row.value_variance_usd, "USD") },
          { label: "Variance KHR", width: 115, documentValue: (row) => money(row.value_variance_khr, "KHR"), render: (row) => money(row.value_variance_khr, "KHR") },
          { label: "Status", width: 95, documentValue: (row) => row.status, render: (row) => <span className={`status-pill ${row.status === "completed" ? "active" : row.status === "cancelled" ? "inactive" : "pending"}`}>{row.status}</span> },
          { label: "View", actionsOnly: true, excludeDocument: true, render: (row) => <button type="button" className="icon-button" onClick={() => viewHistory(row)} title="View stock count details"><Eye size={18} /></button> }
        ]}
        renderCard={(row) => (
          <article className="responsive-data-card stock-count-history-card">
            <header><div><strong>{row.count_number}</strong><small>{row.name} · {dateTime(row.started_at)}</small></div><span className={`status-pill ${row.status === "completed" ? "active" : row.status === "cancelled" ? "inactive" : "pending"}`}>{row.status}</span></header>
            <div><span>Scope</span><strong>{row.scope || "full"}</strong></div>
            <div><span>Products / differences</span><strong>{row.expected_items || 0} / {row.discrepancy_items || 0}</strong></div>
            <div><span>Variance</span><strong>{money(row.value_variance_usd, "USD")}</strong><small>{money(row.value_variance_khr, "KHR")}</small></div>
            <footer><button type="button" className="secondary-button compact-button" onClick={() => viewHistory(row)}><Eye size={18} />View details</button></footer>
          </article>
        )}
      />

      <StockCountStartModal
        open={startOpen}
        products={products}
        categories={categories}
        busy={busy === "start"}
        onClose={() => setStartOpen(false)}
        onSubmit={handleStart}
      />

      <StockCountWorkspaceModal
        session={workspaceOpen ? activeSession : null}
        metrics={metrics}
        categories={categories}
        visibleItems={visibleItems}
        search={search}
        categoryFilter={categoryFilter}
        countFilter={countFilter}
        loading={loading}
        busy={busy}
        draftCount={Object.keys(draftItems).length}
        onSearchChange={setSearch}
        onCategoryChange={setCategoryFilter}
        onCountFilterChange={setCountFilter}
        onDraftChange={handleDraftChange}
        onSaveAll={handleSaveAll}
        onScan={() => setScannerOpen(true)}
        onComplete={() => setCompleteOpen(true)}
        onCancel={handleCancel}
        onExport={exportActiveCount}
        onPrint={printActiveCount}
        onClose={() => setWorkspaceOpen(false)}
      />

      <StockCountCompleteModal
        session={completeOpen ? activeSession : null}
        metrics={metrics}
        busy={busy === "complete"}
        onClose={() => setCompleteOpen(false)}
        onSubmit={handleComplete}
      />

      <StockCountHistoryModal
        session={historySession}
        items={historyItems}
        loading={historyLoading}
        onClose={() => {
          setHistorySession(null);
          setHistoryItems([]);
        }}
      />

      <BarcodeScanner
        open={scannerOpen}
        title="Scan product or package for stock count"
        onClose={() => setScannerOpen(false)}
        onDetected={handleScan}
        continuous
      />
    </div>
  );
}
