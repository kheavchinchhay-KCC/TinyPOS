import {
  useEffect,
  useMemo,
  useState
} from "react";
import {
  Banknote,
  Building2,
  CreditCard,
  HandCoins,
  QrCode,
  Split,
  X
} from "lucide-react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

const methods = [
  ["cash", "Cash", Banknote],
  ["bank", "Bank", Building2],
  ["khqr", "KHQR", QrCode],
  ["card", "Card", CreditCard],
  ["credit", "Credit", HandCoins]
];

function dueDateFromTerms(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

function currencyStep(currency) {
  return currency === "KHR" ? "1" : "0.01";
}

function currencyPrecision(currency) {
  return currency === "KHR" ? 0 : 2;
}

function roundCurrency(value, currency) {
  const power = 10 ** currencyPrecision(currency);
  return Math.round((Number(value || 0) + Number.EPSILON) * power) / power;
}

function tenderToSale(amount, tenderCurrency, saleCurrency, exchangeRate) {
  const value = Number(amount || 0);
  if (tenderCurrency === saleCurrency) return value;
  if (tenderCurrency === "USD" && saleCurrency === "KHR") return value * exchangeRate;
  if (tenderCurrency === "KHR" && saleCurrency === "USD") return value / exchangeRate;
  return 0;
}

function saleToTender(amount, saleCurrency, tenderCurrency, exchangeRate) {
  const value = Number(amount || 0);
  if (tenderCurrency === saleCurrency) return value;
  if (saleCurrency === "USD" && tenderCurrency === "KHR") return value * exchangeRate;
  if (saleCurrency === "KHR" && tenderCurrency === "USD") return value / exchangeRate;
  return 0;
}

function exactTender(total, saleCurrency, tenderCurrency, exchangeRate) {
  return String(roundCurrency(
    saleToTender(total, saleCurrency, tenderCurrency, exchangeRate),
    tenderCurrency
  ));
}

export default function PaymentModal({
  open,
  busy,
  totals,
  currency,
  exchangeRate = 4100,
  customerName,
  creditAccount,
  cashRegisterOpen = true,
  offline = false,
  onClose,
  onSubmit
}) {
  const rate = Math.max(0.0001, Number(exchangeRate || 4100));
  const [method, setMethod] = useState("cash");
  const [paymentCurrency, setPaymentCurrency] = useState("USD");
  const [amountReceived, setAmountReceived] = useState("");
  const [reference, setReference] = useState("");
  const [splitMode, setSplitMode] = useState(false);
  const [cashCurrency, setCashCurrency] = useState("USD");
  const [cashReceived, setCashReceived] = useState("0");
  const [bankCurrency, setBankCurrency] = useState("USD");
  const [bankReceived, setBankReceived] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [error, setError] = useState("");

  const unlimitedCredit = Boolean(creditAccount?.allow_unlimited_credit);
  const creditAvailable = unlimitedCredit
    ? Number.POSITIVE_INFINITY
    : Math.max(
      0,
      Number(creditAccount?.credit_limit || 0)
      - Number(creditAccount?.balance_due || 0)
    );

  const creditAllowed = Boolean(
    customerName
    && creditAccount
    && !creditAccount.is_on_hold
    && (unlimitedCredit || Number(creditAccount.credit_limit || 0) > 0)
    && !offline
    && Number(totals.total || 0) > 0
    && (unlimitedCredit || creditAvailable >= Number(totals.total || 0))
  );

  const totalDue = Number(totals.total || 0);
  const alternateCurrency = currency === "USD" ? "KHR" : "USD";
  const alternateDue = roundCurrency(
    saleToTender(totalDue, currency, alternateCurrency, rate),
    alternateCurrency
  );
  const tolerance = currency === "KHR" ? 1 : 0.01;

  useEffect(() => {
    if (!open) return;
    const initialMethod = cashRegisterOpen ? "cash" : "bank";
    setMethod(initialMethod);
    setPaymentCurrency("USD");
    setAmountReceived(exactTender(totalDue, currency, "USD", rate));
    setReference("");
    setSplitMode(false);
    setCashCurrency("USD");
    setCashReceived("0");
    setBankCurrency("USD");
    setBankReceived(exactTender(totalDue, currency, "USD", rate));
    setBankReference("");
    setError("");
  }, [open, totalDue, currency, rate, cashRegisterOpen]);

  useEffect(() => {
    if (method === "credit" && !creditAllowed) {
      setMethod(cashRegisterOpen ? "cash" : "bank");
    }
  }, [method, creditAllowed, cashRegisterOpen]);

  const receivedSaleValue = useMemo(
    () => tenderToSale(amountReceived, paymentCurrency, currency, rate),
    [amountReceived, paymentCurrency, currency, rate]
  );
  const singleChangeSale = method === "cash"
    ? Math.max(0, receivedSaleValue - totalDue)
    : 0;
  const singleChangeTender = roundCurrency(
    saleToTender(singleChangeSale, currency, paymentCurrency, rate),
    paymentCurrency
  );

  const cashSaleValue = useMemo(
    () => tenderToSale(cashReceived, cashCurrency, currency, rate),
    [cashReceived, cashCurrency, currency, rate]
  );
  const bankSaleValue = useMemo(
    () => tenderToSale(bankReceived, bankCurrency, currency, rate),
    [bankReceived, bankCurrency, currency, rate]
  );
  const splitCombined = cashSaleValue + bankSaleValue;
  const splitRemaining = Math.max(0, totalDue - splitCombined);
  const splitChangeSale = Math.max(0, splitCombined - totalDue);
  const splitChangeTender = roundCurrency(
    saleToTender(splitChangeSale, currency, cashCurrency, rate),
    cashCurrency
  );

  if (!open) return null;

  function setSingleCurrency(nextCurrency) {
    setPaymentCurrency(nextCurrency);
    setAmountReceived(exactTender(totalDue, currency, nextCurrency, rate));
  }

  function chooseMethod(nextMethod) {
    setSplitMode(false);
    setMethod(nextMethod);
    setReference("");
    setError("");
    if (nextMethod === "credit") {
      setAmountReceived("0");
    } else {
      setAmountReceived(exactTender(totalDue, currency, paymentCurrency, rate));
    }
  }

  function enableSplit() {
    setSplitMode(true);
    setMethod("split");
    setCashCurrency("USD");
    setBankCurrency("USD");
    setCashReceived("0");
    setBankReceived(exactTender(totalDue, currency, "USD", rate));
    setError("");
  }

  function fillBankRemainder() {
    const remainingSale = Math.max(0, totalDue - cashSaleValue);
    setBankReceived(exactTender(remainingSale, currency, bankCurrency, rate));
  }

  function fillCashRemainder() {
    const remainingSale = Math.max(0, totalDue - bankSaleValue);
    setCashReceived(exactTender(remainingSale, currency, cashCurrency, rate));
  }

  function submit(event) {
    event.preventDefault();
    setError("");

    if (!splitMode && method === "credit") {
      if (!customerName) {
        setError("Choose a customer before using Credit Account.");
        return;
      }
      if (!creditAccount) {
        setError(`This customer has no ${currency} credit account.`);
        return;
      }
      if (creditAccount.is_on_hold) {
        setError("This customer credit account is on hold.");
        return;
      }
      if (!unlimitedCredit && creditAvailable < totalDue) {
        setError(`Available credit is only ${money(creditAvailable, currency)}.`);
        return;
      }

      onSubmit({
        payment_method: "credit",
        amount_received: 0,
        payment_reference: "",
        payments: []
      });
      return;
    }

    if (splitMode) {
      const cashAmount = Number(cashReceived || 0);
      const bankAmount = Number(bankReceived || 0);
      if (cashAmount < 0 || bankAmount < 0 || !Number.isFinite(cashAmount + bankAmount)) {
        setError("Enter valid cash and bank amounts.");
        return;
      }
      if (cashAmount > 0 && !cashRegisterOpen) {
        setError("Open your cash register before accepting the cash part.");
        return;
      }
      if (cashAmount <= 0 && bankAmount <= 0) {
        setError("Enter a cash amount, a bank amount, or both.");
        return;
      }
      if (bankSaleValue > totalDue + tolerance) {
        setError("The bank amount cannot be more than the receipt total. Put any overpayment in cash so change can be returned.");
        return;
      }
      if (splitCombined + tolerance < totalDue) {
        setError(`Payment is short by ${money(splitRemaining, currency)}.`);
        return;
      }
      if (splitChangeSale > tolerance && cashAmount <= 0) {
        setError("Only the cash part can create change.");
        return;
      }

      const payments = [];
      if (bankAmount > 0) {
        payments.push({
          method: "bank",
          currency: bankCurrency,
          amount_received: roundCurrency(bankAmount, bankCurrency),
          reference_number: bankReference.trim()
        });
      }
      if (cashAmount > 0) {
        payments.push({
          method: "cash",
          currency: cashCurrency,
          amount_received: roundCurrency(cashAmount, cashCurrency),
          reference_number: ""
        });
      }

      onSubmit({
        payment_method: payments.length > 1 ? "split" : payments[0].method,
        amount_received: splitCombined,
        payment_reference: bankReference.trim(),
        payments
      });
      return;
    }

    const received = Number(amountReceived || 0);
    if (!Number.isFinite(received) || received <= 0) {
      setError("Enter a valid received amount.");
      return;
    }
    if (method === "cash" && !cashRegisterOpen) {
      setError("Open the cash register before accepting cash.");
      return;
    }
    if (receivedSaleValue + tolerance < totalDue) {
      setError(`Amount received must be at least ${money(totalDue, currency)}.`);
      return;
    }
    if (method !== "cash" && receivedSaleValue > totalDue + tolerance) {
      setError("A non-cash payment must match the receipt total. Only cash can return change.");
      return;
    }

    onSubmit({
      payment_method: method,
      amount_received: receivedSaleValue,
      payment_reference: reference.trim(),
      payments: [{
        method,
        currency: paymentCurrency,
        amount_received: roundCurrency(received, paymentCurrency),
        reference_number: reference.trim()
      }]
    });
  }

  const exactSingle = exactTender(totalDue, currency, paymentCurrency, rate);
  const roundedSingle = paymentCurrency === "KHR"
    ? Math.ceil(Number(exactSingle) / 1000) * 1000
    : Math.ceil(Number(exactSingle));
  const cashIncrements = paymentCurrency === "KHR" ? [1000, 5000, 10000] : [5, 10, 20];

  return (
    <Modal title="Complete payment" onClose={() => !busy && onClose()} className="payment-modal-card" bodyClassName="payment-modal-body">
      <form className="payment-form mixed-payment-form" onSubmit={submit}>
        <div className="payment-form-scroll">
          <div className="payment-total-card">
            <span>Amount due</span>
            <strong>{money(totalDue, currency)}</strong>
            <b>≈ {money(alternateDue, alternateCurrency)}</b>
            <small>{customerName || "Walk-in customer"} · Rate $1 = ៛{Number(rate).toLocaleString("en-US")}</small>
          </div>

          {offline && (
            <div className="notice warning payment-register-warning">
              Offline payment creates a pending-sync receipt. Mixed currency, split payment, credit, coupons and manual discounts require a connection.
            </div>
          )}

          {!cashRegisterOpen && (
            <div className="notice warning payment-register-warning">
              Cash is disabled because your user has no open register. Bank, KHQR, card and customer credit remain available when eligible.
            </div>
          )}

          <div className="payment-method-grid credit-sale-method-grid">
            {methods.map(([value, label, Icon]) => {
              const disabled =
                (value === "cash" && !cashRegisterOpen)
                || (value === "credit" && !creditAllowed);
              let title;
              if (value === "cash" && !cashRegisterOpen) title = "Open the cash register first";
              if (value === "credit") {
                if (!customerName) title = "Choose a customer first";
                else if (!creditAccount) title = `No ${currency} credit account`;
                else if (creditAccount.is_on_hold) title = "Credit account is on hold";
                else if (!unlimitedCredit && creditAvailable < totalDue) title = "Available credit is too low";
              }
              return (
                <button
                  type="button"
                  key={value}
                  className={!splitMode && method === value ? "active" : ""}
                  onClick={() => chooseMethod(value)}
                  disabled={disabled}
                  title={title}
                >
                  <Icon size={22} />
                  <span>{label}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={splitMode ? "active split-payment-choice" : "split-payment-choice"}
              onClick={enableSplit}
              disabled={!cashRegisterOpen || offline}
              title={!cashRegisterOpen ? "Open the cash register before using cash + bank" : "Pay one receipt with cash and bank"}
            >
              <Split size={22} />
              <span>Cash + Bank</span>
            </button>
          </div>

          {!splitMode && method === "credit" ? (
            <section className="credit-sale-summary">
              <div><span>Current balance</span><strong>{money(creditAccount?.balance_due || 0, currency)}</strong></div>
              <div><span>Available credit</span><strong>{unlimitedCredit ? "Unlimited" : money(creditAvailable, currency)}</strong></div>
              <div><span>Balance after sale</span><strong>{money(Number(creditAccount?.balance_due || 0) + totalDue, currency)}</strong></div>
              <div><span>Due date</span><strong>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(dueDateFromTerms(creditAccount?.payment_terms_days))}</strong></div>
            </section>
          ) : splitMode ? (
            <section className="split-payment-editor">
              <article>
                <div className="split-payment-heading"><Banknote size={20} /><strong>Cash part</strong></div>
                <div className="payment-amount-currency-row">
                  <label><span>Received</span><select value={cashCurrency} onChange={(event) => setCashCurrency(event.target.value)}><option value="USD">USD $</option><option value="KHR">KHR ៛</option></select></label>
                  <label><span>Cash received</span><input type="number" min="0" step={currencyStep(cashCurrency)} value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} /></label>
                </div>
                <button type="button" className="secondary-button compact-button" onClick={fillCashRemainder}>Use remaining balance</button>
                <small>Sale value: {money(cashSaleValue, currency)}</small>
              </article>

              <article>
                <div className="split-payment-heading">
                  <span><Building2 size={20} /><strong>Bank part</strong></span>
                </div>
                <div className="payment-amount-currency-row">
                  <label><span>Received</span><select value={bankCurrency} onChange={(event) => setBankCurrency(event.target.value)}><option value="USD">USD $</option><option value="KHR">KHR ៛</option></select></label>
                  <label><span>Bank amount</span><input type="number" min="0" step={currencyStep(bankCurrency)} value={bankReceived} onChange={(event) => setBankReceived(event.target.value)} /></label>
                </div>
                <button type="button" className="secondary-button compact-button" onClick={fillBankRemainder}>Use remaining balance</button>
                <label><span>Bank reference</span><input value={bankReference} onChange={(event) => setBankReference(event.target.value)} placeholder="Optional transfer reference" /></label>
                <small>Sale value: {money(bankSaleValue, currency)}</small>
              </article>

              <div className="split-payment-summary">
                <span>Combined</span><strong>{money(splitCombined, currency)}</strong>
                <span>Remaining</span><strong>{money(splitRemaining, currency)}</strong>
                <span>Cash change</span><strong>{money(splitChangeTender, cashCurrency)}</strong>
              </div>
            </section>
          ) : (
            <>
              <div className="payment-amount-currency-row">
                <label>
                  <span>Received currency</span>
                  <select value={paymentCurrency} onChange={(event) => setSingleCurrency(event.target.value)}>
                    <option value="USD">USD $</option>
                    <option value="KHR">KHR ៛</option>
                  </select>
                </label>
                <label>
                  <span>{method === "cash" ? "Cash received" : "Amount paid"}</span>
                  <input
                    type="number"
                    min="0"
                    step={currencyStep(paymentCurrency)}
                    value={amountReceived}
                    onChange={(event) => setAmountReceived(event.target.value)}
                  />
                </label>
              </div>

              {method === "cash" && (
                <div className="cash-shortcuts">
                  <button type="button" onClick={() => setAmountReceived(exactSingle)}>Exact</button>
                  {roundedSingle > Number(exactSingle) && <button type="button" onClick={() => setAmountReceived(String(roundedSingle))}>{money(roundedSingle, paymentCurrency)}</button>}
                  {cashIncrements.map((increment) => (
                    <button type="button" key={increment} onClick={() => setAmountReceived(String(roundedSingle + increment))}>{money(roundedSingle + increment, paymentCurrency)}</button>
                  ))}
                </div>
              )}

              {method !== "cash" && (
                <label>
                  <span>Reference number</span>
                  <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Optional bank, KHQR or card reference" />
                </label>
              )}

              <div className="payment-conversion-preview">
                <span>Counts toward receipt</span><strong>{money(receivedSaleValue, currency)}</strong>
              </div>
            </>
          )}

          <div className="payment-change-row">
            <span>{!splitMode && method === "credit" ? "Paid now" : "Change"}</span>
            <strong>
              {!splitMode && method === "credit"
                ? money(0, currency)
                : splitMode
                  ? money(splitChangeTender, cashCurrency)
                  : money(singleChangeTender, paymentCurrency)}
            </strong>
          </div>

          {error && <div className="notice error">{error}</div>}
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Completing..." : !splitMode && method === "credit" ? "Complete credit sale" : "Complete sale"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
