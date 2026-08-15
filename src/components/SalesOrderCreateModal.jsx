import {
  ClipboardList,
  Truck
} from "lucide-react";
import {
  useEffect,
  useState
} from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

function defaultDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

export default function SalesOrderCreateModal({
  quote,
  busy,
  onClose,
  onSubmit
}) {
  const [deliveryDate, setDeliveryDate] =
    useState(defaultDate());
  const [address, setAddress] =
    useState("");
  const [notes, setNotes] =
    useState("");
  const [error, setError] =
    useState("");

  useEffect(() => {
    if (!quote) return;

    setDeliveryDate(defaultDate());
    setAddress(
      quote.customers?.address || ""
    );
    setNotes(quote.notes || "");
    setError("");
  }, [quote]);

  if (!quote) return null;

  function submit(event) {
    event.preventDefault();
    setError("");

    if (!quote.customer_id) {
      setError(
        "Choose a customer on the quotation before creating a sales order."
      );
      return;
    }

    if (
      deliveryDate
      && deliveryDate
        < new Date().toISOString().slice(0, 10)
    ) {
      setError(
        "Requested delivery date cannot be in the past."
      );
      return;
    }

    onSubmit({
      quote_id: quote.id,
      requested_delivery_date:
        deliveryDate || null,
      delivery_address: address,
      notes
    });
  }

  return (
    <Modal
      title={`Create sales order from ${quote.quote_number}`}
      onClose={() => !busy && onClose()}
    >
      <form
        className="sales-order-create-form"
        onSubmit={submit}
      >
        <section className="sales-order-source-summary">
          <ClipboardList size={23} />
          <div>
            <strong>
              {quote.customers?.name
                || "Customer required"}
            </strong>
            <span>
              {quote.sales_quote_items?.length || 0}
              {" products · "}
              {money(
                quote.total_amount,
                quote.currency
              )}
            </span>
          </div>
        </section>

        <label>
          <span>Requested delivery date</span>
          <input
            type="date"
            value={deliveryDate}
            onChange={(event) =>
              setDeliveryDate(
                event.target.value
              )
            }
          />
        </label>

        <label>
          <span>Delivery address</span>
          <textarea
            rows="3"
            value={address}
            onChange={(event) =>
              setAddress(event.target.value)
            }
            placeholder="Customer delivery address"
          />
        </label>

        <label>
          <span>Order note</span>
          <textarea
            rows="3"
            value={notes}
            onChange={(event) =>
              setNotes(event.target.value)
            }
            placeholder="Optional delivery instructions"
          />
        </label>

        <div className="notice info">
          <Truck size={19} />
          The order starts as Draft. Confirm it from
          Sales Orders when stock is ready to reserve.
        </div>

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
            <ClipboardList size={18} />
            {busy
              ? "Creating sales order..."
              : "Create draft order"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
