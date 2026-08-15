import {
  Box,
  CheckCircle2,
  LayoutGrid,
  PackageCheck,
  Table2
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import BatchAllocationEditor, { createBatchAllocation } from "./BatchAllocationEditor";
import {
  money,
  stockNumber
} from "../lib/catalog";
import {
  purchaseBalance,
  purchaseItemRemainingQuantity
} from "../lib/purchaseOrders";

const paymentMethods = [
  "cash",
  "bank",
  "khqr",
  "card",
  "other"
];

function localDateTimeValue() {
  const now = new Date();
  const local = new Date(
    now.getTime()
    - now.getTimezoneOffset() * 60000
  );
  return local.toISOString().slice(0, 16);
}

function defaultReceiptView() {
  return globalThis.matchMedia?.("(max-width: 760px)")?.matches
    ? "cards"
    : "table";
}

export default function PurchaseReceiptModal({
  purchase,
  busy,
  onClose,
  onSubmit
}) {
  const [quantities, setQuantities] = useState({});
  const [amountPaid, setAmountPaid] = useState("0");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [supplierInvoice, setSupplierInvoice] = useState("");
  const [receivedAt, setReceivedAt] = useState(localDateTimeValue());
  const [notes, setNotes] = useState("");
  const [batchAllocations, setBatchAllocations] = useState({});
  const [itemViewMode, setItemViewMode] = useState(defaultReceiptView);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!purchase) return;

    setQuantities({});
    setAmountPaid("0");
    setMethod("cash");
    setReference("");
    setSupplierInvoice(purchase.supplier_invoice_number || "");
    setReceivedAt(localDateTimeValue());
    setNotes("");
    setBatchAllocations({});
    setItemViewMode(defaultReceiptView());
    setError("");
  }, [purchase]);

  const rows = useMemo(
    () =>
      (purchase?.purchase_items || [])
        .map((item) => ({
          item,
          remaining: purchaseItemRemainingQuantity(item),
          quantity: Number(quantities[item.id] || 0)
        }))
        .filter((row) => row.remaining > 0),
    [purchase, quantities]
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => row.quantity > 0),
    [rows]
  );

  const receiptValue = useMemo(
    () =>
      selectedRows.reduce(
        (sum, row) =>
          sum
          + row.quantity * Number(row.item.unit_cost || 0),
        0
      ),
    [selectedRows]
  );

  if (!purchase) return null;

  const balance = purchaseBalance(purchase);
  const allRemainingSelected =
    rows.length > 0
    && rows.every(
      (row) =>
        Math.abs(row.quantity - row.remaining) < 0.0005
    );

  function updateQuantity(itemId, value) {
    setQuantities((current) => ({
      ...current,
      [itemId]: value
    }));

    const item = purchase.purchase_items.find((row) => row.id === itemId);
    if (
      item?.products?.batch_tracking
      && Number(value || 0) > 0
      && !(batchAllocations[itemId] || []).length
    ) {
      setBatchAllocations((current) => ({
        ...current,
        [itemId]: [createBatchAllocation(item.products, receivedAt, value)]
      }));
    }

    setError("");
  }

  function updateBatches(itemId, next) {
    setBatchAllocations((current) => ({
      ...current,
      [itemId]: next
    }));
    setError("");
  }

  function receiveAllRemaining() {
    const next = {};
    const nextBatches = {};

    for (const row of rows) {
      next[row.item.id] = String(row.remaining);
      if (row.item.products?.batch_tracking) {
        nextBatches[row.item.id] = [
          createBatchAllocation(
            row.item.products,
            receivedAt,
            row.remaining
          )
        ];
      }
    }

    setQuantities(next);
    setBatchAllocations(nextBatches);
    setError("");
  }

  function clearQuantities() {
    setQuantities({});
    setBatchAllocations({});
    setError("");
  }

  function receiveField(row) {
    const { item, remaining, quantity } = row;
    const factor = Number(item.unit_factor || 1);
    const baseReceipt = quantity * factor;

    return (
      <label className="partial-receipt-quantity-field">
        <span>Receive {item.purchase_unit_name || "quantity"}</span>
        <div className="partial-receipt-quantity-input">
          <input
            type="number"
            min="0"
            max={remaining}
            step="0.001"
            value={quantities[item.id] || ""}
            onChange={(event) => updateQuantity(item.id, event.target.value)}
            placeholder="0"
          />
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => updateQuantity(item.id, String(remaining))}
            disabled={busy}
          >
            Receive remaining
          </button>
        </div>
        <small>
          Adds {stockNumber(baseReceipt)} {item.products?.unit_name || "base units"}
        </small>
      </label>
    );
  }

  function batchEditor(row) {
    return (
      <BatchAllocationEditor
        item={row.item}
        receiptQuantity={row.quantity}
        receivedAt={receivedAt}
        allocations={batchAllocations[row.item.id] || []}
        onChange={(next) => updateBatches(row.item.id, next)}
      />
    );
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (selectedRows.length === 0) {
      setError("Enter a received quantity for at least one product.");
      return;
    }

    for (const row of selectedRows) {
      if (!Number.isFinite(row.quantity) || row.quantity <= 0) {
        setError(`Enter a valid quantity for ${row.item.products?.name || "Product"}.`);
        return;
      }

      if (row.quantity > row.remaining + 0.0005) {
        setError(
          `${row.item.products?.name || "Product"} has only ${stockNumber(
            row.remaining
          )} ${row.item.purchase_unit_name || "units"} remaining.`
        );
        return;
      }
    }

    for (const row of selectedRows) {
      if (!row.item.products?.batch_tracking) continue;

      const batchRows = batchAllocations[row.item.id] || [];
      const batchTotal = batchRows.reduce(
        (sum, batch) => sum + Number(batch.quantity || 0),
        0
      );

      if (
        batchRows.length === 0
        || Math.abs(batchTotal - row.quantity) > 0.0005
      ) {
        setError(
          `Batch quantities for ${row.item.products?.name || "Product"} must total ${stockNumber(row.quantity)} ${row.item.purchase_unit_name}.`
        );
        return;
      }

      for (const batch of batchRows) {
        if (!(Number(batch.quantity) > 0)) {
          setError(`Every batch for ${row.item.products?.name || "Product"} needs a quantity greater than zero.`);
          return;
        }
        if (row.item.products.expiry_tracking && !batch.expiry_date) {
          setError(`Expiry date is required for ${row.item.products?.name || "Product"}.`);
          return;
        }
      }
    }

    const payment = Number(amountPaid || 0);

    if (
      !Number.isFinite(payment)
      || payment < 0
      || payment > balance + 0.005
    ) {
      setError(
        `Payment must be between ${money(0, purchase.currency)} and ${money(balance, purchase.currency)}.`
      );
      return;
    }

    if (!receivedAt) {
      setError("Choose the received date and time.");
      return;
    }

    const parsedDate = new Date(receivedAt);

    if (
      Number.isNaN(parsedDate.getTime())
      || parsedDate > new Date(Date.now() + 5 * 60000)
    ) {
      setError("Received date and time are invalid or in the future.");
      return;
    }

    try {
      await onSubmit({
        purchase_id: purchase.id,
        items: selectedRows.map((row) => ({
          purchase_item_id: row.item.id,
          quantity: row.quantity,
          batches: batchAllocations[row.item.id] || []
        })),
        amount_paid: payment,
        payment_method: method,
        payment_reference: reference,
        supplier_invoice_number: supplierInvoice,
        received_at: parsedDate.toISOString(),
        notes
      });
    } catch (submitError) {
      setError(
        submitError?.message
        || "The purchase receipt could not be saved."
      );
    }
  }

  return (
    <Modal
      title={`Receive ${purchase.purchase_number}`}
      onClose={onClose}
      wide
    >
      <form className="partial-receipt-form" onSubmit={submit}>
        <section className="partial-receipt-summary">
          <div>
            <span>Supplier</span>
            <strong>{purchase.suppliers?.name || "—"}</strong>
          </div>
          <div>
            <span>Order total</span>
            <strong>{money(purchase.total_amount, purchase.currency)}</strong>
          </div>
          <div>
            <span>Balance due</span>
            <strong>{money(balance, purchase.currency)}</strong>
          </div>
          <div>
            <span>Previous receipts</span>
            <strong>{(purchase.purchase_receipts || []).length}</strong>
          </div>
        </section>

        <div className="partial-receipt-toolbar">
          <div>
            <Box size={20} />
            <span>
              Enter quantities using each line&apos;s original purchasing unit.
            </span>
          </div>
          <div>
            <button
              type="button"
              className="secondary-button compact"
              onClick={clearQuantities}
              disabled={busy}
            >
              Clear
            </button>
            <button
              type="button"
              className="secondary-button compact"
              onClick={receiveAllRemaining}
              disabled={busy || rows.length === 0}
            >
              <CheckCircle2 size={17} />
              Receive all remaining
            </button>
          </div>
        </div>

        <div className="po-modal-item-view-header partial-receipt-view-header">
          <div>
            <strong>Items to receive</strong>
            <span>{rows.length} remaining line{rows.length === 1 ? "" : "s"}</span>
          </div>
          <div className="list-view-mode po-modal-view-toggle" role="group" aria-label="Receiving item view">
            <button
              type="button"
              className={itemViewMode === "table" ? "active" : ""}
              onClick={() => setItemViewMode("table")}
            >
              <Table2 size={17} /> Table
            </button>
            <button
              type="button"
              className={itemViewMode === "cards" ? "active" : ""}
              onClick={() => setItemViewMode("cards")}
            >
              <LayoutGrid size={17} /> Cards
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="empty-state compact partial-receipt-empty">
            <PackageCheck size={40} />
            <p>Every purchase-order line is already fully received.</p>
          </div>
        ) : itemViewMode === "table" ? (
          <div className="partial-receipt-table-wrap">
            <table className="partial-receipt-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Ordered / received</th>
                  <th>Cost</th>
                  <th>Receive</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const { item, remaining } = row;
                  const factor = Number(item.unit_factor || 1);
                  return (
                    <Fragment key={item.id}>
                      <tr>
                        <td data-label="Product">
                          <strong>{item.products?.name || "Product"}</strong>
                          <small>
                            1 {item.purchase_unit_name || "unit"} = {stockNumber(factor)} {item.products?.unit_name || "base units"}
                          </small>
                        </td>
                        <td data-label="Ordered / received">
                          <strong>{stockNumber(item.quantity)} {item.purchase_unit_name || "units"}</strong>
                          <small>
                            Received {stockNumber(item.received_quantity)} · Remaining {stockNumber(remaining)}
                          </small>
                        </td>
                        <td data-label="Cost">
                          <strong>{money(item.unit_cost, purchase.currency)}</strong>
                          <small>per {item.purchase_unit_name || "unit"}</small>
                        </td>
                        <td data-label="Receive">{receiveField(row)}</td>
                      </tr>
                      {item.products?.batch_tracking && row.quantity > 0 && (
                        <tr className="partial-receipt-batch-table-row">
                          <td colSpan="4">{batchEditor(row)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="partial-receipt-card-grid">
            {rows.map((row) => {
              const { item, remaining } = row;
              const factor = Number(item.unit_factor || 1);

              return (
                <article className="partial-receipt-card" key={item.id}>
                  <header>
                    <div>
                      <strong>{item.products?.name || "Product"}</strong>
                      <span>
                        Ordered {stockNumber(item.quantity)} {item.purchase_unit_name || "units"}
                        {" · Received "}{stockNumber(item.received_quantity)}
                        {" · Remaining "}{stockNumber(remaining)}
                      </span>
                      <small>
                        1 {item.purchase_unit_name || "unit"} = {stockNumber(factor)} {item.products?.unit_name || "base units"}
                      </small>
                    </div>
                    <div>
                      <span>Cost per purchase unit</span>
                      <strong>{money(item.unit_cost, purchase.currency)}</strong>
                    </div>
                  </header>

                  {receiveField(row)}
                  {batchEditor(row)}
                </article>
              );
            })}
          </div>
        )}

        <section className="partial-receipt-value">
          <span>Goods-received value</span>
          <strong>{money(receiptValue, purchase.currency)}</strong>
          <small>
            {allRemainingSelected
              ? "This receipt will complete the purchase order."
              : "Unreceived quantities remain as backorders."}
          </small>
        </section>

        <div className="form-grid three">
          <label>
            <span>Received date and time</span>
            <input
              type="datetime-local"
              value={receivedAt}
              onChange={(event) => setReceivedAt(event.target.value)}
            />
          </label>

          <label>
            <span>Supplier invoice number</span>
            <input
              value={supplierInvoice}
              onChange={(event) => setSupplierInvoice(event.target.value)}
              placeholder="Optional"
            />
          </label>

          <label>
            <span>Payment now</span>
            <input
              type="number"
              min="0"
              max={balance}
              step="0.01"
              value={amountPaid}
              onChange={(event) => setAmountPaid(event.target.value)}
            />
          </label>

          <label>
            <span>Payment method</span>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              disabled={Number(amountPaid || 0) <= 0}
            >
              {paymentMethods.map((value) => (
                <option value={value} key={value}>
                  {value.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Payment reference</span>
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              disabled={Number(amountPaid || 0) <= 0}
              placeholder="Optional"
            />
          </label>

          <label>
            <span>Receiving note</span>
            <textarea
              rows="3"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Damage, short shipment, batch, delivery note..."
            />
          </label>
        </div>

        {Number(amountPaid || 0) > 0 && method === "cash" && (
          <div className="notice warning">
            A cash supplier payment requires an open Cash Register for this branch.
          </div>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="primary-button"
            disabled={busy || selectedRows.length === 0}
          >
            <PackageCheck size={18} />
            {busy
              ? "Receiving stock..."
              : allRemainingSelected
                ? "Receive and complete order"
                : "Receive partial delivery"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
