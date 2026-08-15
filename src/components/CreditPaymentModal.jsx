import {
  Banknote,
  Building2,
  CreditCard,
  HandCoins,
  QrCode,
  Wallet
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

const methods = [
  ["cash", "Cash", Banknote],
  ["bank", "Bank", Building2],
  ["khqr", "KHQR", QrCode],
  ["card", "Card", CreditCard],
  ["other", "Other", Wallet]
];

export default function CreditPaymentModal({
  account,
  cashRegisterOpen,
  busy,
  onClose,
  onSubmit
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!account) return;

    setAmount(String(account.balance_due || 0));
    setMethod(cashRegisterOpen ? "cash" : "bank");
    setReference("");
    setNotes("");
    setError("");
  }, [account, cashRegisterOpen]);

  const remaining = useMemo(
    () => Math.max(
      0,
      Number(account?.balance_due || 0)
        - Number(amount || 0)
    ),
    [account, amount]
  );

  if (!account) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    const value = Number(amount);

    if (!Number.isFinite(value) || value <= 0) {
      setError(
        "Payment amount must be greater than zero."
      );
      return;
    }

    if (value > Number(account.balance_due || 0)) {
      setError(
        `Payment cannot exceed ${money(
          account.balance_due,
          account.currency
        )}.`
      );
      return;
    }

    if (method === "cash" && !cashRegisterOpen) {
      setError(
        "Open the cash register before receiving cash."
      );
      return;
    }

    await onSubmit({
      account_id: account.id,
      amount: value,
      method,
      reference_number: reference,
      notes
    });
  }

  return (
    <Modal
      title={`Receive payment · ${account.customer?.name}`}
      onClose={onClose}
    >
      <form
        className="credit-payment-form"
        onSubmit={submit}
      >
        <section className="credit-payment-balance-card">
          <HandCoins size={25} />
          <div>
            <span>Current account balance</span>
            <strong>
              {money(
                account.balance_due,
                account.currency
              )}
            </strong>
            <small>
              {account.customer?.customer_code}
              {" · "}
              {account.currency}
            </small>
          </div>
        </section>

        <label>
          <span>Payment amount</span>
          <input
            type="number"
            min="0.01"
            max={account.balance_due}
            step={
              account.currency === "KHR"
                ? "1"
                : "0.01"
            }
            value={amount}
            onChange={(event) =>
              setAmount(event.target.value)
            }
            autoFocus
          />
        </label>

        <div className="credit-payment-shortcuts">
          {[0.25, 0.5, 1].map((ratio) => {
            const value = Number(
              (
                Number(account.balance_due || 0)
                * ratio
              ).toFixed(
                account.currency === "KHR"
                  ? 0
                  : 2
              )
            );

            return (
              <button
                type="button"
                key={ratio}
                onClick={() =>
                  setAmount(String(value))
                }
              >
                {ratio === 1
                  ? "Full balance"
                  : `${ratio * 100}%`}
              </button>
            );
          })}
        </div>

        {!cashRegisterOpen && (
          <div className="notice warning">
            Cash is disabled because this branch
            has no open cash register.
          </div>
        )}

        <div className="payment-method-grid credit-payment-methods">
          {methods.map(([value, label, Icon]) => (
            <button
              type="button"
              key={value}
              className={
                method === value ? "active" : ""
              }
              onClick={() => setMethod(value)}
              disabled={
                value === "cash"
                && !cashRegisterOpen
              }
            >
              <Icon size={21} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {method !== "cash" && (
          <label>
            <span>Reference number</span>
            <input
              value={reference}
              onChange={(event) =>
                setReference(event.target.value)
              }
              placeholder="Optional bank, KHQR or card reference"
            />
          </label>
        )}

        <label>
          <span>Payment note</span>
          <textarea
            rows="2"
            value={notes}
            onChange={(event) =>
              setNotes(event.target.value)
            }
            placeholder="Optional receipt or collection note"
          />
        </label>

        <div className="credit-payment-result-row">
          <span>Balance after payment</span>
          <strong>
            {money(
              remaining,
              account.currency
            )}
          </strong>
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
            <HandCoins size={18} />
            {busy
              ? "Recording payment..."
              : "Receive payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
