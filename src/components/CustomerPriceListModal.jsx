import {
  Search,
  UserRoundCheck
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";

export default function CustomerPriceListModal({
  open,
  customers,
  priceLists,
  busy,
  onClose,
  onSubmit
}) {
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [priceListId, setPriceListId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCustomerId("");
    setPriceListId("");
    setError("");
  }, [open]);

  const matchingCustomers = useMemo(() => {
    const needle = search
      .trim()
      .toLowerCase();

    if (!needle) return customers.slice(0, 40);

    return customers
      .filter((customer) =>
        [
          customer.name,
          customer.company_name,
          customer.customer_code,
          customer.phone,
          customer.email
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
      .slice(0, 40);
  }, [customers, search]);

  if (!open) return null;

  const customer = customers.find(
    (row) => String(row.id) === String(customerId)
  ) || null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!customerId) {
      setError("Choose a customer.");
      return;
    }

    await onSubmit(
      customerId,
      priceListId || null
    );
  }

  return (
    <Modal
      title="Assign customer price list"
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        className="customer-price-list-form"
        onSubmit={submit}
      >
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            placeholder="Search customer, company, code, phone or email"
          />
        </div>

        <div className="customer-price-options">
          {matchingCustomers.map((row) => (
            <label
              key={row.id}
              className={
                String(row.id) === String(customerId)
                  ? "selected"
                  : ""
              }
            >
              <input
                type="radio"
                name="customer-price-list-customer"
                value={row.id}
                checked={String(row.id) === String(customerId)}
                onChange={() => {
                  setCustomerId(row.id);
                  setPriceListId(
                    row.price_list_id || ""
                  );
                }}
              />

              <span>
                <strong>{row.name}</strong>
                <small>
                  {[
                    row.customer_code,
                    row.customer_type,
                    row.phone
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>

              <b>
                {priceLists.find(
                  (list) =>
                    list.id === row.price_list_id
                )?.name || "Automatic"}
              </b>
            </label>
          ))}
        </div>

        {customer && (
          <label>
            <span>
              Price list for {customer.name}
            </span>
            <select
              value={priceListId}
              onChange={(event) =>
                setPriceListId(
                  event.target.value
                )
              }
            >
              <option value="">
                Automatic by customer type
              </option>

              {priceLists.map((list) => (
                <option
                  value={list.id}
                  key={list.id}
                >
                  {list.code} · {list.name}
                  {list.is_active ? "" : " · Inactive"}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="notice info">
          A direct assignment takes priority over the
          customer&apos;s Regular, VIP or Wholesale group.
          Select Automatic to remove the direct override.
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
            disabled={busy || !customerId}
          >
            <UserRoundCheck size={18} />
            {busy
              ? "Saving assignment..."
              : "Save customer pricing"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
