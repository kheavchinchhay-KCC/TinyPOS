import { ArrowLeftRight, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { stockNumber } from "../lib/catalog";
import { baseProductUnit, findProductUnit, sortedProductUnits } from "../lib/productUnits";

function emptyItem() {
  return { product_id: "", product_unit_id: "", quantity: 1 };
}

function branchStock(product, branchId) {
  if (!product || !branchId) return 0;
  return Number(product.stock_by_branch?.[branchId]?.quantity || 0);
}

export default function TransferFormModal({
  transfer = null,
  branches,
  products,
  currentBranchId,
  canAllBranches = false,
  busy,
  onClose,
  onSubmit
}) {
  const [sourceBranchId, setSourceBranchId] = useState(currentBranchId || "");
  const [destinationBranchId, setDestinationBranchId] = useState("");
  const [items, setItems] = useState([emptyItem()]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  useEffect(() => {
    if (transfer) {
      setSourceBranchId(transfer.source_branch_id || currentBranchId || "");
      setDestinationBranchId(transfer.destination_branch_id || "");
      const existingItems = (transfer.stock_transfer_items || []).map((item) => ({
        product_id: item.product_id,
        product_unit_id: item.requested_product_unit_id || "",
        quantity: Number(item.requested_unit_quantity ?? item.quantity ?? 0)
      }));
      setItems(existingItems.length ? existingItems : [emptyItem()]);
      setNotes(transfer.notes || "");
    } else {
      setSourceBranchId(currentBranchId || "");
      setDestinationBranchId("");
      setItems([emptyItem()]);
      setNotes("");
    }
    setError("");
    setProductSearch("");
    setCategoryFilter("all");
  }, [transfer, currentBranchId]);

  const branchMap = useMemo(
    () => new Map((branches || []).map((branch) => [branch.id, branch])),
    [branches]
  );

  const categories = useMemo(() => {
    const map = new Map();
    for (const product of products || []) {
      const category = product.categories?.name || product.category_name || "Uncategorized";
      const categoryId = product.category_id || category;
      if (!map.has(categoryId)) map.set(categoryId, { id: categoryId, name: category });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  const filteredProductOptions = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    return (products || []).filter((product) => {
      const categoryId = product.category_id || product.categories?.id || product.category_name || product.categories?.name || "Uncategorized";
      if (categoryFilter !== "all" && String(categoryId) !== String(categoryFilter)) return false;
      if (!needle) return true;
      return [product.name, product.name_km, product.sku, product.barcode]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    }).slice(0, 30);
  }, [products, productSearch, categoryFilter]);

  function updateItem(index, changes) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item));
    setError("");
  }

  function addProduct(productId) {
    const product = products.find((row) => row.id === productId);
    if (!product) return;
    const existingIndex = items.findIndex((item) => item.product_id === productId);
    if (existingIndex >= 0) {
      updateItem(existingIndex, { quantity: Number(items[existingIndex].quantity || 0) + 1 });
    } else {
      const baseUnit = baseProductUnit(product);
      setItems((current) => {
        const hasBlank = current.length === 1 && !current[0].product_id;
        const next = hasBlank ? [] : [...current];
        next.push({ product_id: productId, product_unit_id: baseUnit?.id || "", quantity: 1 });
        return next;
      });
    }
    setProductSearch("");
    setError("");
  }

  function removeItem(index) {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function changeSource(nextSource) {
    setSourceBranchId(nextSource);
    if (nextSource && nextSource === destinationBranchId) {
      setDestinationBranchId(nextSource !== currentBranchId ? currentBranchId || "" : "");
    } else if (!canAllBranches && nextSource && nextSource !== currentBranchId && destinationBranchId !== currentBranchId) {
      setDestinationBranchId(currentBranchId || "");
    }
    setError("");
  }

  function changeDestination(nextDestination) {
    setDestinationBranchId(nextDestination);
    if (nextDestination && nextDestination === sourceBranchId) {
      setSourceBranchId(nextDestination !== currentBranchId ? currentBranchId || "" : "");
    } else if (!canAllBranches && nextDestination && nextDestination !== currentBranchId && sourceBranchId !== currentBranchId) {
      setSourceBranchId(currentBranchId || "");
    }
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!sourceBranchId || !destinationBranchId) {
      setError("Choose both From and To branches.");
      return;
    }
    if (sourceBranchId === destinationBranchId) {
      setError("From and To branches must be different.");
      return;
    }
    if (!canAllBranches && sourceBranchId !== currentBranchId && destinationBranchId !== currentBranchId) {
      setError("Your current branch must be either From or To for this transfer.");
      return;
    }

    const prepared = items
      .filter((item) => item.product_id)
      .map((item) => ({
        product_id: item.product_id,
        product_unit_id: item.product_unit_id || null,
        quantity: Number(item.quantity)
      }));

    if (prepared.length === 0) {
      setError("Add at least one product.");
      return;
    }

    const seen = new Set();
    const normalizedItems = [];
    for (const item of prepared) {
      const product = products.find((row) => row.id === item.product_id);
      if (!product) {
        setError("One selected product no longer exists.");
        return;
      }
      if (seen.has(item.product_id)) {
        setError(`${product.name} was selected more than once.`);
        return;
      }
      seen.add(item.product_id);
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        setError(`Enter a valid quantity for ${product.name}.`);
        return;
      }
      const unit = findProductUnit(product, item.product_unit_id);
      if (!unit) {
        setError(`Choose a valid unit for ${product.name}.`);
        return;
      }
      normalizedItems.push({
        product_id: item.product_id,
        product_unit_id: unit.id || null,
        quantity: item.quantity
      });
    }

    await onSubmit({
      transfer_id: transfer?.id || null,
      source_branch_id: sourceBranchId,
      destination_branch_id: destinationBranchId,
      items: normalizedItems,
      notes
    });
  }

  return (
    <Modal title={transfer ? `Edit ${transfer.transfer_number}` : "Create stock transfer"} onClose={onClose} wide>
      <form className="transfer-form" onSubmit={submit}>
        <div className="transfer-branch-route-fields">
          <label>
            <span>From</span>
            <select value={sourceBranchId} onChange={(event) => changeSource(event.target.value)}>
              <option value="">Choose source branch</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>)}
            </select>
          </label>
          <ArrowLeftRight size={22} aria-hidden="true" />
          <label>
            <span>To</span>
            <select value={destinationBranchId} onChange={(event) => changeDestination(event.target.value)}>
              <option value="">Choose destination branch</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>)}
            </select>
          </label>
        </div>

        <div className="transfer-request-note">
          <strong>{branchMap.get(sourceBranchId)?.name || "Source branch"} → {branchMap.get(destinationBranchId)?.name || "Destination branch"}</strong>
          <span>A transfer can be requested even when the source does not currently have the full requested quantity. The actual amount is confirmed in Count before approval.</span>
        </div>

        <div className="transfer-product-search-row">
          <div className="transfer-product-search">
            <span>Search product</span>
            <label className="search-box">
              <Search size={18} />
              <input
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && filteredProductOptions.length === 1) {
                    event.preventDefault();
                    addProduct(filteredProductOptions[0].id);
                  }
                }}
                placeholder="Product name, code or barcode · type or scan"
                autoComplete="off"
                inputMode="search"
              />
              {productSearch.trim() && filteredProductOptions.length > 0 && (
                <div className="transfer-product-search-results">
                  {filteredProductOptions.map((product) => (
                    <button type="button" className="transfer-product-search-option" key={product.id} onClick={() => addProduct(product.id)}>
                      <div>
                        <strong>{product.name}</strong>
                        {product.name_km && <small>{product.name_km}</small>}
                        <small>{product.sku || "No code"}{product.barcode ? ` · ${product.barcode}` : ""}</small>
                      </div>
                      <span>{stockNumber(branchStock(product, sourceBranchId))} {product.unit_name || "pcs"}</span>
                    </button>
                  ))}
                </div>
              )}
            </label>
          </div>
          <label className="transfer-category-filter">
            <span>Category</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">All categories</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
        </div>

        <div className="transfer-item-list">
          {items.length === 0 ? (
            <div className="empty-state compact-empty-state">Search and select products above.</div>
          ) : items.map((item, index) => {
            const selected = products.find((product) => product.id === item.product_id);
            const units = sortedProductUnits(selected);
            const selectedUnit = findProductUnit(selected, item.product_unit_id);
            const availableBase = branchStock(selected, sourceBranchId);
            const requestedBase = Number(item.quantity || 0) * Number(selectedUnit?.conversion_factor || 1);
            return (
              <div className="transfer-selected-item-row" key={`${item.product_id}-${index}`}>
                <div className="transfer-selected-item-main">
                  <strong>{index + 1} {selected?.name || "Product"}</strong>
                  <small>{selected?.sku || "No code"}{selected?.barcode ? ` · ${selected.barcode}` : ""} · Available {stockNumber(availableBase)} {selected?.unit_name || "pcs"}</small>
                  {selected && requestedBase > availableBase && <small className="transfer-stock-warning">Requested base quantity {stockNumber(requestedBase)} exceeds available stock.</small>}
                </div>
                <label className="transfer-selected-item-qty">
                  <span>Quantity</span>
                  <input type="number" min="0.001" step="0.001" value={item.quantity} onChange={(event) => updateItem(index, { quantity: event.target.value })} inputMode="decimal" />
                </label>
                <label className="transfer-selected-item-unit">
                  <span>Unit</span>
                  <select value={selectedUnit?.id || ""} onChange={(event) => updateItem(index, { product_unit_id: event.target.value })} disabled={!selected}>
                    {units.length === 0 && <option value="">{selected?.unit_name || "Base"}</option>}
                    {units.map((unit) => <option value={unit.id} key={unit.id}>{unit.short_name || unit.name}</option>)}
                  </select>
                </label>
                <button type="button" className="icon-button danger-icon" onClick={() => removeItem(index)} title="Remove product">
                  <X size={19} />
                </button>
              </div>
            );
          })}
        </div>

        <label>
          <span>Transfer notes</span>
          <textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional packing, delivery, request, or handling notes" />
        </label>

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Saving transfer..." : transfer ? "Save transfer" : "Create pending transfer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
