import { useEffect, useState } from "react";
import { Gift, MinusCircle, PlusCircle } from "lucide-react";
import Modal from "./Modal";

export default function LoyaltyAdjustModal({
  customer,
  busy,
  onClose,
  onSubmit
}) {
  const [mode, setMode] = useState("add");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!customer) return;
    setMode("add");
    setPoints("");
    setReason("");
    setError("");
  }, [customer]);

  if (!customer) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    const amount = Number(points);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter points greater than zero.");
      return;
    }

    const change = mode === "remove" ? -amount : amount;
    if (Number(customer.loyalty_points || 0) + change < 0) {
      setError("This change would make loyalty points negative.");
      return;
    }

    if (reason.trim().length < 3) {
      setError("Enter a reason for this points adjustment.");
      return;
    }

    await onSubmit({
      customer_id: customer.id,
      points_change: change,
      reason
    });
  }

  return (
    <Modal title="Adjust loyalty points" onClose={onClose}>
      <form className="loyalty-form" onSubmit={submit}>
        <div className="loyalty-customer-summary">
          <Gift size={24} />
          <div>
            <strong>{customer.name}</strong>
            <span>
              Current balance: {Number(customer.loyalty_points || 0).toLocaleString("en-US")} points
            </span>
          </div>
        </div>

        <div className="loyalty-mode-buttons">
          <button
            type="button"
            className={mode === "add" ? "active" : ""}
            onClick={() => setMode("add")}
          >
            <PlusCircle size={18} />
            Add points
          </button>
          <button
            type="button"
            className={mode === "remove" ? "active remove" : ""}
            onClick={() => setMode("remove")}
          >
            <MinusCircle size={18} />
            Remove points
          </button>
        </div>

        <label>
          <span>Points</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={points}
            onChange={(event) => setPoints(event.target.value)}
            autoFocus
          />
        </label>

        <label>
          <span>Reason</span>
          <textarea
            rows="3"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Example: Promotion reward or correction"
          />
        </label>

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
            className={mode === "remove" ? "danger-button" : "primary-button"}
            disabled={busy}
          >
            {busy ? "Saving..." : "Save points adjustment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
