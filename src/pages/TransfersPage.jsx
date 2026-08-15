import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Ban,
  CheckCircle2,
  Eye,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Truck
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import TransferFormModal from "../components/TransferFormModal";
import TransferActionModal from "../components/TransferActionModal";
import TransferWorkflowModal from "../components/TransferWorkflowModal";
import SupplierReturnModal from "../components/SupplierReturnModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import DateRangePresetFields from "../components/DateRangePresetFields";
import { money, stockNumber } from "../lib/catalog";
import {
  approveStockTransfer,
  cancelStockTransfer,
  createStockTransfer,
  dateTime,
  loadTransferWorkspace,
  processSupplierReturn,
  receiveStockTransfer,
  reopenStockTransferCount,
  saveStockTransferCount,
  updateStockTransfer
} from "../lib/transfers";

function localDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Phnom_Penh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function statusClass(status) {
  const value = String(status || "").toLowerCase();
  if (["approved", "received"].includes(value)) return "active";
  if (value === "cancelled") return "inactive";
  return "warning";
}

export default function TransfersPage() {
  const { supabase, profile, can, canAny } = useAuth();
  const canCreate = can("transfers.create");
  const canEdit = can("transfers.edit");
  const canCount = canAny(["transfers.count", "transfers.receive"]);
  const canApprove = canAny(["transfers.approve", "approvals.review"]);
  const canCancel = can("transfers.cancel");
  const canAllBranches = can("branches.all");
  const canManage = canAny([
    "transfers.create", "transfers.receive", "transfers.cancel",
    "transfers.edit", "transfers.count", "transfers.approve", "approvals.review"
  ]);

  const today = localDate();
  const [tab, setTab] = useState("transfers");
  const [branches, setBranches] = useState([]);
  const [products, setProducts] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [supplierReturns, setSupplierReturns] = useState([]);
  const [transferMetrics, setTransferMetrics] = useState({});
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [branchFilter, setBranchFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [newTransferOpen, setNewTransferOpen] = useState(false);
  const [editingTransfer, setEditingTransfer] = useState(null);
  const [transferAction, setTransferAction] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [supplierReturnOpen, setSupplierReturnOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) return;
    try {
      setLoading(true);
      const data = await loadTransferWorkspace(supabase, profile, { allBranches: canAllBranches });
      setBranches(data.branches);
      setProducts(data.products);
      setTransfers(data.transfers);
      setPurchases(data.purchases);
      setSupplierReturns(data.supplierReturns);
      setTransferMetrics(data.transferMetrics || {});
      return data;
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, canAllBranches]);

  useEffect(() => { refresh(); }, [refresh]);

  function directionForTransfer(transfer) {
    const referenceBranchId = branchFilter !== "all" ? branchFilter : profile?.branch_id;
    if (!referenceBranchId) return "—";
    if (transfer.destination_branch_id === referenceBranchId) return "IN";
    if (transfer.source_branch_id === referenceBranchId) return "OUT";
    return "—";
  }

  const visibleTransfers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return transfers.filter((transfer) => {
      const day = localDate(new Date(transfer.created_at));
      const branchMatches = branchFilter === "all"
        || transfer.source_branch_id === branchFilter
        || transfer.destination_branch_id === branchFilter;
      const searchable = [
        transfer.transfer_number,
        transfer.source_branch?.name,
        transfer.destination_branch?.name,
        transfer.notes,
        transfer.count_notes,
        transfer.approval_note,
        ...(transfer.stock_transfer_items || []).flatMap((item) => [item.products?.name, item.products?.sku, item.products?.barcode])
      ].filter(Boolean).join(" ").toLowerCase();
      const statusValue = transfer.status === "pending" ? transfer.count_status || "pending" : transfer.status;
      const direction = directionForTransfer(transfer).toLowerCase();
      const statusMatches = status === "all"
        || (status === "in" && direction === "in")
        || (status === "out" && direction === "out")
        || statusValue === status;
      return day >= dateFrom && day <= dateTo
        && branchMatches
        && (!needle || searchable.includes(needle))
        && statusMatches;
    });
  }, [transfers, search, status, dateFrom, dateTo, branchFilter, profile?.branch_id]);

  const visibleSupplierReturns = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return supplierReturns.filter((row) => !needle || [row.return_number, row.purchases?.purchase_number, row.suppliers?.name, row.reason].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [supplierReturns, search]);

  const metrics = useMemo(() => ({
    pendingOutgoing: Number(transferMetrics.outgoing_pending || 0),
    pendingIncoming: Number(transferMetrics.waiting_to_count || 0),
    awaitingApproval: Number(transferMetrics.waiting_approval || 0),
    inTransitUnits: Number(transferMetrics.requested_units || 0),
    supplierReturnValue: supplierReturns.reduce((sum, row) => sum + Number(row.total_amount || 0), 0)
  }), [transferMetrics, supplierReturns]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function saveTransfer(values) {
    try {
      setBusy(true);
      const result = values.transfer_id
        ? await updateStockTransfer(supabase, values)
        : await createStockTransfer(supabase, values);
      setNewTransferOpen(false);
      setEditingTransfer(null);
      announce("success", `${result.transfer_number} saved as a pending branch transfer.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveTransferAction(text) {
    if (!transferAction) return;
    try {
      setBusy(true);
      const result = transferAction.action === "receive"
        ? await receiveStockTransfer(supabase, transferAction.transfer.id, text)
        : await cancelStockTransfer(supabase, transferAction.transfer, text);
      setTransferAction(null);
      announce("success", `${result.transfer_number} ${result.status === "received" ? "received" : "cancelled"}.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveCount(values) {
    setBusy(true);
    try {
      const result = await saveStockTransferCount(supabase, values);
      announce("success", values.submit ? `${result.transfer_number} submitted for approval.` : `${result.transfer_number} counts saved.`);
      const data = await refresh();
      if (values.submit) {
        setWorkflow(null);
      } else {
        const refreshed = data?.transfers?.find((row) => row.id === values.transfer_id);
        if (refreshed) setWorkflow({ transfer: refreshed, mode: "count" });
      }
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function approveTransfer(transferId, note) {
    setBusy(true);
    try {
      const result = await approveStockTransfer(supabase, transferId, note);
      setWorkflow(null);
      announce("success", `${result.transfer_number} approved. Source and destination stock were updated.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function reopenCount(transferId, note) {
    setBusy(true);
    try {
      const result = await reopenStockTransferCount(supabase, transferId, note);
      setWorkflow(null);
      announce("success", `${result.transfer_number} returned to pending count.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function cancelWorkflowTransfer(transfer) {
    const reason = window.prompt(`Enter a cancellation reason for ${transfer.transfer_number}:`);
    if (reason === null) return null;
    if (reason.trim().length < 3) throw new Error("A cancellation reason is required.");

    setBusy(true);
    try {
      const result = await cancelStockTransfer(supabase, transfer, reason);
      setWorkflow(null);
      announce("success", `${result.transfer_number} cancelled. No stock was moved for this workflow transfer.`);
      await refresh();
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function saveSupplierReturn(values) {
    try {
      setBusy(true);
      const result = await processSupplierReturn(supabase, values);
      setSupplierReturnOpen(false);
      announce("success", `${result.return_number} completed for ${money(result.total_amount, result.currency)}.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return <section className="panel empty-state"><ArrowLeftRight size={46} /><h2>Transfer access is restricted</h2><p>Your role does not include stock-transfer permissions.</p></section>;
  }

  const columns = [
    { label: "Transfer", width: 180, documentValue: (row) => row.transfer_number, render: (row) => <><strong>{row.transfer_number}</strong><small>{dateTime(row.created_at)}</small></> },
    { label: "From", width: 150, value: (row) => row.source_branch?.name || "Source" },
    { label: "To", width: 150, value: (row) => row.destination_branch?.name || "Destination" },
    { label: "IN / OUT", width: 82, documentValue: (row) => directionForTransfer(row), render: (row) => { const direction = directionForTransfer(row); return <span className={`transfer-direction-pill ${direction === "IN" ? "in" : direction === "OUT" ? "out" : "neutral"}`}>{direction}</span>; } },
    { label: "Items", width: 80, value: (row) => (row.stock_transfer_items || []).length },
    { label: "Requested", width: 110, value: (row) => stockNumber((row.stock_transfer_items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)) },
    { label: "Counted", width: 110, value: (row) => stockNumber((row.stock_transfer_items || []).reduce((sum, item) => sum + Number(item.counted_quantity || 0), 0)) },
    { label: "Status", width: 130, documentValue: (row) => row.display_status, render: (row) => <span className={`status-pill ${statusClass(row.status === "pending" ? row.count_status : row.status)}`}>{row.display_status}</span> },
    { label: "Notes", width: 220, value: (row) => row.approval_note || row.count_notes || row.receive_notes || row.cancel_reason || row.notes || "—" },
    { label: "Actions", actionsOnly: true, excludeDocument: true, render: (row) => <TransferButtons row={row} /> }
  ];

  function TransferButtons({ row }) {
    const workflow2 = Number(row.workflow_version || 1) >= 2;
    const source = row.source_branch_id === profile.branch_id;
    const destination = row.destination_branch_id === profile.branch_id;
    const endpoint = source || destination || canAllBranches;
    const editable = workflow2 && row.status === "pending" && ["pending", "not_started"].includes(row.count_status) && endpoint && canEdit;
    const countable = workflow2 && row.status === "pending" && ["pending", "not_started", "counting"].includes(row.count_status) && endpoint && canCount;
    const approvable = workflow2 && row.status === "pending" && row.count_status === "awaiting_approval" && endpoint && canApprove;
    const legacyReceive = !workflow2 && row.status === "pending" && destination && canCount;
    const cancellable = row.status === "pending" && (workflow2 ? endpoint : source) && canCancel;
    return (
      <div className="transfer-card-actions">
        <button type="button" className="secondary-button compact-button" onClick={() => setWorkflow({ transfer: row, mode: "view" })}><Eye size={17} />View</button>
        {editable && <button type="button" className="secondary-button compact-button" onClick={() => setEditingTransfer(row)}><Pencil size={17} />Edit</button>}
        {countable && <button type="button" className="primary-button compact-button" onClick={() => setWorkflow({ transfer: row, mode: "count" })}><PackageCheck size={17} />Count</button>}
        {approvable && <button type="button" className="primary-button compact-button" onClick={() => setWorkflow({ transfer: row, mode: "approve" })}><CheckCircle2 size={17} />Approve</button>}
        {legacyReceive && <button type="button" className="primary-button compact-button" onClick={() => setTransferAction({ transfer: row, action: "receive" })}><PackageCheck size={17} />Receive</button>}
        {cancellable && <button type="button" className="secondary-button compact-button" onClick={() => setTransferAction({ transfer: row, action: "cancel" })}><Ban size={17} />Cancel</button>}
      </div>
    );
  }

  return (
    <div className="page-stack transfers-page">
      <div className="page-heading">
        <div><p className="eyebrow">MULTI-BRANCH INVENTORY</p><h1>Stock Transfers</h1><p className="muted">Create, count and approve branch transfers without changing stock before final approval.</p></div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={18} className={loading ? "spin" : ""} />Refresh</button>
          {canCreate && <button type="button" className="primary-button" onClick={() => setNewTransferOpen(true)} disabled={branches.length < 2}><Plus size={18} />New transfer</button>}
        </div>
      </div>

      {message && <div className={`notice ${messageType}`} onClick={() => setMessage("")}>{message}</div>}

      <div className="transfer-metrics">
        <article><Truck size={21} /><span>Outgoing pending</span><strong>{metrics.pendingOutgoing}</strong></article>
        <article><PackageCheck size={21} /><span>Waiting to count</span><strong>{metrics.pendingIncoming}</strong></article>
        <article><CheckCircle2 size={21} /><span>Waiting approval</span><strong>{metrics.awaitingApproval}</strong></article>
        <article><ArrowLeftRight size={21} /><span>Requested units</span><strong>{stockNumber(metrics.inTransitUnits)}</strong></article>
      </div>

      <div className="transfer-tabs">
        <button type="button" className={tab === "transfers" ? "active" : ""} onClick={() => setTab("transfers")}><ArrowLeftRight size={18} />Branch transfers <span>{visibleTransfers.length}</span></button>
        <button type="button" className={tab === "supplier" ? "active" : ""} onClick={() => setTab("supplier")}><RotateCcw size={18} />Supplier returns <span>{visibleSupplierReturns.length}</span></button>
      </div>

      <section className="panel transfer-toolbar transfer-filter-grid">
        <label className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === "transfers" ? "Search transfer, branch or note" : "Search return, purchase or supplier"} /></label>
        {tab === "transfers" && <>
          <DateRangePresetFields
            from={dateFrom}
            to={dateTo}
            onChange={(range) => {
              setDateFrom(range.from);
              setDateTo(range.to);
            }}
          />
          <label><span>Branch transfer</span><select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}><option value="all">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="in">IN</option><option value="out">OUT</option><option value="pending">Pending</option><option value="counting">Counting</option><option value="awaiting_approval">Awaiting approval</option><option value="received">Approved / received</option><option value="cancelled">Cancelled</option></select></label>
        </>}
      </section>

      {tab === "transfers" ? (
        <ResponsiveDataList
          storageKey="stock-transfers-workflow"
          title="Branch transfer list"
          subtitle={`${dateFrom} to ${dateTo} · ${branchFilter === "all" ? "All branches" : branches.find((row) => row.id === branchFilter)?.name || "Branch"}`}
          rows={visibleTransfers}
          filename={`tiny-pos-stock-transfers-${dateFrom}-${dateTo}.xls`}
          summary={[
            { label: "Date range", value: `${dateFrom} to ${dateTo}` },
            { label: "Branch", value: branchFilter === "all" ? "All branches" : branches.find((row) => row.id === branchFilter)?.name || "Branch" },
            { label: "Waiting approval", value: metrics.awaitingApproval }
          ]}
          emptyTitle={loading ? "Loading transfers..." : "No matching stock transfers"}
          emptyText="Create a transfer or change the current filters."
          columns={columns}
          renderCard={(row) => (
            <article className="responsive-data-card transfer-card compact-transfer-card">
              <header><div><strong>{row.transfer_number}</strong><small>{dateTime(row.created_at)}</small></div><div className="transfer-card-statuses"><span className={`transfer-direction-pill ${directionForTransfer(row) === "IN" ? "in" : directionForTransfer(row) === "OUT" ? "out" : "neutral"}`}>{directionForTransfer(row)}</span><span className={`status-pill ${statusClass(row.status === "pending" ? row.count_status : row.status)}`}>{row.display_status}</span></div></header>
              <div className="transfer-route"><div><span>From</span><strong>{row.source_branch?.name || "Source"}</strong></div><ArrowLeftRight size={20} /><div><span>To</span><strong>{row.destination_branch?.name || "Destination"}</strong></div></div>
              <div className="responsive-card-field-list transfer-count-summary">
                <div><span>Products</span><strong>{(row.stock_transfer_items || []).length}</strong></div>
                <div><span>Requested</span><strong>{stockNumber((row.stock_transfer_items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0))}</strong></div>
                <div><span>Counted</span><strong>{stockNumber((row.stock_transfer_items || []).reduce((sum, item) => sum + Number(item.counted_quantity || 0), 0))}</strong></div>
              </div>
              {(row.approval_note || row.count_notes || row.notes) && <p>{row.approval_note || row.count_notes || row.notes}</p>}
              <footer><TransferButtons row={row} /></footer>
            </article>
          )}
        />
      ) : (
        <section className="panel supplier-return-history">
          {visibleSupplierReturns.length === 0 ? <div className="empty-state"><RotateCcw size={46} /><h2>No supplier returns</h2></div> : (
            <div className="supplier-return-table-wrap"><table className="supplier-return-table"><thead><tr><th>Return</th><th>Purchase</th><th>Supplier</th><th>Date</th><th>Value</th></tr></thead><tbody>{visibleSupplierReturns.map((row) => <tr key={row.id}><td><strong>{row.return_number}</strong><small>{row.reason}</small></td><td>{row.purchases?.purchase_number || "—"}</td><td>{row.suppliers?.name || "No supplier"}</td><td>{dateTime(row.created_at)}</td><td><strong>{money(row.total_amount, row.currency)}</strong></td></tr>)}</tbody></table></div>
          )}
        </section>
      )}

      {(newTransferOpen || editingTransfer) && <TransferFormModal transfer={editingTransfer} branches={branches} products={products} currentBranchId={profile.branch_id} canAllBranches={canAllBranches} busy={busy} onClose={() => { setNewTransferOpen(false); setEditingTransfer(null); }} onSubmit={saveTransfer} />}
      <TransferActionModal transfer={transferAction?.transfer} action={transferAction?.action} busy={busy} onClose={() => setTransferAction(null)} onSubmit={saveTransferAction} />
      <TransferWorkflowModal supabase={supabase} transfer={workflow?.transfer} mode={workflow?.mode} busy={busy} onClose={() => setWorkflow(null)} onSaveCount={saveCount} onApprove={approveTransfer} onReopen={reopenCount} onCancel={canCancel ? cancelWorkflowTransfer : null} />
      {supplierReturnOpen && <SupplierReturnModal purchases={purchases} products={products} busy={busy} onClose={() => setSupplierReturnOpen(false)} onSubmit={saveSupplierReturn} />}
    </div>
  );
}
