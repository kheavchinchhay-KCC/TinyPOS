import { useState } from "react";
import { Trash2 } from "lucide-react";
import Modal from "./Modal";

export default function VoidCashEntryModal({ entry, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  if (!entry) return null;

  async function submit(event) {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError("Enter a reason for deleting this entry.");
      return;
    }
    await onConfirm(reason);
  }

  return (
    <Modal title={`Delete ${entry.entry_number}`} onClose={onClose}>
      <form className="void-cash-form" onSubmit={submit}>
        <div className="notice warning">
          Financial records are not permanently erased. This entry will be voided,
          removed from totals, and preserved in the audit log.
        </div>
        <label>
          <span>Reason</span>
          <textarea
            rows="4"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setError("");
            }}
            placeholder="Why should this entry be removed?"
          />
        </label>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="danger-button" disabled={busy}>
            <Trash2 size={18} />
            {busy ? "Deleting…" : "Delete entry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
