import { useMemo, useState } from "react";
import { Camera, Plus, Save, Search, Trash2, UserPlus } from "lucide-react";
import BarcodeScanner from "./BarcodeScanner";
import { exactProductMatch } from "../lib/inventory";
import { money, stockNumber } from "../lib/catalog";

export default function PurchaseReceiveForm({
  products,
  suppliers,
  currency,
  busy,
  onCancel,
  onAddSupplier,
  onSave
}) {
  const availableProducts = useMemo(
    () => products.filter((product) => product.is_active && product.currency === currency),
    [products, currency]
  );
  const [supplierId, setSupplierId] = useState("");
  const [supplierInvoice, setSupplierInvoice] = useState("");
  const [amountPaid, setAmountPaid] = useState("0");
  const [notes, setNotes] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [rows, setRows] = useState([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState("");

  const searchResults = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    if (!needle) return [];
    return availableProducts
      .filter((product) =>
        [product.name, product.name_km, product.sku, product.barcode]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle))
      )
      .slice(0, 8);
  }, [availableProducts, productSearch]);

  const total = useMemo(
    () => rows.reduce(
      (sum, row) => sum + Number(row.quantity || 0) * Number(row.unit_cost || 0),
      0
    ),
    [rows]
  );

  function addProduct(product) {
    setError("");
    setProductSearch("");
    setRows((current) => {
      const existing = current.find((row) => row.product_id === product.id);
      if (existing) {
        return current.map((row) =>
          row.product_id === product.id
            ? { ...row, quantity: String(Number(row.quantity || 0) + 1) }
            : row
        );
      }

      return [
        ...current,
        {
          product_id: product.id,
          product,
          quantity: "1",
          unit_cost: String(product.average_cost || product.default_cost || 0)
        }
      ];
    });
  }

  function updateRow(productId, field, value) {
    setRows((current) => current.map((row) =>
      row.product_id === productId ? { ...row, [field]: value } : row
    ));
  }

  function removeRow(productId) {
    setRows((current) => current.filter((row) => row.product_id !== productId));
  }

  function handleScan(code) {
    setScannerOpen(false);
    const product = exactProductMatch(availableProducts, code);
    if (!product) {
      setError(`No active ${currency} product matches ${code}.`);
      return;
    }
    addProduct(product);
  }

  async function submit(event) {
    event.preventDefault();

    if (rows.length === 0) {
      setError("Add at least one product.");
      return;
    }

    for (const row of rows) {
      if (Number(row.quantity) <= 0) {
        setError(`Enter a valid quantity for ${row.product.name}.`);
        return;
      }
      if (Number(row.unit_cost) < 0) {
        setError(`Enter a valid cost for ${row.product.name}.`);
        return;
      }
    }

    if (Number(amountPaid || 0) < 0 || Number(amountPaid || 0) > total) {
      setError("Amount paid must be between zero and the purchase total.");
      return;
    }

    try {
      await onSave({
        supplier_id: supplierId,
        supplier_invoice_number: supplierInvoice,
        amount_paid: amountPaid,
        currency,
        notes,
        items: rows
      });
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  return (
    <form className="purchase-form" onSubmit={submit}>
      {error && <div className="notice error">{error}</div>}

      <div className="form-grid three">
        <label>
          <span>Supplier</span>
          <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">No supplier</option>
            {suppliers.filter((supplier) => supplier.is_active).map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Supplier invoice number</span>
          <input value={supplierInvoice} onChange={(event) => setSupplierInvoice(event.target.value)} />
        </label>
        <label>
          <span>Currency</span>
          <input value={currency} disabled />
        </label>
      </div>

      <div className="purchase-tools">
        <div className="purchase-search-wrap">
          <label className="search-box">
            <Search size={19} />
            <input
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Search product name, code or barcode"
            />
          </label>
          {searchResults.length > 0 && (
            <div className="purchase-search-results">
              {searchResults.map((product) => (
                <button key={product.id} type="button" onClick={() => addProduct(product)}>
                  <span><strong>{product.name}</strong><small>{product.sku} · {product.barcode || "No barcode"}</small></span>
                  <span>{stockNumber(product.stock_quantity)} {product.unit_name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="secondary-button" onClick={() => setScannerOpen(true)}>
          <Camera size={18} /> Scan
        </button>
        <button type="button" className="secondary-button" onClick={onAddSupplier}>
          <UserPlus size={18} /> New supplier
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="purchase-empty"><Plus size={34} /><p>Search or scan products to add them.</p></div>
      ) : (
        <div className="purchase-lines-wrap">
          <table className="purchase-lines">
            <thead><tr><th>Product</th><th>Current stock</th><th>Quantity</th><th>Unit cost</th><th>Line total</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.product_id}>
                  <td data-label="Product"><strong>{row.product.name}</strong><small>{row.product.sku}</small></td>
                  <td data-label="Current stock">{stockNumber(row.product.stock_quantity)} {row.product.unit_name}</td>
                  <td data-label="Quantity"><input type="number" min="0.001" step="0.001" value={row.quantity} onChange={(event) => updateRow(row.product_id, "quantity", event.target.value)} /></td>
                  <td data-label="Unit cost"><input type="number" min="0" step="0.0001" value={row.unit_cost} onChange={(event) => updateRow(row.product_id, "unit_cost", event.target.value)} /></td>
                  <td data-label="Line total"><strong>{money(Number(row.quantity || 0) * Number(row.unit_cost || 0), currency)}</strong></td>
                  <td><button type="button" className="icon-button danger-icon" onClick={() => removeRow(row.product_id)} title="Remove"><Trash2 size={18} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="purchase-summary">
        <label>
          <span>Amount paid</span>
          <input type="number" min="0" max={total} step="0.01" value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} />
        </label>
        <div><span>Purchase total</span><strong>{money(total, currency)}</strong></div>
        <div><span>Balance due</span><strong>{money(Math.max(total - Number(amountPaid || 0), 0), currency)}</strong></div>
      </div>

      <label>
        <span>Notes</span>
        <textarea rows="2" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || rows.length === 0}>
          <Save size={18} /> {busy ? "Receiving..." : "Receive purchase"}
        </button>
      </div>

      <BarcodeScanner open={scannerOpen} title="Scan purchase product" onClose={() => setScannerOpen(false)} onDetected={handleScan} />
    </form>
  );
}
