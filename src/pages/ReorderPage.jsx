import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Edit3,
  PackageCheck,
  RefreshCw,
  Search,
  ShoppingCart,
  Truck
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ReorderRuleModal from "../components/ReorderRuleModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import MediaImage from "../components/MediaImage";
import { money, stockNumber } from "../lib/catalog";
import {
  createDraftPurchaseOrders,
  loadReorderWorkspace,
  reorderStatusClass,
  reorderStatusLabel,
  saveReorderRule
} from "../lib/reorder";

const statuses = [
  ["", "All statuses"],
  ["attention", "Low stock (all attention)"],
  ["out_of_stock", "Out of stock"],
  ["reorder", "Reorder now"],
  ["draft_order", "Draft PO exists"],
  ["incoming", "Incoming stock"],
  ["unconfigured", "Default rule"],
  ["ok", "Stock healthy"]
];

export default function ReorderPage() {
  const { supabase, profile, can } = useAuth();

  const canManage = can("reorder.manage");
  const [searchParams, setSearchParams] = useSearchParams();

  const [suggestions, setSuggestions] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [selectedIds, setSelectedIds] =
    useState(new Set());

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(() => searchParams.get("status") || "");
  const [supplierId, setSupplierId] = useState("");
  const [categoryId, setCategoryId] = useState("");

  const [ruleProduct, setRuleProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] =
    useState("success");

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

      const workspace =
        await loadReorderWorkspace(
          supabase,
          profile
        );

      setSuggestions(workspace.suggestions);
      setSuppliers(workspace.suppliers);

      setSelectedIds((current) => {
        const eligible = new Set(
          workspace.suggestions
            .filter((item) => item.can_create_order)
            .map((item) => item.product_id)
        );

        return new Set(
          [...current].filter((id) => eligible.has(id))
        );
      });
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, canManage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const requested = searchParams.get("status") || "";
    if (requested !== status) setStatus(requested);
  }, [searchParams]);

  const categories = useMemo(() => {
    const map = new Map();

    for (const item of suggestions) {
      if (item.category_id && item.category_name) {
        map.set(
          item.category_id,
          item.category_name
        );
      }
    }

    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      );
  }, [suggestions]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return suggestions.filter((item) => {
      if (status === "attention" && Number(item.current_stock || 0) > Number(item.reorder_point || 0)) {
        return false;
      }

      if (status === "out_of_stock" && Number(item.current_stock || 0) > 0) {
        return false;
      }

      if (status && !["attention", "out_of_stock"].includes(status) && item.reorder_status !== status) {
        return false;
      }

      if (
        supplierId
        && item.preferred_supplier_id
          !== supplierId
      ) {
        return false;
      }

      if (
        categoryId
        && item.category_id !== categoryId
      ) {
        return false;
      }

      if (!needle) return true;

      return [
        item.product_name,
        item.name_km,
        item.sku,
        item.barcode,
        item.category_name,
        item.preferred_supplier_name,
        item.supplier_code,
        item.supplier_sku,
        item.purchase_unit_name
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [
    suggestions,
    search,
    status,
    supplierId,
    categoryId
  ]);

  const metrics = useMemo(() => {
    return {
      reorder: suggestions.filter(
        (item) =>
          item.reorder_status === "reorder"
          || item.reorder_status === "out_of_stock"
      ).length,

      outOfStock: suggestions.filter(
        (item) =>
          item.reorder_status === "out_of_stock"
      ).length,

      incoming: suggestions.filter(
        (item) =>
          item.reorder_status === "incoming"
      ).length,

      draft: suggestions.filter(
        (item) =>
          item.reorder_status === "draft_order"
      ).length,

      selectedUsd: suggestions
        .filter(
          (item) =>
            selectedIds.has(item.product_id)
            && item.currency === "USD"
        )
        .reduce(
          (sum, item) =>
            sum
            + Number(
              item.estimated_order_total || 0
            ),
          0
        ),

      selectedKhr: suggestions
        .filter(
          (item) =>
            selectedIds.has(item.product_id)
            && item.currency === "KHR"
        )
        .reduce(
          (sum, item) =>
            sum
            + Number(
              item.estimated_order_total || 0
            ),
          0
        )
    };
  }, [suggestions, selectedIds]);

  const selectedSuggestions = useMemo(
    () =>
      suggestions.filter((item) =>
        selectedIds.has(item.product_id)
      ),
    [suggestions, selectedIds]
  );

  const allVisibleEligible = visible.filter(
    (item) => item.can_create_order
  );

  const allVisibleSelected =
    allVisibleEligible.length > 0
    && allVisibleEligible.every((item) =>
      selectedIds.has(item.product_id)
    );

  function changeStatus(nextStatus) {
    setStatus(nextStatus);
    const next = new URLSearchParams(searchParams);
    if (nextStatus) next.set("status", nextStatus);
    else next.delete("status");
    setSearchParams(next, { replace: true });
  }

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function toggleOne(item) {
    if (!item.can_create_order) return;

    setSelectedIds((current) => {
      const next = new Set(current);

      if (next.has(item.product_id)) {
        next.delete(item.product_id);
      } else {
        next.add(item.product_id);
      }

      return next;
    });
  }

  function toggleVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (allVisibleSelected) {
        for (const item of allVisibleEligible) {
          next.delete(item.product_id);
        }
      } else {
        for (const item of allVisibleEligible) {
          next.add(item.product_id);
        }
      }

      return next;
    });
  }

  async function handleRuleSave(values) {
    try {
      setBusy("rule");
      await saveReorderRule(
        supabase,
        values
      );

      setRuleProduct(null);
      announce(
        "success",
        "Reorder rule saved."
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function createDraftOrders() {
    if (selectedSuggestions.length === 0) {
      announce(
        "error",
        "Select at least one reorder suggestion."
      );
      return;
    }

    try {
      setBusy("orders");

      const created =
        await createDraftPurchaseOrders(
          supabase,
          selectedSuggestions,
          profile
        );

      setSelectedIds(new Set());

      announce(
        "success",
        `${created.length} draft purchase order${
          created.length === 1 ? "" : "s"
        } created for ${created.reduce(
          (sum, order) =>
            sum + Number(order.item_count || 0),
          0
        )} product${
          created.reduce(
            (sum, order) =>
              sum + Number(order.item_count || 0),
            0
          ) === 1
            ? ""
            : "s"
        }.`
      );

      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <ClipboardList size={46} />
        <h2>Management access required</h2>
        <p>
          Only an owner, admin or manager can
          use Reorder Planning.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack reorder-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            INVENTORY PLANNING
          </p>
          <h1>Reorder Planner</h1>
          <p className="muted">
            Convert low-stock products into
            package-aware draft purchase orders.
          </p>
        </div>

        <div className="page-heading-actions">
          <Link
            to="/purchase-orders"
            className="secondary-button"
          >
            <ShoppingCart size={18} />
            Purchase orders
          </Link>


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

      <div className="reorder-metrics">
        <article>
          <AlertTriangle size={23} />
          <span>Need reorder</span>
          <strong>{metrics.reorder}</strong>
        </article>

        <article>
          <Boxes size={23} />
          <span>Out of stock</span>
          <strong>{metrics.outOfStock}</strong>
        </article>

        <article>
          <Truck size={23} />
          <span>Incoming</span>
          <strong>{metrics.incoming}</strong>
        </article>

        <article>
          <ClipboardList size={23} />
          <span>Draft PO exists</span>
          <strong>{metrics.draft}</strong>
        </article>

        <article>
          <PackageCheck size={23} />
          <span>Selected estimate</span>
          <strong>
            {money(metrics.selectedUsd, "USD")}
          </strong>
          <small>
            {money(metrics.selectedKhr, "KHR")}
            {" · Separate purchase orders by currency"}
          </small>
        </article>
      </div>

      <section className="panel reorder-filter-panel">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            placeholder="Search product, code, supplier, category or package"
          />
        </div>

        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) =>
              changeStatus(event.target.value)
            }
          >
            {statuses.map(([value, label]) => (
              <option
                value={value}
                key={value || "all"}
              >
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Supplier</span>
          <select
            value={supplierId}
            onChange={(event) =>
              setSupplierId(event.target.value)
            }
          >
            <option value="">
              All suppliers
            </option>
            {suppliers.map((supplier) => (
              <option
                value={supplier.id}
                key={supplier.id}
              >
                {supplier.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Category</span>
          <select
            value={categoryId}
            onChange={(event) =>
              setCategoryId(event.target.value)
            }
          >
            <option value="">
              All categories
            </option>
            {categories.map((category) => (
              <option
                value={category.id}
                key={category.id}
              >
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel reorder-selection-toolbar">
        <label className="check-row">
          <input type="checkbox" checked={allVisibleSelected} disabled={allVisibleEligible.length === 0} onChange={toggleVisible} />
          <span>Select visible products ready for ordering</span>
        </label>
        <button type="button" className="primary-button" onClick={createDraftOrders} disabled={busy === "orders" || selectedSuggestions.length === 0}>
          <ClipboardList size={18} />
          {busy === "orders" ? "Creating draft orders..." : `Create draft PO${selectedSuggestions.length > 1 ? "s" : ""} (${selectedSuggestions.length})`}
        </button>
      </section>

      <ResponsiveDataList
        storageKey="reorder-planner"
        title="Reorder planner list"
        subtitle={`${profile?.branches?.name || "Current branch"} · Current filters`}
        rows={visible}
        filename={`tiny-pos-reorder-${new Date().toISOString().slice(0, 10)}.xls`}
        summary={[
          { label: "Reorder now", value: metrics.reorder },
          { label: "Out of stock", value: metrics.outOfStock },
          { label: "Incoming", value: metrics.incoming },
          { label: "Draft PO", value: metrics.draft },
          { label: "Selected USD", value: money(metrics.selectedUsd, "USD") },
          { label: "Selected KHR", value: money(metrics.selectedKhr, "KHR") }
        ]}
        emptyTitle={loading ? "Calculating reorder suggestions..." : "No matching products"}
        emptyText="Change the filters or search phrase."
        columns={[
          { label: "Select", actionsOnly: true, excludeDocument: true, render: (item) => <input type="checkbox" checked={selectedIds.has(item.product_id)} disabled={!item.can_create_order} onChange={() => toggleOne(item)} title={item.can_create_order ? "Select product" : item.draft_base_quantity > 0 ? "A draft purchase order already exists" : "Configure a preferred supplier first"} /> },
          { label: "Product", width: 260, documentValue: (item) => item.product_name, render: (item) => <div className="reorder-product-cell"><div className="reorder-product-thumb"><MediaImage src={item.product_image_url} alt={item.product_name} width={96} height={96} /></div><div><strong>{item.product_name}</strong><small>{[item.sku, item.barcode, item.category_name].filter(Boolean).join(" · ") || "No product code"}</small></div></div> },
          { label: "Status", width: 120, documentValue: (item) => reorderStatusLabel(item.reorder_status), render: (item) => <span className={`reorder-status ${reorderStatusClass(item.reorder_status)}`}>{reorderStatusLabel(item.reorder_status)}</span> },
          { label: "Stock", width: 160, documentValue: (item) => `${stockNumber(item.current_stock)} ${item.base_unit_name}`, render: (item) => <><strong>{stockNumber(item.current_stock)} {item.base_unit_name}</strong><small>Ordered {stockNumber(item.ordered_base_quantity)} · Projected {stockNumber(item.projected_stock)}</small></> },
          { label: "Rule", width: 140, documentValue: (item) => `Reorder at ${stockNumber(item.reorder_point)}; Target ${stockNumber(item.target_stock)} ${item.base_unit_name}`, render: (item) => <><strong>Reorder at {stockNumber(item.reorder_point)}</strong><small>Target {stockNumber(item.target_stock)} {item.base_unit_name}</small></> },
          { label: "Supplier", width: 170, documentValue: (item) => item.preferred_supplier_name || "Not configured", render: (item) => <><strong>{item.preferred_supplier_name || "Not configured"}</strong><small>{item.supplier_code || item.supplier_sku || "Add a preferred supplier"}</small></> },
          { label: "Suggested order", width: 180, documentValue: (item) => `${stockNumber(item.suggested_purchase_quantity)} ${item.purchase_unit_name || item.base_unit_name}`, render: (item) => <><strong>{stockNumber(item.suggested_purchase_quantity)} {item.purchase_unit_name || item.base_unit_name}</strong><small>{stockNumber(item.suggested_base_quantity)} {item.base_unit_name} · 1 {item.purchase_unit_name || item.base_unit_name} = {stockNumber(item.purchase_unit_factor)} {item.base_unit_name}</small></> },
          { label: "Estimate", width: 130, documentValue: (item) => money(item.estimated_order_total, item.currency), render: (item) => <><strong>{money(item.estimated_order_total, item.currency)}</strong><small>{money(item.estimated_purchase_unit_cost, item.currency)} per {item.purchase_unit_name || item.base_unit_name}</small></> },
          { label: "Configure", actionsOnly: true, excludeDocument: true, render: (item) => <button type="button" className="icon-button" onClick={() => setRuleProduct(item)} title="Configure reorder rule"><Edit3 size={18} /></button> }
        ]}
        renderCard={(item) => (
          <article className="responsive-data-card reorder-list-card">
            <header><div className="reorder-card-product"><label className="check-row"><input type="checkbox" checked={selectedIds.has(item.product_id)} disabled={!item.can_create_order} onChange={() => toggleOne(item)} /><span className="reorder-product-thumb"><MediaImage src={item.product_image_url} alt={item.product_name} width={96} height={96} /></span></label><div><strong>{item.product_name}</strong><small>{item.sku || item.barcode || "No code"}</small></div></div><span className={`reorder-status ${reorderStatusClass(item.reorder_status)}`}>{reorderStatusLabel(item.reorder_status)}</span></header>
            <div><span>Stock</span><strong>{stockNumber(item.current_stock)} {item.base_unit_name}</strong><small>Projected {stockNumber(item.projected_stock)}</small></div>
            <div><span>Reorder rule</span><strong>{stockNumber(item.reorder_point)} → {stockNumber(item.target_stock)} {item.base_unit_name}</strong></div>
            <div><span>Supplier</span><strong>{item.preferred_supplier_name || "Not configured"}</strong></div>
            <div><span>Suggested</span><strong>{stockNumber(item.suggested_purchase_quantity)} {item.purchase_unit_name || item.base_unit_name}</strong></div>
            <div><span>Estimate</span><strong>{money(item.estimated_order_total, item.currency)}</strong></div>
            <footer><button type="button" className="secondary-button compact-button" onClick={() => setRuleProduct(item)}><Edit3 size={17} />Configure</button></footer>
          </article>
        )}
      />

      <ReorderRuleModal
        suggestion={ruleProduct}
        suppliers={suppliers}
        busy={busy === "rule"}
        onClose={() => setRuleProduct(null)}
        onSave={handleRuleSave}
      />
    </div>
  );
}
