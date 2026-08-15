import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Download,
  RefreshCw,
  Search,
  Settings2,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Warehouse
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import DemandPlanningSettingsModal from "../components/DemandPlanningSettingsModal";
import {
  createForecastDraftPurchaseOrders,
  exportForecastCsv,
  FORECAST_RISKS,
  forecastRiskClass,
  forecastRiskLabel,
  loadDemandWorkspace,
  runDemandForecast,
  saveDemandSettings
} from "../lib/forecasting";

function number(value, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits
  }).format(Number(value || 0));
}

function money(value, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(Number(value || 0));
}

function dateLabel(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(`${value}T00:00:00`));
}

export default function DemandPlanningPage() {
  const { supabase, profile, can } = useAuth();
  const canManage = can("demand_planning.manage");
  const canCreateOrders = can("demand_planning.create_purchase_orders");
  const canAllBranches = can("branches.all");

  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(profile?.branch_id || "");
  const [workspace, setWorkspace] = useState({
    settings: {},
    run: {},
    items: [],
    history: []
  });
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setBranchId((current) => current || profile?.branch_id || "");
  }, [profile?.branch_id]);

  useEffect(() => {
    if (!supabase || !profile?.organization_id || !canAllBranches) {
      setBranches(profile?.branches ? [profile.branches] : []);
      return;
    }

    let active = true;
    supabase
      .from("branches")
      .select("id,name,code,is_active")
      .eq("organization_id", profile.organization_id)
      .eq("is_active", true)
      .order("name")
      .then(({ data, error }) => {
        if (!active || error) return;
        setBranches(data || []);
      });

    return () => {
      active = false;
    };
  }, [supabase, profile, canAllBranches]);

  const refresh = useCallback(async () => {
    if (!supabase || !branchId) return;
    try {
      setLoading(true);
      const data = await loadDemandWorkspace(supabase, branchId);
      setWorkspace(data);
      setSelected((current) => {
        const eligible = new Set(
          data.items.filter((item) => item.can_create_order).map((item) => item.product_id)
        );
        return new Set([...current].filter((id) => eligible.has(id)));
      });
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, branchId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const categories = useMemo(() => {
    const values = new Map();
    for (const item of workspace.items) {
      if (item.category_id && item.category_name) {
        values.set(item.category_id, item.category_name);
      }
    }
    return [...values].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workspace.items]);

  const suppliers = useMemo(() => {
    const values = new Map();
    for (const item of workspace.items) {
      if (item.preferred_supplier_id && item.preferred_supplier_name) {
        values.set(item.preferred_supplier_id, item.preferred_supplier_name);
      }
    }
    return [...values].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workspace.items]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return workspace.items.filter((item) => {
      if (risk && item.risk_status !== risk) return false;
      if (categoryId && item.category_id !== categoryId) return false;
      if (supplierId && item.preferred_supplier_id !== supplierId) return false;
      if (!needle) return true;
      return [
        item.product_name,
        item.product_name_km,
        item.sku,
        item.barcode,
        item.category_name,
        item.preferred_supplier_name
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
  }, [workspace.items, search, risk, categoryId, supplierId]);

  const metrics = useMemo(() => {
    const run = workspace.run || {};
    const selectedItems = workspace.items.filter((item) => selected.has(item.product_id));
    return {
      critical: Number(run.out_of_stock_count || 0) + Number(run.critical_count || 0),
      urgent: Number(run.urgent_count || 0),
      watch: Number(run.watch_count || 0),
      slow: Number(run.slow_moving_count || 0),
      usd: selectedItems.filter((item) => item.currency === "USD")
        .reduce((sum, item) => sum + Number(item.estimated_order_total || 0), 0),
      khr: selectedItems.filter((item) => item.currency === "KHR")
        .reduce((sum, item) => sum + Number(item.estimated_order_total || 0), 0)
    };
  }, [workspace, selected]);

  const visibleEligible = visible.filter((item) => item.can_create_order);
  const allVisibleSelected = visibleEligible.length > 0 && visibleEligible.every(
    (item) => selected.has(item.product_id)
  );

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function toggle(item) {
    if (!item.can_create_order) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.product_id)) next.delete(item.product_id);
      else next.add(item.product_id);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of visibleEligible) {
        if (allVisibleSelected) next.delete(item.product_id);
        else next.add(item.product_id);
      }
      return next;
    });
  }

  async function handleRun() {
    try {
      setBusy("run");
      await runDemandForecast(supabase, branchId);
      announce("success", "Demand forecast completed.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleSaveSettings(values) {
    try {
      setBusy("settings");
      await saveDemandSettings(supabase, branchId, values);
      setSettingsOpen(false);
      announce("success", "Forecast settings saved.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleCreateOrders() {
    if (branchId !== profile?.branch_id) {
      announce(
        "error",
        "Switch the active branch in the header before creating purchase orders for this branch."
      );
      return;
    }

    const chosen = workspace.items.filter((item) => selected.has(item.product_id));
    if (!chosen.length) {
      announce("error", "Select at least one purchase suggestion.");
      return;
    }

    try {
      setBusy("orders");
      const created = await createForecastDraftPurchaseOrders(
        supabase,
        chosen,
        profile,
        workspace.run
      );
      setSelected(new Set());
      announce(
        "success",
        `${created.length} draft purchase order${created.length === 1 ? "" : "s"} created.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="demand-page">
      <div className="page-heading demand-heading">
        <div>
          <p className="eyebrow">FORECAST & PROCUREMENT</p>
          <h1>Demand Planning</h1>
          <p>Forecast product demand, estimate stockout dates and convert safe recommendations into draft purchase orders.</p>
        </div>
        <div className="page-actions">
          {canAllBranches && branches.length > 1 && (
            <label className="compact-field">
              Branch
              <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="secondary" onClick={refresh} disabled={loading || Boolean(busy)}>
            <RefreshCw size={18} /> Refresh
          </button>
          {canManage && (
            <button type="button" className="secondary" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={18} /> Settings
            </button>
          )}
          {canManage && (
            <button type="button" onClick={handleRun} disabled={Boolean(busy)}>
              <TrendingUp size={18} /> {busy === "run" ? "Forecasting…" : "Run forecast"}
            </button>
          )}
        </div>
      </div>

      {message && <div className={`notice ${messageType}`}>{message}</div>}

      <div className="demand-metrics">
        <div className="metric-card">
          <span>Critical stock risks</span>
          <strong className="viz-stat-value">{metrics.critical}</strong>
          <small>Out of stock or coverage below supplier lead time</small>
        </div>
        <div className="metric-card">
          <span>Urgent</span>
          <strong className="viz-stat-value">{metrics.urgent}</strong>
          <small>Inside lead time plus safety-stock window</small>
        </div>
        <div className="metric-card">
          <span>Watch list</span>
          <strong className="viz-stat-value">{metrics.watch}</strong>
          <small>Likely to need stock within the forecast horizon</small>
        </div>
        <div className="metric-card">
          <span>Forecast accuracy</span>
          <strong className="viz-stat-value">
            {workspace.run?.average_accuracy_percent == null
              ? "—"
              : `${number(workspace.run.average_accuracy_percent, 1)}%`}
          </strong>
          <small>Available after an older forecast horizon finishes</small>
        </div>
      </div>

      {!workspace.run?.id && !loading ? (
        <div className="empty-state demand-empty">
          <TrendingUp size={42} />
          <h2>No demand forecast yet</h2>
          <p>Run the first forecast to calculate daily demand, stock cover, stockout dates and purchase suggestions.</p>
          {canManage && <button type="button" onClick={handleRun}>Run first forecast</button>}
        </div>
      ) : (
        <>
          <div className="forecast-run-strip">
            <div>
              <CalendarClock size={18} />
              <span>As of <strong>{dateLabel(workspace.run?.as_of_date)}</strong></span>
            </div>
            <div>
              <Warehouse size={18} />
              <span>History <strong>{workspace.run?.history_days || 0} days</strong></span>
            </div>
            <div>
              <TrendingUp size={18} />
              <span>Horizon <strong>{workspace.run?.forecast_horizon_days || 0} days</strong></span>
            </div>
            <div>
              <CheckCircle2 size={18} />
              <span>{workspace.run?.source === "scheduled" ? "Automatic run" : "Manual run"}</span>
            </div>
          </div>

          <div className="card forecast-toolbar">
            <div className="forecast-filters">
              <label className="search-field">
                <Search size={18} />
                <input value={search} onChange={(event) => setSearch(event.target.value)}
                  placeholder="Product, SKU, barcode or supplier" />
              </label>
              <select value={risk} onChange={(event) => setRisk(event.target.value)}>
                {FORECAST_RISKS.map(([value, label]) => (
                  <option key={value || "all"} value={value}>{label}</option>
                ))}
              </select>
              <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                <option value="">All suppliers</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </div>
            <div className="forecast-actions">
              <button type="button" className="secondary" onClick={() => exportForecastCsv(visible, workspace.run)}>
                <Download size={17} /> Export CSV
              </button>
              {canCreateOrders && (
                <button type="button" onClick={handleCreateOrders} disabled={busy === "orders" || selected.size === 0}>
                  <ShoppingCart size={17} />
                  {busy === "orders" ? "Creating…" : `Create draft POs (${selected.size})`}
                </button>
              )}
            </div>
          </div>

          {selected.size > 0 && (
            <div className="forecast-selection-summary">
              <strong>{selected.size} selected</strong>
              <span>USD estimate: {money(metrics.usd, "USD")}</span>
              <span>KHR estimate: {money(metrics.khr, "KHR")}</span>
            </div>
          )}

          <div className="table-wrap demand-table-wrap">
            <table className="demand-table">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" checked={allVisibleSelected}
                      onChange={toggleVisible} aria-label="Select visible suggestions" />
                  </th>
                  <th>Risk</th>
                  <th>Product</th>
                  <th>Demand / day</th>
                  <th>Stock position</th>
                  <th>Days cover</th>
                  <th>Stockout</th>
                  <th>Purchase suggestion</th>
                  <th>Supplier</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input type="checkbox" disabled={!item.can_create_order}
                        checked={selected.has(item.product_id)} onChange={() => toggle(item)} />
                    </td>
                    <td><span className={`status ${forecastRiskClass(item.risk_status)}`}>
                      {forecastRiskLabel(item.risk_status)}
                    </span></td>
                    <td>
                      <strong>{item.product_name}</strong>
                      <small>{[item.sku, item.barcode, item.category_name].filter(Boolean).join(" · ")}</small>
                    </td>
                    <td>
                      <strong>{number(item.forecast_daily_demand, 3)} {item.base_unit_name}</strong>
                      <small>
                        {Number(item.trend_factor || 1) >= 1
                          ? <><TrendingUp size={14} /> Trend {number(Number(item.trend_factor || 1) * 100, 0)}%</>
                          : <><TrendingDown size={14} /> Trend {number(Number(item.trend_factor || 1) * 100, 0)}%</>}
                      </small>
                    </td>
                    <td>
                      <strong>{number(item.available_stock, 3)} available</strong>
                      <small>
                        Physical {number(item.current_stock, 3)} · Reserved {number(item.reserved_stock, 3)} · Incoming {number(item.incoming_stock, 3)}
                      </small>
                    </td>
                    <td>
                      <strong>{item.days_of_cover == null ? "—" : `${number(item.days_of_cover, 1)} days`}</strong>
                      <small>Safety {number(item.safety_stock_quantity, 3)}</small>
                    </td>
                    <td>
                      <strong>{dateLabel(item.expected_stockout_date)}</strong>
                      <small>Order by {dateLabel(item.recommended_order_date)}</small>
                    </td>
                    <td>
                      <strong>{number(item.suggested_purchase_quantity, 3)} {item.purchase_unit_name || "units"}</strong>
                      <small>
                        {money(item.estimated_order_total, item.currency)}
                        {item.draft_purchase_stock > 0 ? " · Draft PO already exists" : ""}
                      </small>
                    </td>
                    <td>
                      <strong>{item.preferred_supplier_name || "Not configured"}</strong>
                      <small>
                        Lead time {item.lead_time_days || 0} days
                        {!item.can_create_order && item.suggested_purchase_quantity > 0 ? " · Configure in Reorder Planner" : ""}
                      </small>
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr><td colSpan="9" className="empty-cell">No forecast items match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="forecast-help-grid">
            <div className="viz-callout">
              <AlertTriangle size={20} />
              <div>
                <strong>Recommendations are planning guidance</strong>
                <p>Review supplier availability, case sizes, promotions and cash flow before ordering. Tiny POS creates Draft purchase orders only.</p>
              </div>
            </div>
            <div className="card forecast-history-card">
              <div className="section-heading">
                <div><h2>Recent forecast runs</h2><p>Accuracy appears after the full horizon has elapsed.</p></div>
                <Link to="/reorder">Open Reorder Planner</Link>
              </div>
              <div className="forecast-history-list">
                {workspace.history.slice(0, 5).map((run) => (
                  <div key={run.id}>
                    <span>{dateLabel(run.as_of_date)}</span>
                    <span>{run.source === "scheduled" ? "Automatic" : "Manual"}</span>
                    <span>{Number(run.critical_count || 0) + Number(run.out_of_stock_count || 0)} critical</span>
                    <strong>{run.average_accuracy_percent == null ? "Accuracy pending" : `${number(run.average_accuracy_percent, 1)}% accuracy`}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <DemandPlanningSettingsModal
        open={settingsOpen}
        settings={workspace.settings}
        busy={busy === "settings"}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
