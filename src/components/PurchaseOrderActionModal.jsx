import { useEffect, useState } from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";
import { purchaseBalance } from "../lib/purchaseOrders";

const methods = ["cash", "bank", "khqr", "card", "other"];

export default function PurchaseOrderActionModal({
  action,
  purchase,
  busy,
  onClose,
  onConfirm
}) {
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [supplierInvoice, setSupplierInvoice] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!purchase || !action) return;
    setAmount(action === "payment" ? purchaseBalance(purchase) : 0);
    setMethod("cash");
    setReference("");
    setSupplierInvoice(purchase.supplier_invoice_number || "");
    setNotes("");
    setReason("");
    setError("");
  }, [purchase, action]);

  if (!purchase || !action) return null;

  const balance = purchaseBalance(purchase);
  const title =
    action === "receive"
      ? `Receive ${purchase.purchase_number}`
      : action === "payment"
        ? `Pay ${purchase.purchase_number}`
        : `Cancel ${purchase.purchase_number}`;

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (action === "cancel") {
      if (reason.trim().length < 3) {
        setError("Enter a cancellation reason.");
        return;
      }
      try {
        await onConfirm({ action, reason });
      } catch (submitError) {
        setError(submitError?.message || "The purchase action failed.");
      }
      return;
    }

    const numericAmount = Number(amount || 0);

    if (action === "payment" && numericAmount <= 0) {
      setError("Enter a payment amount greater than zero.");
      return;
    }

    if (numericAmount < 0 || numericAmount > balance) {
      setError(`Payment must be between 0 and ${money(balance, purchase.currency)}.`);
      return;
    }

    try {
      await onConfirm({
        action,
        amount: numericAmount,
        method,
        reference,
        supplier_invoice_number: supplierInvoice,
        notes
      });
    } catch (submitError) {
      setError(submitError?.message || "The purchase action failed.");
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="po-action-form" onSubmit={submit}>
        <div className="po-action-summary">
          <div><span>Supplier</span><strong>{purchase.suppliers?.name || "—"}</strong></div>
          <div><span>Total</span><strong>{money(purchase.total_amount, purchase.currency)}</strong></div>
          <div><span>Already paid</span><strong>{money(purchase.amount_paid, purchase.currency)}</strong></div>
          <div><span>Balance due</span><strong>{money(balance, purchase.currency)}</strong></div>
        </div>

        {action === "cancel" ? (
          <label>
            <span>Cancellation reason</span>
            <textarea
              rows="4"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this order being cancelled?"
              autoFocus
            />
          </label>
        ) : (
          <>
            <div className="form-grid two">
              <label>
                <span>{action === "receive" ? "Payment now" : "Payment amount"}</span>
                <input
                  type="number"
                  min="0"
                  max={balance}
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  autoFocus
                />
              </label>

              <label>
                <span>Payment method</span>
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  {methods.map((value) => (
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
                  placeholder="Optional"
                />
              </label>

              {action === "receive" && (
                <label>
                  <span>Supplier invoice number</span>
                  <input
                    value={supplierInvoice}
                    onChange={(event) => setSupplierInvoice(event.target.value)}
                    placeholder="Optional"
                  />
                </label>
              )}

              <label className="po-action-wide">
                <span>Notes</span>
                <textarea
                  rows="3"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
            </div>

            {action === "receive" && (
              <div className="notice warning">
                Receiving this order will add every ordered quantity to inventory. This action cannot be repeated.
              </div>
            )}
          </>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            type="submit"
            className={action === "cancel" ? "danger-button" : "primary-button"}
            disabled={busy}
          >
            {busy
              ? "Processing..."
              : action === "receive"
                ? "Receive order"
                : action === "payment"
                  ? "Record payment"
                  : "Cancel order"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
