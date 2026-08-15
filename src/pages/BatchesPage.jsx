import {
  AlertTriangle,
  Boxes,
  CalendarClock,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import BatchFormModal from "../components/BatchFormModal";
import BatchAdjustmentModal from "../components/BatchAdjustmentModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import { money, stockNumber } from "../lib/catalog";
import {
  adjustInventoryBatch,
  batchDate,
  batchDaysRemaining,
  changeInventoryBatchStatus,
  createInventoryBatch,
  effectiveBatchStatus,
  loadBatchWorkspace
} from "../lib/batches";

export default function BatchesPage() {
  const { supabase, profile, can } = useAuth();
  const canAdjust = can("inventory.adjust");
  const [products, setProducts] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("available");
  const [productId, setProductId] = useState("all");
  const [categoryId, setCategoryId] = useState("all");
  const [pickingPolicy, setPickingPolicy] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(null);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.branch_id) return;
    try {
      setLoading(true);
      const data = await loadBatchWorkspace(supabase, profile);
      setProducts(data.products);
      setBatches(data.batches);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile]);

  useEffect(() => { refresh(); }, [refresh]);

  const productMap = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );

  const categories = useMemo(() => {
    const map = new Map();
    for (const product of products) {
      if (product.categories?.id) map.set(product.categories.id, product.categories.name);
    }
    return [...map.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }, [products]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return batches.filter((batch) => {
      const effective = effectiveBatchStatus(batch);
      const product = productMap.get(batch.product_id);
      if (productId !== "all" && batch.product_id !== productId) return false;
      if (categoryId !== "all" && product?.categories?.id !== categoryId) return false;
      if (pickingPolicy !== "all" && String(product?.picking_policy || batch.products?.picking_policy || "fifo").toLowerCase() !== pickingPolicy) return false;
      if (status === "available" && !["active", "expiring"].includes(effective)) return false;
      if (status !== "all" && status !== "available" && effective !== status) return false;
      return !needle || [
        batch.batch_number,
        batch.products?.name,
        batch.products?.sku,
        batch.products?.barcode,
        batch.suppliers?.name,
        batch.purchase_receipt_items?.purchase_receipts?.receipt_number
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
  }, [batches, search, status, productId, categoryId, pickingPolicy, productMap]);

  const metrics = useMemo(() => {
    let active = 0;
    let expiring = 0;
    let expired = 0;
    let quarantined = 0;
    for (const batch of batches) {
      const current = effectiveBatchStatus(batch);
      if (current === "active") active += 1;
      if (current === "expiring") expiring += 1;
      if (current === "expired") expired += 1;
      if (current === "quarantined") quarantined += 1;
    }
    return { active, expiring, expired, quarantined };
  }, [batches]);

  const unassigned = useMemo(() => products
    .filter((product) => product.batch_tracking)
    .reduce((sum, product) => {
      const assigned = batches
        .filter((batch) => batch.product_id === product.id)
        .reduce((subtotal, batch) => subtotal + batch.quantity, 0);
      return sum + Math.max(0, product.stock_quantity - assigned);
    }, 0), [products, batches]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function saveBatch(values) {
    try {
      setBusy(true);
      const result = await createInventoryBatch(supabase, values);
      setFormOpen(false);
      announce("success", `Batch ${result.batch.batch_number} saved.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAdjustment(values) {
    try {
      setBusy(true);
      const result = await adjustInventoryBatch(supabase, values);
      setAdjusting(null);
      announce("success", `Batch updated to ${stockNumber(result.batch.quantity)} units.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(batch) {
    const target = batch.status === "quarantined" ? "active" : "quarantined";
    let reason = "";
    if (target === "quarantined") {
      reason = window.prompt(`Reason for quarantining ${batch.batch_number}:`) || "";
      if (reason.trim().length < 3) return;
    }
    try {
      setBusy(true);
      await changeInventoryBatchStatus(supabase, batch.id, target, reason);
      announce("success", `Batch ${batch.batch_number} marked ${target}.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack batch-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOT TRACEABILITY</p>
          <h1>Batch & Expiry Center</h1>
          <p className="muted">Track lots, expiry dates, FIFO/FEFO picking, quarantine and batch valuation.</p>
        </div>
        <div className="page-heading-actions">
          <button className="primary-button" onClick={() => setFormOpen(true)} disabled={!canAdjust}><Plus size={18} />Add batch</button>
          <button className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={18} className={loading ? "spin" : ""} />Refresh</button>
        </div>
      </div>

      {message && <div className={`notice ${messageType}`} onClick={() => setMessage("")}>{message}</div>}

      <div className="batch-metrics">
        <article><Boxes size={21} /><span>Available batches</span><strong>{metrics.active + metrics.expiring}</strong></article>
        <article><CalendarClock size={21} /><span>Expiring within 30 days</span><strong>{metrics.expiring}</strong></article>
        <article><AlertTriangle size={21} /><span>Expired</span><strong>{metrics.expired}</strong></article>
        <article><ShieldAlert size={21} /><span>Quarantined</span><strong>{metrics.quarantined}</strong></article>
        <article><Boxes size={21} /><span>Unassigned existing units</span><strong>{stockNumber(unassigned)}</strong></article>
      </div>

      {unassigned > 0 && <div className="notice warning">Some existing stock is not assigned to a lot. Use Add Batch with “Assign existing unbatched stock” before selling batch-tracked products.</div>}

      <section className="panel batch-toolbar">
        <label className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product, batch, supplier or GRN" /></label>
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="all">All categories</option>
          {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={productId} onChange={(event) => setProductId(event.target.value)}>
          <option value="all">All products</option>
          {products.filter((product) => product.batch_tracking).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
        <select value={pickingPolicy} onChange={(event) => setPickingPolicy(event.target.value)} aria-label="Filter batches by picking policy">
          <option value="all">All</option>
          <option value="fifo">FIFO</option>
          <option value="fefo">FEFO</option>
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="available">Available for sale</option>
          <option value="active">Active</option>
          <option value="expiring">Expiring</option>
          <option value="expired">Expired</option>
          <option value="quarantined">Quarantined</option>
          <option value="depleted">Depleted</option>
          <option value="all">All statuses</option>
        </select>
      </section>

      <ResponsiveDataList
        storageKey="batch-expiry-list"
        title="Batch and expiry list"
        subtitle={`${profile?.branches?.name || "Current branch"} · Current filters`}
        rows={rows}
        filename={`tiny-pos-batches-${new Date().toISOString().slice(0, 10)}.xls`}
        summary={[
          { label: "Available", value: metrics.active + metrics.expiring },
          { label: "Expired", value: metrics.expired },
          { label: "Quarantined", value: metrics.quarantined },
          { label: "Unassigned units", value: stockNumber(unassigned) }
        ]}
        emptyTitle={loading ? "Loading batches..." : "No matching batches"}
        emptyText="Receive a batch-tracked purchase or add an opening batch."
        columns={[
          { label: "Product / lot", width: 240, documentValue: (batch) => `${batch.products?.name || "—"} · ${batch.batch_number}`, render: (batch) => <><strong>{batch.products?.name}</strong><small>{batch.batch_number} · {batch.products?.sku || "No code"} · {batch.products?.picking_policy?.toUpperCase()}</small></> },
          { label: "Category", width: 130, value: (batch) => productMap.get(batch.product_id)?.categories?.name || "Uncategorized" },
          { label: "Received", width: 105, documentValue: (batch) => batchDate(batch.received_date), render: (batch) => batchDate(batch.received_date) },
          { label: "Expiry", width: 145, documentValue: (batch) => batchDate(batch.expiry_date), render: (batch) => { const days = batchDaysRemaining(batch.expiry_date); return <><strong>{batchDate(batch.expiry_date)}</strong>{days !== null && <small>{days < 0 ? `${Math.abs(days)} days expired` : `${days} days remaining`}</small>}</>; } },
          { label: "Status", width: 100, documentValue: (batch) => effectiveBatchStatus(batch), render: (batch) => { const effective = effectiveBatchStatus(batch); return <span className={`batch-status ${effective}`}>{effective}</span>; } },
          { label: "Quantity", width: 120, documentValue: (batch) => `${stockNumber(batch.quantity)} ${batch.products?.unit_name || ""}`, render: (batch) => <><strong>{stockNumber(batch.quantity)} {batch.products?.unit_name}</strong><small>Initial {stockNumber(batch.initial_quantity)}</small></> },
          { label: "Unit cost", width: 100, documentValue: (batch) => money(batch.unit_cost, batch.products?.currency || "USD"), render: (batch) => money(batch.unit_cost, batch.products?.currency || "USD") },
          { label: "Value", width: 110, documentValue: (batch) => money(batch.quantity * batch.unit_cost, batch.products?.currency || "USD"), render: (batch) => <strong>{money(batch.quantity * batch.unit_cost, batch.products?.currency || "USD")}</strong> },
          { label: "Source", width: 130, value: (batch) => batch.purchase_receipt_items?.purchase_receipts?.receipt_number || batch.source_type },
          { label: "Actions", actionsOnly: true, excludeDocument: true, render: (batch) => <div className="batch-row-actions"><button className="icon-button" onClick={() => setAdjusting(batch)} disabled={!canAdjust || batch.status === "depleted"} title="Adjust batch"><PencilLine size={17} /></button><button className="secondary-button compact" onClick={() => toggleStatus(batch)} disabled={!canAdjust || batch.status === "depleted"}>{batch.status === "quarantined" ? "Release" : "Quarantine"}</button></div> }
        ]}
        renderCard={(batch) => {
          const effective = effectiveBatchStatus(batch);
          const days = batchDaysRemaining(batch.expiry_date);
          return (
            <article className="responsive-data-card batch-list-card">
              <header><div><strong>{batch.products?.name}</strong><small>{batch.batch_number} · {batch.products?.sku || "No code"}</small></div><span className={`batch-status ${effective}`}>{effective}</span></header>
              <div><span>Category</span><strong>{productMap.get(batch.product_id)?.categories?.name || "Uncategorized"}</strong></div>
              <div><span>Received</span><strong>{batchDate(batch.received_date)}</strong></div>
              <div><span>Expiry</span><strong>{batchDate(batch.expiry_date)}</strong><small>{days === null ? "No expiry" : days < 0 ? `${Math.abs(days)} days expired` : `${days} days remaining`}</small></div>
              <div><span>Quantity</span><strong>{stockNumber(batch.quantity)} {batch.products?.unit_name}</strong></div>
              <div><span>Value</span><strong>{money(batch.quantity * batch.unit_cost, batch.products?.currency || "USD")}</strong></div>
              <footer><button className="secondary-button compact-button" onClick={() => setAdjusting(batch)} disabled={!canAdjust || batch.status === "depleted"}>Adjust</button><button className="secondary-button compact-button" onClick={() => toggleStatus(batch)} disabled={!canAdjust || batch.status === "depleted"}>{batch.status === "quarantined" ? "Release" : "Quarantine"}</button></footer>
            </article>
          );
        }}
      />

      <BatchFormModal open={formOpen} products={products} busy={busy} onClose={() => setFormOpen(false)} onSubmit={saveBatch} />
      <BatchAdjustmentModal batch={adjusting} busy={busy} onClose={() => setAdjusting(null)} onSubmit={saveAdjustment} />
    </div>
  );
}
