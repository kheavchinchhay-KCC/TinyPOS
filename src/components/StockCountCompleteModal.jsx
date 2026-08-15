import {
  AlertTriangle,
  ClipboardCheck
} from "lucide-react";
import {
  useEffect,
  useState
} from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

export default function StockCountCompleteModal({
  session,
  metrics,
  busy,
  onClose,
  onSubmit
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    if (session) setNote("");
  }, [session?.id]);

  if (!session) return null;

  const ready =
    metrics.uncounted === 0;

  return (
    <Modal
      title={`Complete ${session.count_number}`}
      onClose={onClose}
    >
      <form
        className="stock-count-complete-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSubmit(note);
        }}
      >
        <div className="stock-count-complete-warning">
          <AlertTriangle size={21} />
          <span>
            Pause sales, receiving, transfers and
            refunds before completion. Tiny POS
            blocks completion when system stock
            changed after the count started.
          </span>
        </div>

        <div className="stock-count-complete-grid">
          <div>
            <span>Products</span>
            <strong>
              {metrics.total}
            </strong>
          </div>

          <div>
            <span>Uncounted</span>
            <strong>
              {metrics.uncounted}
            </strong>
          </div>

          <div>
            <span>Discrepancies</span>
            <strong>
              {metrics.discrepancies}
            </strong>
          </div>

          <div>
            <span>Shortage items</span>
            <strong>
              {metrics.shortages}
            </strong>
          </div>

          <div>
            <span>Overage items</span>
            <strong>
              {metrics.overages}
            </strong>
          </div>

          <div>
            <span>USD value variance</span>
            <strong>
              {money(
                metrics.valueUsd,
                "USD"
              )}
            </strong>
          </div>

          <div>
            <span>KHR value variance</span>
            <strong>
              {money(
                metrics.valueKhr,
                "KHR"
              )}
            </strong>
          </div>
        </div>

        {!ready && (
          <div className="notice error">
            Count every product before completing
            this session.
          </div>
        )}

        <label>
          <span>Completion note</span>
          <textarea
            rows="3"
            value={note}
            onChange={(event) =>
              setNote(event.target.value)
            }
            placeholder="Optional approval, witness or discrepancy explanation"
          />
        </label>

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            Continue counting
          </button>

          <button
            type="submit"
            className="primary-button"
            disabled={busy || !ready}
          >
            <ClipboardCheck size={18} />
            {busy
              ? "Applying stock count..."
              : metrics.discrepancies > 0
                ? "Complete and adjust stock"
                : "Complete balanced count"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
