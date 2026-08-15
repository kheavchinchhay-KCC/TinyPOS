import {
  FileCheck2,
  Send
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

function defaultValidUntil() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 10);
}

export default function QuoteSaveModal({
  open,
  busy,
  activeQuote,
  customerName,
  cart,
  totals,
  currency,
  appliedCoupon,
  notes,
  onClose,
  onSubmit
}) {
  const [validUntil, setValidUntil] =
    useState(defaultValidUntil());
  const [terms, setTerms] = useState("");
  const [status, setStatus] =
    useState("draft");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;

    setValidUntil(
      activeQuote?.valid_until
      || defaultValidUntil()
    );

    setTerms(
      activeQuote?.terms
      || "Prices are valid until the date shown. Stock is not reserved until payment is completed."
    );

    setStatus(
      activeQuote?.status === "sent"
        ? "sent"
        : "draft"
    );

    setError("");
  }, [open, activeQuote]);

  const itemCount = useMemo(
    () =>
      cart.reduce(
        (sum, item) =>
          sum + Number(item.quantity || 0),
        0
      ),
    [cart]
  );

  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (cart.length === 0) {
      setError(
        "Add at least one product."
      );
      return;
    }

    if (
      validUntil
      && validUntil
        < new Date().toISOString().slice(0, 10)
    ) {
      setError(
        "Validity date cannot be in the past."
      );
      return;
    }

    try {
      await onSubmit({
        valid_until: validUntil,
        terms,
        status
      });
    } catch (submitError) {
      setError(submitError?.message || "Unable to save quotation.");
    }
  }

  return (
    <Modal
      title={
        activeQuote
          ? `Update ${activeQuote.quote_number}`
          : "Save quotation"
      }
      onClose={() => !busy && onClose()}
    >
      <form
        className="quote-save-form"
        onSubmit={submit}
      >
        <section className="quote-save-summary">
          <div>
            <span>Customer</span>
            <strong>
              {customerName || "Walk-in customer"}
            </strong>
          </div>

          <div>
            <span>Items</span>
            <strong>
              {itemCount.toLocaleString("en-US")}
            </strong>
          </div>

          <div>
            <span>Total</span>
            <strong>
              {money(totals.total, currency)}
            </strong>
          </div>
        </section>

        {appliedCoupon && (
          <div className="notice success">
            Coupon {appliedCoupon.code} will be
            validated again when the quotation is
            saved and when it is converted to a sale.
          </div>
        )}

        <div className="form-grid two">
          <label>
            <span>Valid until</span>
            <input
              type="date"
              value={validUntil}
              onChange={(event) =>
                setValidUntil(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Save as</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value)
              }
            >
              <option value="draft">
                Draft
              </option>
              <option value="sent">
                Sent to customer
              </option>
            </select>
          </label>
        </div>

        <label>
          <span>Terms and conditions</span>
          <textarea
            rows="5"
            value={terms}
            onChange={(event) =>
              setTerms(event.target.value)
            }
          />
        </label>

        {notes && (
          <div className="quote-save-note-preview">
            <strong>Quotation note</strong>
            <span>{notes}</span>
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
            {status === "sent"
              ? <Send size={18} />
              : <FileCheck2 size={18} />}
            {busy
              ? "Saving quotation..."
              : activeQuote
                ? "Update quotation"
                : "Save quotation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
