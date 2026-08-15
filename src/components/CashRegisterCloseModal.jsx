import { useEffect, useMemo, useState } from "react";
import { LockKeyhole } from "lucide-react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

function expected(summary, currency) {
  return Number(
    summary?.totals?.[currency]?.expected || 0
  );
}

export default function CashRegisterCloseModal({
  summary,
  busy,
  onClose,
  onSubmit
}) {
  const [countedUsd, setCountedUsd] = useState("");
  const [countedKhr, setCountedKhr] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!summary) return;

    setCountedUsd(String(expected(summary, "USD")));
    setCountedKhr(String(expected(summary, "KHR")));
    setNote("");
    setError("");
  }, [summary]);

  const varianceUsd = useMemo(
    () => Number(countedUsd || 0) - expected(summary, "USD"),
    [countedUsd, summary]
  );
  const varianceKhr = useMemo(
    () => Number(countedKhr || 0) - expected(summary, "KHR"),
    [countedKhr, summary]
  );

  if (!summary) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    const usd = Number(countedUsd);
    const khr = Number(countedKhr);

    if (!Number.isFinite(usd) || usd < 0) {
      setError("Counted USD cash must be zero or greater.");
      return;
    }

    if (!Number.isFinite(khr) || khr < 0) {
      setError("Counted KHR cash must be zero or greater.");
      return;
    }

    await onSubmit({
      counted_cash_usd: usd,
      counted_cash_khr: khr,
      closing_note: note
    });
  }

  return (
    <Modal
      title={`Close ${summary.session.session_number}`}
      onClose={() => !busy && onClose()}
    >
      <form className="register-close-form" onSubmit={submit}>
        <div className="register-close-warning">
          <LockKeyhole size={20} />
          <span>
            Count all cash physically inside the drawer. After closing,
            new cash transactions require a new register session.
          </span>
        </div>

        <div className="register-count-grid">
          <section>
            <h3>USD drawer</h3>
            <div>
              <span>Expected</span>
              <strong>{money(expected(summary, "USD"), "USD")}</strong>
            </div>
            <label>
              <span>Counted cash</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={countedUsd}
                onChange={(event) =>
                  setCountedUsd(event.target.value)
                }
                autoFocus
              />
            </label>
            <div
              className={`register-variance ${
                varianceUsd === 0
                  ? "balanced"
                  : varianceUsd > 0
                    ? "over"
                    : "short"
              }`}
            >
              <span>Variance</span>
              <strong>{money(varianceUsd, "USD")}</strong>
            </div>
          </section>

          <section>
            <h3>KHR drawer</h3>
            <div>
              <span>Expected</span>
              <strong>{money(expected(summary, "KHR"), "KHR")}</strong>
            </div>
            <label>
              <span>Counted cash</span>
              <input
                type="number"
                min="0"
                step="1"
                value={countedKhr}
                onChange={(event) =>
                  setCountedKhr(event.target.value)
                }
              />
            </label>
            <div
              className={`register-variance ${
                varianceKhr === 0
                  ? "balanced"
                  : varianceKhr > 0
                    ? "over"
                    : "short"
              }`}
            >
              <span>Variance</span>
              <strong>{money(varianceKhr, "KHR")}</strong>
            </div>
          </section>
        </div>

        <label>
          <span>Closing note</span>
          <textarea
            rows="3"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional explanation for a shortage, overage, handover or deposit"
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
            className="danger-button"
            disabled={busy}
          >
            <LockKeyhole size={18} />
            {busy ? "Closing register..." : "Close register"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
