import { useEffect, useMemo, useState } from "react";
import { Building2, History, RefreshCw, Search, Warehouse } from "lucide-react";
import Modal from "./Modal";
import ResponsiveDataList from "./ResponsiveDataList";
import { loadProductStockWorkspace } from "../lib/productInsights";
import { money, stockNumber } from "../lib/catalog";

function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function dateOnly(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(`${value}T00:00:00`)
  );
}

function amountText(value, unitName) {
  const amount = Number(value || 0);
  const sign = amount > 0 ? "+" : "";
  return `${sign}${stockNumber(amount)} ${unitName || ""}`.trim();
}

function stockText(value, unitName) {
  return `${stockNumber(value)} ${unitName || ""}`.trim();
}

export default function ProductInsightsModal({ supabase, product, onClose }) {
  const [tab, setTab] = useState("history");
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  async function refresh() {
    try {
      setLoading(true);
      setError("");
      const data = await loadProductStockWorkspace(supabase, product.id);
      setWorkspace(data);
    } catch (requestError) {
      setError(requestError.message || "Unable to load product history.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [product.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const unitName = workspace?.product?.unit_name || product.unit_name || "pcs";
  const currency = workspace?.product?.currency || product.currency || "USD";

  const historyRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return workspace?.history || [];

    return (workspace?.history || []).filter((row) => [
      row.code,
      row.type,
      row.branch_name,
      row.branch_code,
      row.created_by,
      row.notes,
      row.reference_table
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  }, [workspace, search]);

  const columns = [
    {
      label: "Code",
      width: 170,
      value: (row) => row.code || "—",
      render: (row) => <strong className="product-history-code">{row.code || "—"}</strong>
    },
    {
      label: "Type",
      width: 150,
      value: (row) => row.type || "—",
      render: (row) => <span className="product-history-type">{row.type || "—"}</span>
    },
    {
      label: "Branch",
      width: 145,
      value: (row) => row.branch_name || "—",
      render: (row) => <><strong>{row.branch_name || "—"}</strong><small>{row.branch_code || ""}</small></>
    },
    {
      label: "Created by",
      width: 145,
      value: (row) => row.created_by || "System"
    },
    {
      label: "Date",
      width: 170,
      value: (row) => dateTime(row.created_at)
    },
    {
      label: "Amount",
      width: 118,
      value: (row) => amountText(row.amount, unitName),
      render: (row) => (
        <strong className={Number(row.amount || 0) < 0 ? "stock-history-negative" : Number(row.amount || 0) > 0 ? "stock-history-positive" : ""}>
          {amountText(row.amount, unitName)}
        </strong>
      )
    },
    {
      label: "Current stock",
      width: 125,
      value: (row) => stockText(row.current_stock, unitName),
      render: (row) => <strong>{stockText(row.current_stock, unitName)}</strong>
    }
  ];

  return (
    <Modal
      title={`${product.name || "Product"} · ${product.sku || "Product"}`}
      onClose={onClose}
      wide
      className="product-insights-modal"
      bodyClassName="product-insights-modal-body"
    >
      <div className="product-insights-topbar">
        <div className="product-insights-tabs" role="tablist" aria-label="Product information">
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            <History size={18} /> Product History
          </button>
          <button type="button" className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>
            <Warehouse size={18} /> Stock Summary
          </button>
        </div>
        <button type="button" className="secondary-button compact-button" onClick={refresh} disabled={loading}>
          <RefreshCw size={17} className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      <div className="product-insights-product-strip">
        <div><span>Product</span><strong>{workspace?.product?.name || product.name}</strong>{workspace?.product?.name_km && <small>{workspace.product.name_km}</small>}</div>
        <div><span>Code</span><strong>{workspace?.product?.sku || product.sku || "—"}</strong></div>
        <div><span>Base unit</span><strong>{unitName}</strong></div>
        <div><span>All branches</span><strong>{stockText(workspace?.totalStock || 0, unitName)}</strong></div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {loading && !workspace ? (
        <div className="empty-state compact"><RefreshCw className="spin" size={30} /><p>Loading product information...</p></div>
      ) : tab === "history" ? (
        <div className="product-history-tab">
          <label className="search-box product-history-search">
            <Search size={18} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code, type, user or branch" />
          </label>

          <ResponsiveDataList
            storageKey={`product-history:${product.id}`}
            title="Product History"
            subtitle="Complete stock movement ledger from the first recorded stock movement."
            rows={historyRows}
            columns={columns}
            filename={`product-history-${product.sku || product.id}.xls`}
            printTitle={`Product History · ${workspace?.product?.name || product.name}`}
            summary={[
              { label: "Product code", value: workspace?.product?.sku || product.sku || "—" },
              { label: "Base unit", value: unitName },
              { label: "All-branch stock", value: stockText(workspace?.totalStock || 0, unitName) }
            ]}
            emptyTitle="No stock history yet"
            emptyText="This product has no recorded stock movement matching the current search."
            orientation="landscape"
            renderCard={(row) => (
              <article className="responsive-data-card product-history-card">
                <header>
                  <div><strong>{row.code || "—"}</strong><small>{row.type || "—"}</small></div>
                  <span className={Number(row.amount || 0) < 0 ? "stock-history-negative" : "stock-history-positive"}>{amountText(row.amount, unitName)}</span>
                </header>
                <div><span>Branch</span><strong>{row.branch_name || "—"}</strong><small>{row.branch_code || ""}</small></div>
                <div><span>Created by</span><strong>{row.created_by || "System"}</strong></div>
                <div><span>Date</span><strong>{dateTime(row.created_at)}</strong></div>
                <div><span>Current stock</span><strong>{stockText(row.current_stock, unitName)}</strong></div>
                {row.notes && <div className="product-history-card-note"><span>Note</span><small>{row.notes}</small></div>}
              </article>
            )}
          />
        </div>
      ) : (
        <div className="product-stock-summary-tab">
          <div className="product-stock-summary-heading">
            <div>
              <p className="eyebrow">ALL BRANCHES</p>
              <h3>Current stock by branch</h3>
              <p>Use this view to decide whether to transfer stock, reorder, or move inventory before expiry.</p>
            </div>
            <div className="product-stock-total">
              <span>Total stock</span>
              <strong>{stockText(workspace?.totalStock || 0, unitName)}</strong>
            </div>
          </div>

          <div className="product-branch-stock-grid">
            {(workspace?.stockSummary || []).map((branch) => {
              const low = Number(branch.quantity || 0) <= Number(branch.low_stock_threshold || 0);
              return (
                <article className={`product-branch-stock-card ${branch.is_current_branch ? "current" : ""}`} key={branch.branch_id}>
                  <header>
                    <div><Building2 size={19} /><span><strong>{branch.branch_name}</strong><small>{branch.branch_code || "No branch code"}</small></span></div>
                    <div className="product-branch-badges">
                      {branch.is_current_branch && <span className="status-pill active">Current branch</span>}
                      {!branch.branch_active && <span className="status-pill inactive">Inactive</span>}
                    </div>
                  </header>

                  <div className="product-branch-stock-quantity">
                    <span>Current stock</span>
                    <strong className={low ? "stock-history-negative" : ""}>{stockText(branch.quantity, unitName)}</strong>
                    <small>Low-stock level: {stockText(branch.low_stock_threshold, unitName)}</small>
                  </div>

                  <div className="product-branch-stock-details">
                    <div><span>Average cost</span><strong>{money(branch.average_cost || 0, currency)}</strong></div>
                    <div><span>Stock value</span><strong>{money(branch.stock_value || 0, currency)}</strong></div>
                    <div><span>Active batches</span><strong>{Number(branch.active_batches || 0)}</strong></div>
                    <div><span>Batch stock</span><strong>{stockText(branch.batch_quantity || 0, unitName)}</strong></div>
                    <div><span>Nearest expiry</span><strong>{dateOnly(branch.nearest_expiry)}</strong></div>
                    <div><span>Expiring ≤30 days</span><strong>{stockText(branch.expiring_30_days || 0, unitName)}</strong></div>
                  </div>
                </article>
              );
            })}
          </div>

          {!workspace?.stockSummary?.length && (
            <div className="empty-state compact"><p>No branch inventory rows found for this product.</p></div>
          )}
        </div>
      )}
    </Modal>
  );
}
