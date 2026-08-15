import {
  Camera,
  CheckCircle2,
  Clock3,
  Download,
  PackageCheck,
  Plus,
  Printer,
  RotateCcw,
  Save,
  Search,
  Trash2,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import BarcodeScanner from "./BarcodeScanner";
import ListViewControls from "./ListViewControls";
import { useListViewState } from "../lib/listViewState";
import { stockNumber } from "../lib/catalog";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import { baseProductUnit, findProductUnit, sortedProductUnits } from "../lib/productUnits";
import { loadStockTransferBatchOptions } from "../lib/transfers";

function requestedUnit(item) {
  const product = item.products || {};
  return (
    (product.product_units || []).find((unit) => unit.id === item.requested_product_unit_id)
    || baseProductUnit(product)
    || null
  );
}

function normalizedSavedBatchAllocations(item) {
  return (item.stock_transfer_item_batches || [])
    .filter((row) => !row.destination_batch_id)
    .map((row) => ({
      source_batch_id: row.source_batch_id || "",
      base_quantity: String(Number(row.base_quantity || 0))
    }));
}

function batchAllocationSignature(rows = []) {
  return rows
    .filter((row) => row?.source_batch_id || String(row?.base_quantity ?? "").trim())
    .map((row) => `${row.source_batch_id || ""}:${Number(row.base_quantity || 0).toFixed(3)}`)
    .sort()
    .join("|");
}

function batchSnapshotLabel(row, unitName) {
  if (!row) return "—";
  const parts = [
    row.batch_number || "Batch/Lot",
    `${stockNumber(row.base_quantity || 0)} ${unitName || "pcs"}`
  ];
  if (row.expiry_date) parts.push(`exp ${String(row.expiry_date).slice(0, 10)}`);
  return parts.join(" · ");
}

function initialCountRow(item) {
  const product = item.products || {};
  const unit = (
    (product.product_units || []).find((row) => row.id === item.counted_product_unit_id)
    || requestedUnit(item)
    || baseProductUnit(product)
  );
  return {
    quantity: item.counted_unit_quantity === null || item.counted_unit_quantity === undefined
      ? ""
      : String(item.counted_unit_quantity),
    product_unit_id: unit?.id || "",
    note: item.count_note || "",
    batch_allocations: normalizedSavedBatchAllocations(item)
  };
}

export default function TransferWorkflowModal({
  supabase,
  transfer,
  mode,
  busy,
  onClose,
  onSaveCount,
  onApprove,
  onReopen,
  onCancel
}) {
  const [counts, setCounts] = useState({});
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countFilter, setCountFilter] = useState("all");
  const [reviewing, setReviewing] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [batchOptions, setBatchOptions] = useState([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState("");

  useEffect(() => {
    if (!transfer) return;
    setCounts(Object.fromEntries((transfer.stock_transfer_items || []).map((item) => [item.product_id, initialCountRow(item)])));
    setNotes(mode === "approve" ? transfer.approval_note || "" : transfer.count_notes || "");
    setError("");
    setSearch("");
    setCountFilter("all");
    setReviewing(false);
    setScannerOpen(false);
    setScanMessage("");
    setBatchError("");
  }, [transfer, mode]);

  useEffect(() => {
    let cancelled = false;
    if (!supabase || !transfer?.id || mode !== "count") {
      setBatchOptions([]);
      setBatchLoading(false);
      return undefined;
    }

    const hasBatchItems = (transfer.stock_transfer_items || []).some((item) => item.products?.batch_tracking);
    if (!hasBatchItems) {
      setBatchOptions([]);
      setBatchLoading(false);
      return undefined;
    }

    setBatchLoading(true);
    setBatchError("");
    loadStockTransferBatchOptions(supabase, transfer.id)
      .then((rows) => {
        if (!cancelled) setBatchOptions(rows);
      })
      .catch((loadError) => {
        if (!cancelled) setBatchError(loadError?.message || "Source Batch/Lot options could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setBatchLoading(false);
      });

    return () => { cancelled = true; };
  }, [supabase, transfer, mode]);

  const rows = transfer?.stock_transfer_items || [];

  function rowValues(item) {
    const draft = counts[item.product_id] || initialCountRow(item);
    const product = item.products || {};
    const unit = findProductUnit(product, draft.product_unit_id) || requestedUnit(item) || baseProductUnit(product);
    const unitQuantity = String(draft.quantity ?? "").trim() === "" ? null : Number(draft.quantity);
    const factor = Number(unit?.conversion_factor || 1);
    const countedBase = unitQuantity === null || !Number.isFinite(unitQuantity)
      ? null
      : Number((unitQuantity * factor).toFixed(3));
    const requestedBase = Number(item.quantity || 0);
    const variance = countedBase === null ? null : Number((countedBase - requestedBase).toFixed(3));
    const originalUnitId = item.counted_product_unit_id || requestedUnit(item)?.id || baseProductUnit(product)?.id || "";
    const originalQuantity = item.counted_unit_quantity === null || item.counted_unit_quantity === undefined
      ? ""
      : String(item.counted_unit_quantity);
    const savedBatchSignature = batchAllocationSignature(normalizedSavedBatchAllocations(item));
    const draftBatchSignature = batchAllocationSignature(draft.batch_allocations || []);
    const allocatedBase = (draft.batch_allocations || []).reduce((sum, row) => {
      const value = Number(row.base_quantity);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
    const batchMismatch = product.batch_tracking && countedBase !== null
      ? Math.abs(allocatedBase - countedBase) > 0.0005
      : false;
    const changed = String(draft.quantity ?? "") !== originalQuantity
      || String(unit?.id || "") !== String(originalUnitId || "")
      || String(draft.note || "").trim() !== String(item.count_note || "").trim()
      || savedBatchSignature !== draftBatchSignature;

    return {
      draft,
      product,
      unit,
      unitQuantity,
      factor,
      countedBase,
      requestedBase,
      variance,
      allocatedBase,
      batchMismatch,
      changed
    };
  }

  const totals = useMemo(() => {
    let countedRows = 0;
    let differences = 0;
    let requested = 0;
    let counted = 0;
    let changed = 0;

    for (const item of rows) {
      const values = rowValues(item);
      requested += values.requestedBase;
      if (values.countedBase !== null && Number.isFinite(values.countedBase)) {
        countedRows += 1;
        counted += values.countedBase;
        if (Math.abs(Number(values.variance || 0)) > 0.0005) differences += 1;
      }
      if (values.changed) changed += 1;
    }

    return {
      totalRows: rows.length,
      countedRows,
      uncountedRows: Math.max(0, rows.length - countedRows),
      differences,
      requested,
      counted,
      changed,
      progress: rows.length ? (countedRows / rows.length) * 100 : 0
    };
  // counts intentionally drives all row calculations.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, counts]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((item) => {
      const values = rowValues(item);
      const searchable = [
        values.product.name,
        values.product.name_km,
        values.product.sku,
        values.product.barcode
      ].filter(Boolean).join(" ").toLowerCase();
      const matchesSearch = !needle || searchable.includes(needle);
      const matchesFilter = countFilter === "all"
        || (countFilter === "uncounted" && values.countedBase === null)
        || (countFilter === "counted" && values.countedBase !== null)
        || (countFilter === "difference" && values.variance !== null && Math.abs(values.variance) > 0.0005);
      return matchesSearch && matchesFilter;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, counts, search, countFilter]);

  const listState = useListViewState(filteredRows, `transfer-count-${transfer?.id || "none"}`, 30);

  if (!transfer) return null;

  function updateCount(productId, changes) {
    setCounts((current) => ({
      ...current,
      [productId]: {
        ...(current[productId] || {}),
        ...changes
      }
    }));
    setError("");
  }

  function optionsForItem(item) {
    return batchOptions
      .filter((row) => row.transfer_item_id === item.id || row.product_id === item.product_id)
      .sort((a, b) => Number(a.recommended_order || 0) - Number(b.recommended_order || 0));
  }

  function batchOptionLabel(option, unitName) {
    const parts = [
      option.batch_number || "Batch/Lot",
      `${stockNumber(option.available_quantity)} ${unitName || "pcs"}`
    ];
    if (option.expiry_date) parts.push(`exp ${String(option.expiry_date).slice(0, 10)}`);
    return parts.join(" · ");
  }

  function updateBatchAllocation(productId, index, changes) {
    setCounts((current) => {
      const row = current[productId] || {};
      const allocations = [...(row.batch_allocations || [])];
      allocations[index] = { ...(allocations[index] || {}), ...changes };
      return {
        ...current,
        [productId]: { ...row, batch_allocations: allocations }
      };
    });
    setError("");
  }

  function addBatchAllocation(item) {
    const values = rowValues(item);
    const selected = new Set((values.draft.batch_allocations || []).map((row) => row.source_batch_id).filter(Boolean));
    const next = optionsForItem(item).find((option) => !selected.has(option.source_batch_id));
    if (!next) {
      setError(`No more available Batch/Lot rows for ${values.product.name || "this product"}.`);
      return;
    }
    const remaining = Math.max(0, Number(values.countedBase || 0) - Number(values.allocatedBase || 0));
    setCounts((current) => {
      const row = current[item.product_id] || {};
      return {
        ...current,
        [item.product_id]: {
          ...row,
          batch_allocations: [
            ...(row.batch_allocations || []),
            {
              source_batch_id: next.source_batch_id,
              base_quantity: remaining > 0 ? String(Math.min(remaining, next.available_quantity)) : ""
            }
          ]
        }
      };
    });
    setError("");
  }

  function removeBatchAllocation(productId, index) {
    setCounts((current) => {
      const row = current[productId] || {};
      const allocations = (row.batch_allocations || []).filter((_, rowIndex) => rowIndex !== index);
      return { ...current, [productId]: { ...row, batch_allocations: allocations } };
    });
    setError("");
  }

  function autoAllocateBatches(item) {
    const values = rowValues(item);
    if (values.countedBase === null || values.countedBase <= 0) {
      setError(`Enter the counted quantity for ${values.product.name || "this product"} first.`);
      return;
    }

    let remaining = Number(values.countedBase);
    const allocations = [];
    for (const option of optionsForItem(item)) {
      if (remaining <= 0.0005) break;
      const take = Math.min(remaining, Number(option.available_quantity || 0));
      if (take <= 0) continue;
      allocations.push({
        source_batch_id: option.source_batch_id,
        base_quantity: String(Number(take.toFixed(3)))
      });
      remaining = Number((remaining - take).toFixed(3));
    }

    if (remaining > 0.0005) {
      setError(`Source batches do not currently contain enough stock for ${values.product.name || "this product"}.`);
      return;
    }

    setCounts((current) => ({
      ...current,
      [item.product_id]: {
        ...(current[item.product_id] || {}),
        batch_allocations: allocations
      }
    }));
    setError("");
  }

  function batchAllocationSummary(item, useDraft = true) {
    const product = item.products || {};
    const allocations = useDraft
      ? rowValues(item).draft.batch_allocations || []
      : (item.stock_transfer_item_batches || []).map((row) => ({
          source_batch_id: row.source_batch_id,
          base_quantity: row.base_quantity,
          batch_number: row.batch_number,
          expiry_date: row.expiry_date
        }));

    if (!product.batch_tracking) return "—";
    if (!allocations.length) return "Not allocated";

    return allocations.map((allocation) => {
      const option = optionsForItem(item).find((row) => row.source_batch_id === allocation.source_batch_id);
      const saved = (item.stock_transfer_item_batches || []).find((row) => row.source_batch_id === allocation.source_batch_id);
      const batch = option || saved || allocation;
      return batchSnapshotLabel({
        ...batch,
        base_quantity: allocation.base_quantity
      }, product.unit_name);
    }).join(" / ");
  }

  function renderBatchAllocationEditor(item, values) {
    if (!values.product.batch_tracking) return <span className="transfer-batch-not-required">—</span>;

    const options = optionsForItem(item);
    const allocations = values.draft.batch_allocations || [];
    const selectedIds = new Set(allocations.map((row) => row.source_batch_id).filter(Boolean));
    const policy = String(values.product.picking_policy || options[0]?.picking_policy || "fifo").toUpperCase();

    return (
      <div className={`transfer-batch-editor ${values.batchMismatch ? "mismatch" : ""}`}>
        <div className="transfer-batch-editor-head">
          <span>Batch / lot allocation</span>
          <div>
            <button type="button" className="secondary-button transfer-batch-auto" onClick={() => autoAllocateBatches(item)} disabled={busy || batchLoading || options.length === 0}>Auto {policy}</button>
            <button type="button" className="icon-button transfer-batch-add" onClick={() => addBatchAllocation(item)} disabled={busy || batchLoading || options.length === 0} title="Add another Batch/Lot"><Plus size={16} /></button>
          </div>
        </div>

        {batchLoading && <small className="transfer-batch-message">Loading source batches…</small>}
        {!batchLoading && options.length === 0 && allocations.length === 0 && <small className="transfer-batch-message warning">No active source Batch/Lot is available.</small>}

        <div className="transfer-batch-allocation-list">
          {allocations.map((allocation, index) => {
            const currentOption = options.find((option) => option.source_batch_id === allocation.source_batch_id);
            const savedOption = (item.stock_transfer_item_batches || []).find((row) => row.source_batch_id === allocation.source_batch_id);
            return (
              <div className="transfer-batch-allocation-row" key={`${item.product_id}-${index}`}>
                <select
                  value={allocation.source_batch_id || ""}
                  onChange={(event) => updateBatchAllocation(item.product_id, index, { source_batch_id: event.target.value })}
                  disabled={busy}
                  aria-label={`Batch or lot for ${values.product.name || "product"}`}
                >
                  <option value="">Choose Batch/Lot</option>
                  {savedOption && !currentOption && (
                    <option value={savedOption.source_batch_id}>
                      {savedOption.batch_number || "Saved lot"} · unavailable now
                    </option>
                  )}
                  {options.map((option) => (
                    <option
                      value={option.source_batch_id}
                      key={option.source_batch_id}
                      disabled={selectedIds.has(option.source_batch_id) && option.source_batch_id !== allocation.source_batch_id}
                    >
                      {batchOptionLabel(option, values.product.unit_name)}
                    </option>
                  ))}
                </select>
                <div className="transfer-batch-qty">
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    inputMode="decimal"
                    value={allocation.base_quantity ?? ""}
                    onChange={(event) => updateBatchAllocation(item.product_id, index, { base_quantity: event.target.value })}
                    disabled={busy}
                    placeholder="0"
                    aria-label={`Base quantity for Batch/Lot ${index + 1}`}
                  />
                  <span>{values.product.unit_name || "pcs"}</span>
                </div>
                <button type="button" className="icon-button danger-icon" onClick={() => removeBatchAllocation(item.product_id, index)} disabled={busy} title="Remove Batch/Lot"><Trash2 size={16} /></button>
              </div>
            );
          })}
        </div>

        <div className="transfer-batch-allocation-total">
          <span>Allocated</span>
          <strong>{stockNumber(values.allocatedBase)} / {values.countedBase === null ? "—" : stockNumber(values.countedBase)} {values.product.unit_name || "pcs"}</strong>
        </div>
        {values.batchMismatch && <small className="transfer-batch-message warning">Allocation must equal the counted base quantity before Review & submit.</small>}
      </div>
    );
  }

  function preparedItems(requireAll) {
    const prepared = rows.map((item) => {
      const values = rowValues(item);
      if (values.unitQuantity !== null && (!Number.isFinite(values.unitQuantity) || values.unitQuantity < 0)) {
        throw new Error(`Enter a valid counted quantity for ${values.product.name || "every product"}.`);
      }
      if (requireAll && values.unitQuantity === null) {
        throw new Error("Count every product before submitting for approval.");
      }

      const allocations = (values.draft.batch_allocations || [])
        .filter((row) => row.source_batch_id || String(row.base_quantity ?? "").trim())
        .map((row) => ({
          source_batch_id: row.source_batch_id || "",
          base_quantity: Number(row.base_quantity)
        }));

      if (values.product.batch_tracking) {
        const seen = new Set();
        for (const allocation of allocations) {
          if (!allocation.source_batch_id || !Number.isFinite(allocation.base_quantity) || allocation.base_quantity <= 0) {
            throw new Error(`Choose a valid Batch/Lot and quantity for ${values.product.name || "every batch product"}.`);
          }
          if (seen.has(allocation.source_batch_id)) {
            throw new Error(`Do not select the same Batch/Lot twice for ${values.product.name || "this product"}.`);
          }
          seen.add(allocation.source_batch_id);
          const option = optionsForItem(item).find((row) => row.source_batch_id === allocation.source_batch_id);
          if (option && allocation.base_quantity > Number(option.available_quantity || 0) + 0.0005) {
            throw new Error(`${option.batch_number || "Selected batch"} has only ${stockNumber(option.available_quantity)} ${values.product.unit_name || "pcs"} available.`);
          }
        }
        if (requireAll && values.countedBase !== null && Math.abs(values.allocatedBase - values.countedBase) > 0.0005) {
          throw new Error(`Batch/Lot allocation for ${values.product.name || "this product"} must equal the counted base quantity.`);
        }
      }

      return {
        product_id: item.product_id,
        product_unit_id: values.unit?.id || null,
        counted_unit_quantity: values.unitQuantity,
        batch_allocations: values.product.batch_tracking ? allocations : [],
        note: values.draft.note || ""
      };
    });
    return prepared;
  }

  function transferScanMatch(code) {
    const needle = String(code || "").trim().toLowerCase();
    if (!needle) return null;

    for (const item of rows) {
      const product = item.products || {};
      const unit = sortedProductUnits(product).find(
        (row) => String(row.barcode || "").trim().toLowerCase() === needle
      );
      if (unit) return { item, product, unit };

      if (
        String(product.sku || "").trim().toLowerCase() === needle
        || String(product.barcode || "").trim().toLowerCase() === needle
      ) {
        return { item, product, unit: baseProductUnit(product) };
      }
    }
    return null;
  }

  async function handleScan(code) {
    const match = transferScanMatch(code);
    if (!match) {
      const text = `No transfer product or package matches ${code}.`;
      setScanMessage(text);
      throw new Error(text);
    }

    const current = rowValues(match.item);
    const scannedFactor = Number(match.unit?.conversion_factor || 1);
    const currentBase = current.countedBase === null ? 0 : Number(current.countedBase || 0);
    const nextBase = Number((currentBase + scannedFactor).toFixed(3));
    const nextUnitQuantity = Number((nextBase / Math.max(scannedFactor, 0.001)).toFixed(3));

    updateCount(match.item.product_id, {
      product_unit_id: match.unit?.id || "",
      quantity: String(nextUnitQuantity)
    });
    setScanMessage(`${match.product.name || "Product"} · +1 ${match.unit?.short_name || match.unit?.name || match.product.unit_name || "unit"}`);
    return true;
  }

  function transferCountDocumentRows() {
    return filteredRows.map((item) => ({ item, values: rowValues(item) }));
  }

  function transferCountDocumentColumns() {
    return [
      { label: "Product", width: 190, value: (row) => row.values.product.name || "Product" },
      { label: "Code", width: 105, value: (row) => row.values.product.sku || row.values.product.barcode || "—" },
      { label: "Requested", width: 120, value: (row) => requestedLabel(row.item) },
      { label: "Counted", width: 120, value: (row) => row.values.unitQuantity === null ? "Not counted" : `${stockNumber(row.values.unitQuantity)} ${row.values.unit?.short_name || row.values.unit?.name || row.values.product.unit_name || "pcs"}` },
      { label: "Batch / lot", width: 210, value: (row) => batchAllocationSummary(row.item, true) },
      { label: "Base count", width: 110, value: (row) => row.values.countedBase === null ? "—" : `${stockNumber(row.values.countedBase)} ${row.values.product.unit_name || "pcs"}` },
      { label: "Variance", width: 95, value: (row) => row.values.variance === null ? "—" : `${row.values.variance > 0 ? "+" : ""}${stockNumber(row.values.variance)}` },
      { label: "Note", width: 190, value: (row) => row.values.draft.note || "—" }
    ];
  }

  function exportCount() {
    exportListExcel({
      filename: `${transfer.transfer_number}-count.xls`,
      title: `${transfer.transfer_number} · Transfer count`,
      subtitle: `${transfer.source_branch?.name || "Source"} → ${transfer.destination_branch?.name || "Destination"}`,
      summary: [
        { label: "Products", value: totals.totalRows },
        { label: "Counted", value: `${totals.countedRows}/${totals.totalRows}` },
        { label: "Requested base units", value: stockNumber(totals.requested) },
        { label: "Counted base units", value: stockNumber(totals.counted) }
      ],
      columns: transferCountDocumentColumns(),
      rows: transferCountDocumentRows()
    });
  }

  function printCount() {
    printListDocument({
      title: `${transfer.transfer_number} · Transfer count`,
      subtitle: `${transfer.source_branch?.name || "Source"} → ${transfer.destination_branch?.name || "Destination"}`,
      summary: [
        { label: "Products", value: totals.totalRows },
        { label: "Counted", value: `${totals.countedRows}/${totals.totalRows}` },
        { label: "Requested base units", value: stockNumber(totals.requested) },
        { label: "Counted base units", value: stockNumber(totals.counted) }
      ],
      columns: transferCountDocumentColumns(),
      rows: transferCountDocumentRows(),
      orientation: "landscape"
    });
  }

  async function cancelTransfer() {
    if (!onCancel) return;
    setError("");
    try {
      await onCancel(transfer);
    } catch (cancelError) {
      setError(cancelError?.message || "The transfer could not be cancelled.");
    }
  }

  async function savePending() {
    setError("");
    try {
      if (totals.changed === 0) {
        setError("Enter or change at least one count first.");
        return;
      }
      await onSaveCount({
        transfer_id: transfer.id,
        items: preparedItems(false),
        notes,
        submit: false
      });
    } catch (saveError) {
      setError(saveError?.message || "The transfer count could not be saved.");
    }
  }

  function openReview() {
    setError("");
    try {
      preparedItems(true);
      setReviewing(true);
    } catch (reviewError) {
      setError(reviewError?.message || "Count every product before reviewing.");
    }
  }

  async function submitCount() {
    setError("");
    try {
      await onSaveCount({
        transfer_id: transfer.id,
        items: preparedItems(true),
        notes,
        submit: true
      });
    } catch (saveError) {
      setError(saveError?.message || "The transfer count could not be submitted.");
    }
  }

  async function approve() {
    setError("");
    try {
      await onApprove(transfer.id, notes);
    } catch (approveError) {
      setError(approveError?.message || "The transfer could not be approved.");
    }
  }

  async function reopen() {
    setError("");
    try {
      await onReopen(transfer.id, notes);
    } catch (reopenError) {
      setError(reopenError?.message || "The transfer could not be returned to counting.");
    }
  }

  function requestedLabel(item) {
    return `${stockNumber(item.requested_unit_quantity ?? item.quantity)} ${item.requested_unit_name || item.products?.unit_name || "pcs"}`;
  }

  function renderCountRow(item, asCard = false) {
    const values = rowValues(item);
    const units = sortedProductUnits(values.product);
    const tone = values.variance === null
      ? ""
      : Math.abs(values.variance) <= 0.0005
        ? "stock-count-balanced"
        : values.variance > 0
          ? "stock-count-over"
          : "stock-count-short";

    if (asCard) {
      return (
        <article className={`responsive-data-card transfer-count-card ${tone}`} key={item.id || item.product_id}>
          <header>
            <div><strong>{values.product.name || "Product"}</strong><small>{values.product.sku || values.product.barcode || "No code"}</small></div>
            <span className={`status-pill ${values.changed ? "pending" : "active"}`}>{values.changed ? "Unsaved" : "Saved"}</span>
          </header>
          <div className="transfer-count-card-requested"><span>Requested</span><strong>{requestedLabel(item)}</strong><small>{stockNumber(values.requestedBase)} {values.product.unit_name || "pcs"} base</small></div>
          <div className="transfer-count-entry-grid">
            <label><span>Counted</span><input type="number" min="0" step="0.001" value={values.draft.quantity ?? ""} onChange={(event) => updateCount(item.product_id, { quantity: event.target.value })} inputMode="decimal" disabled={busy} placeholder="Not counted" /></label>
            <label><span>Unit</span><select value={values.unit?.id || ""} onChange={(event) => updateCount(item.product_id, { product_unit_id: event.target.value })} disabled={busy}>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.short_name || unit.name}</option>)}</select></label>
          </div>
          {values.product.batch_tracking && renderBatchAllocationEditor(item, values)}
          <div className="transfer-count-card-results">
            <div><span>Base count</span><strong>{values.countedBase === null ? "—" : `${stockNumber(values.countedBase)} ${values.product.unit_name || "pcs"}`}</strong></div>
            <div><span>Variance</span><strong>{values.variance === null ? "—" : `${values.variance > 0 ? "+" : ""}${stockNumber(values.variance)}`}</strong></div>
          </div>
          <label><span>Note</span><input value={values.draft.note || ""} onChange={(event) => updateCount(item.product_id, { note: event.target.value })} disabled={busy} placeholder="Optional item note" /></label>
        </article>
      );
    }

    return (
      <tr className={tone} key={item.id || item.product_id}>
        <td data-label="Product"><strong>{values.product.name || "Product"}</strong><small>{values.product.sku || values.product.barcode || "No code"}</small></td>
        <td data-label="Requested"><strong>{requestedLabel(item)}</strong><small>{stockNumber(values.requestedBase)} {values.product.unit_name || "pcs"} base</small></td>
        <td data-label="Counted"><input className="transfer-count-input" type="number" min="0" step="0.001" value={values.draft.quantity ?? ""} onChange={(event) => updateCount(item.product_id, { quantity: event.target.value })} inputMode="decimal" disabled={busy} placeholder="Not counted" /></td>
        <td data-label="Unit"><select className="transfer-count-unit" value={values.unit?.id || ""} onChange={(event) => updateCount(item.product_id, { product_unit_id: event.target.value })} disabled={busy}>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.short_name || unit.name}</option>)}</select></td>
        <td data-label="Batch / lot">{renderBatchAllocationEditor(item, values)}</td>
        <td data-label="Base count">{values.countedBase === null ? "—" : `${stockNumber(values.countedBase)} ${values.product.unit_name || "pcs"}`}</td>
        <td data-label="Variance">{values.variance === null ? "—" : <strong>{values.variance > 0 ? "+" : ""}{stockNumber(values.variance)}</strong>}</td>
        <td data-label="Note"><input className="transfer-count-note" value={values.draft.note || ""} onChange={(event) => updateCount(item.product_id, { note: event.target.value })} disabled={busy} placeholder="Optional item note" /></td>
      </tr>
    );
  }

  function renderReadOnlyTable(useDraft = false) {
    return (
      <div className="responsive-wide-table-wrap transfer-product-detail-wrap">
        <table className="responsive-wide-table transfer-product-detail-table">
          <thead><tr><th>Product</th><th>Requested</th><th>Counted</th><th>Batch / lot</th><th>Base received</th><th>Variance</th><th>Note</th></tr></thead>
          <tbody>
            {rows.map((item) => {
              const product = item.products || {};
              const draftValues = rowValues(item);
              const counted = useDraft
                ? draftValues.countedBase
                : item.counted_quantity === null || item.counted_quantity === undefined ? null : Number(item.counted_quantity);
              const variance = counted === null ? null : counted - Number(item.quantity || 0);
              const countedLabel = useDraft
                ? draftValues.unitQuantity === null
                  ? "Not counted"
                  : `${stockNumber(draftValues.unitQuantity)} ${draftValues.unit?.short_name || draftValues.unit?.name || product.unit_name || "pcs"}`
                : item.counted_unit_quantity === null || item.counted_unit_quantity === undefined
                  ? "Not counted"
                  : `${stockNumber(item.counted_unit_quantity)} ${item.counted_unit_name || product.unit_name || "pcs"}`;
              return (
                <tr key={item.id || item.product_id}>
                  <td><strong>{product.name || "Product"}</strong><small>{product.sku || product.barcode || "No code"}</small></td>
                  <td>{requestedLabel(item)}</td>
                  <td>{countedLabel}</td>
                  <td>{batchAllocationSummary(item, useDraft)}</td>
                  <td>{counted === null ? "—" : `${stockNumber(counted)} ${product.unit_name || "pcs"}`}</td>
                  <td>{variance === null ? "—" : `${variance > 0 ? "+" : ""}${stockNumber(variance)}`}</td>
                  <td>{item.count_note || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (mode === "count" && reviewing) {
    return (
      <Modal title={`Review & submit ${transfer.transfer_number}`} onClose={() => setReviewing(false)} wide>
        <div className="transfer-count-review">
          <div className="stock-count-complete-grid">
            <div><span>Products</span><strong>{totals.totalRows}</strong></div>
            <div><span>Counted</span><strong>{totals.countedRows}</strong></div>
            <div><span>Differences</span><strong>{totals.differences}</strong></div>
            <div><span>Requested base units</span><strong>{stockNumber(totals.requested)}</strong></div>
            <div><span>Counted base units</span><strong>{stockNumber(totals.counted)}</strong></div>
            <div><span>Approval</span><strong>Required next</strong></div>
          </div>
          <div className="notice warning"><PackageCheck size={18} /> Submitting the count does not move stock yet. An authorized user must press Approve before source stock is deducted and destination stock is added.</div>
          {renderReadOnlyTable(true)}
          <label><span>Counting / delivery note</span><textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional transfer count note" /></label>
          {error && <div className="notice error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setReviewing(false)} disabled={busy}>Continue counting</button>
            <button type="button" className="primary-button" onClick={submitCount} disabled={busy}><CheckCircle2 size={18} />{busy ? "Submitting..." : "Submit count"}</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={mode === "view" ? transfer.transfer_number : mode === "approve" ? `Approve ${transfer.transfer_number}` : `${transfer.transfer_number} · Transfer count`}
      onClose={onClose}
      wide={mode !== "view"}
      className={mode === "count" ? "stock-count-dialog transfer-count-dialog" : ""}
      bodyClassName={mode === "count" ? "stock-count-dialog-body transfer-count-dialog-body" : ""}
    >
      <div className={`transfer-workflow-modal ${mode === "count" ? "transfer-count-workspace" : ""}`}>
        {mode === "count" && (
          <>
            <div className="stock-count-workspace-actions" data-print-hide>
              <button type="button" className="secondary-button" onClick={() => setScannerOpen(true)} disabled={busy}><Camera size={18} />Scan product</button>
              <button type="button" className="primary-button" onClick={savePending} disabled={busy || totals.changed === 0}><Save size={18} />{busy ? "Saving..." : `Save all counts (${totals.changed})`}</button>
              <button type="button" className="secondary-button" onClick={openReview} disabled={busy}><CheckCircle2 size={18} />Review & submit</button>
              <button type="button" className="secondary-button" onClick={exportCount} disabled={busy}><Download size={18} />Export Excel</button>
              <button type="button" className="secondary-button" onClick={printCount} disabled={busy}><Printer size={18} />Print count</button>
              <button type="button" className="danger-button" onClick={cancelTransfer} disabled={busy || !onCancel}><XCircle size={18} />Cancel transfer</button>
            </div>

            <div className="stock-count-progress-panel panel-like">
              <div><span>Count progress</span><strong>{totals.countedRows} / {totals.totalRows}</strong></div>
              <div className="stock-count-progress-track"><div style={{ width: `${totals.progress}%` }} /></div>
              <b>{Math.round(totals.progress)}%</b>
            </div>

            <div className="stock-count-metrics transfer-count-metrics">
              <article><CheckCircle2 size={21} /><span>Counted</span><strong>{totals.countedRows}</strong><small>{totals.uncountedRows} uncounted</small></article>
              <article><PackageCheck size={21} /><span>Differences</span><strong>{totals.differences}</strong><small>Compared with requested base quantity</small></article>
              <article><Clock3 size={21} /><span>Requested units</span><strong>{stockNumber(totals.requested)}</strong><small>Base units</small></article>
              <article><PackageCheck size={21} /><span>Counted units</span><strong>{stockNumber(totals.counted)}</strong><small>Base units</small></article>
            </div>

            <section className="stock-count-toolbar panel-like transfer-count-toolbar">
              <div className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product, code or barcode" /></div>
              <select value={countFilter} onChange={(event) => setCountFilter(event.target.value)}>
                <option value="all">All transfer items</option>
                <option value="uncounted">Uncounted</option>
                <option value="counted">Counted</option>
                <option value="difference">Has difference</option>
              </select>
            </section>

            <ListViewControls
              viewMode={listState.viewMode}
              onViewModeChange={listState.setViewMode}
              pageSize={listState.pageSize}
              onPageSizeChange={listState.setPageSize}
              totalRows={listState.totalRows}
              currentPage={listState.currentPage}
              totalPages={listState.totalPages}
              onPageChange={listState.setCurrentPage}
              className="stock-count-list-controls transfer-count-list-controls"
            />

            <section className="stock-count-table-panel panel-like transfer-count-table-panel">
              {filteredRows.length === 0 ? (
                <div className="empty-state"><PackageCheck size={44} /><h2>No matching transfer items</h2><p>Change the search or count filter.</p></div>
              ) : listState.viewMode === "table" ? (
                <div className="stock-count-table-wrap responsive-wide-table-wrap">
                  <table className="stock-count-table responsive-wide-table transfer-count-table">
                    <thead><tr><th>Product</th><th>Requested</th><th>Counted</th><th>Unit</th><th>Batch / lot</th><th>Base count</th><th>Variance</th><th>Note</th></tr></thead>
                    <tbody>{listState.pageRows.map((item) => renderCountRow(item))}</tbody>
                  </table>
                </div>
              ) : (
                <div className="responsive-data-card-grid stock-count-card-grid transfer-count-card-grid">
                  {listState.pageRows.map((item) => renderCountRow(item, true))}
                </div>
              )}
            </section>

            <label><span>Counting / delivery note</span><textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional transfer count note" /></label>
            {batchError && <div className="notice error" onClick={() => setBatchError("")}>{batchError}</div>}
            {scanMessage && <div className="notice success" onClick={() => setScanMessage("")}>{scanMessage}</div>}
            <div className="notice info"><Clock3 size={18} /> Save all counts keeps this transfer open. For batch-tracked products, choose the exact source Batch/Lot allocation (or use Auto FIFO/FEFO). Review & submit requires allocated lots to equal the counted base quantity. Stock still moves only after final approval.</div>
            <BarcodeScanner
              open={scannerOpen}
              title="Scan product or package for transfer count"
              onClose={() => setScannerOpen(false)}
              onDetected={handleScan}
              continuous
            />
          </>
        )}

        {mode !== "count" && (
          <>
            <section className="transfer-workflow-summary">
              <div><span>From</span><strong>{transfer.source_branch?.name || "Source"}</strong></div>
              <div><span>To</span><strong>{transfer.destination_branch?.name || "Destination"}</strong></div>
              <div><span>Status</span><strong>{transfer.display_status || transfer.status}</strong></div>
              <div><span>Base units</span><strong>{stockNumber(totals.requested)} requested · {stockNumber((rows || []).reduce((sum, item) => sum + Number(item.counted_quantity || 0), 0))} counted</strong></div>
            </section>
            {renderReadOnlyTable(false)}
          </>
        )}

        {mode === "approve" && (
          <>
            <label><span>Approval note</span><textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional approval note" disabled={busy} /></label>
            <div className="notice warning"><PackageCheck size={18} /> Approving applies the counted base quantity and exact saved Batch/Lot allocation. The same lot number and expiry move to the destination; an existing matching destination lot is merged instead of duplicated.</div>
          </>
        )}

        {error && <div className="notice error">{error}</div>}

        {mode !== "count" && (
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Close</button>
            {mode === "approve" && <>
              <button type="button" className="secondary-button" onClick={reopen} disabled={busy}><RotateCcw size={18} />Return to counting</button>
              <button type="button" className="primary-button" onClick={approve} disabled={busy}><PackageCheck size={18} />{busy ? "Approving..." : "Approve"}</button>
            </>}
          </div>
        )}
      </div>
    </Modal>
  );
}
