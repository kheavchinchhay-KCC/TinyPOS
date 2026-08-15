import { useState } from "react";
import { Ban, PackageCheck } from "lucide-react";
import Modal from "./Modal";
import { stockNumber } from "../lib/catalog";

export default function TransferActionModal({
  transfer,
  action,
  busy,
  onClose,
  onSubmit
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  if (!transfer) return null;

  const receiving = action === "receive";

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!receiving && text.trim().length < 3) {
      setError("Enter a cancellation reason.");
      return;
    }

    await onSubmit(text);
  }

  return (
    <Modal
      title={receiving ? "Receive stock transfer" : "Cancel stock transfer"}
      onClose={onClose}
    >
      <form className="transfer-action-form" onSubmit={submit}>
        <div className="transfer-action-summary">
          <strong>{transfer.transfer_number}</strong>
          <span>
            {transfer.source_branch?.name} → {transfer.destination_branch?.name}
          </span>
        </div>

        <div className="transfer-action-items">
          {(transfer.stock_transfer_items || []).map((item) => (
            <div key={item.id}>
              <span>{item.products?.name || "Product"}</span>
              <strong>
                {stockNumber(item.quantity)} {item.products?.unit_name || "pcs"}
              </strong>
            </div>
          ))}
        </div>

        <label>
          <span>{receiving ? "Receiving notes" : "Cancellation reason"}</span>
          <textarea
            rows="3"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              receiving
                ? "Optional condition or delivery notes"
                : "Why is this transfer being cancelled?"
            }
          />
        </label>

        {receiving && (
          <div className="notice warning">
            Receiving adds all listed quantities to this destination branch.
          </div>
        )}

        {!receiving && (
          <div className="notice warning">
            {Number(transfer.workflow_version || 1) >= 2
              ? "Cancelling closes this pending transfer. No stock has moved yet, so inventory stays unchanged."
              : "Cancelling restores all in-transit quantities to the source branch."}
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
            Close
          </button>
          <button
            type="submit"
            className={receiving ? "primary-button" : "danger-button"}
            disabled={busy}
          >
            {receiving ? <PackageCheck size={18} /> : <Ban size={18} />}
            {busy
              ? "Saving..."
              : receiving
                ? "Receive transfer"
                : "Cancel transfer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
