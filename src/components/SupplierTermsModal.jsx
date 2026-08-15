import {
  CalendarClock,
  Save
} from "lucide-react";
import {
  useEffect,
  useState
} from "react";
import Modal from "./Modal";

export default function SupplierTermsModal({
  supplier,
  canAllBranches,
  busy,
  onClose,
  onSave
}) {
  const [days, setDays] = useState("0");
  const [applyOpen, setApplyOpen] =
    useState(false);
  const [applyAll, setApplyAll] =
    useState(false);
  const [error, setError] =
    useState("");

  useEffect(() => {
    if (!supplier) return;

    setDays(
      String(
        supplier
          .default_payment_terms_days
        || 0
      )
    );
    setApplyOpen(false);
    setApplyAll(false);
    setError("");
  }, [supplier]);

  if (!supplier) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    const value = Number(days);

    if (
      !Number.isInteger(value)
      || value < 0
      || value > 3650
    ) {
      setError(
        "Payment terms must be a whole number from 0 to 3650 days."
      );
      return;
    }

    await onSave({
      supplier_id: supplier.supplier_id,
      default_payment_terms_days:
        value,
      apply_to_open_purchases:
        applyOpen,
      apply_all_branches:
        applyOpen && applyAll
    });
  }

  return (
    <Modal
      title={`Payment terms · ${supplier.name}`}
      onClose={() => !busy && onClose()}
    >
      <form
        className="supplier-terms-form"
        onSubmit={submit}
      >
        <section className="supplier-terms-summary">
          <CalendarClock size={23} />
          <div>
            <strong>
              Default supplier due date
            </strong>
            <span>
              New received purchases use the
              received date plus these payment
              terms.
            </span>
          </div>
        </section>

        <label>
          <span>Default payment terms</span>
          <div className="input-with-suffix">
            <input
              type="number"
              min="0"
              max="3650"
              step="1"
              value={days}
              onChange={(event) =>
                setDays(event.target.value)
              }
              autoFocus
            />
            <span>days</span>
          </div>
          <small>
            Use 0 for payment due on receipt.
          </small>
        </label>

        <label className="check-row">
          <input
            type="checkbox"
            checked={applyOpen}
            onChange={(event) => {
              setApplyOpen(
                event.target.checked
              );

              if (!event.target.checked) {
                setApplyAll(false);
              }
            }}
          />
          <span>
            Recalculate due dates for current
            unpaid purchases
          </span>
        </label>

        {canAllBranches && applyOpen && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(event) =>
                setApplyAll(
                  event.target.checked
                )
              }
            />
            <span>
              Apply to this supplier across all
              branches
            </span>
          </label>
        )}

        {applyOpen && (
          <div className="notice warning">
            Existing unpaid purchases will use
            their received date plus the new
            payment terms.
          </div>
        )}

        {error && (
          <div className="notice error">
            {error}
          </div>
        )}

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
            disabled={busy}
          >
            <Save size={18} />
            {busy
              ? "Saving terms..."
              : "Save payment terms"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
