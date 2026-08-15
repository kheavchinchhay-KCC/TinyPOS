import {
  PackageCheck,
  Truck
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import {
  money,
  stockNumber
} from "../lib/catalog";
import {
  orderRemainingQuantity,
  orderReservedQuantity
} from "../lib/salesOrders";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function SalesOrderDeliveryModal({
  order,
  busy,
  onClose,
  onSubmit
}) {
  const [quantities, setQuantities] =
    useState({});
  const [deliveryDate, setDeliveryDate] =
    useState(today());
  const [address, setAddress] =
    useState("");
  const [notes, setNotes] =
    useState("");
  const [error, setError] =
    useState("");

  useEffect(() => {
    if (!order) return;

    setQuantities(
      Object.fromEntries(
        order.sales_order_items.map(
          (item) => [item.id, ""]
        )
      )
    );
    setDeliveryDate(today());
    setAddress(order.delivery_address || "");
    setNotes("");
    setError("");
  }, [order]);

  const selected = useMemo(() => {
    if (!order) return [];

    return order.sales_order_items
      .map((item) => ({
        item,
        quantity: Number(
          quantities[item.id] || 0
        )
      }))
      .filter((row) => row.quantity > 0);
  }, [order, quantities]);

  const estimatedSubtotal = useMemo(
    () =>
      selected.reduce(
        (sum, row) =>
          sum
          + Number(row.item.net_unit_price || 0)
            * row.quantity,
        0
      ),
    [selected]
  );

  if (!order) return null;

  function receiveAll() {
    setQuantities(
      Object.fromEntries(
        order.sales_order_items.map(
          (item) => [
            item.id,
            String(orderRemainingQuantity(item))
          ]
        )
      )
    );
  }

  function submit(event) {
    event.preventDefault();
    setError("");

    if (selected.length === 0) {
      setError(
        "Enter at least one delivery quantity."
      );
      return;
    }

    for (const { item, quantity } of selected) {
      const remaining =
        orderRemainingQuantity(item);
      const reserved =
        orderReservedQuantity(item);

      if (
        !Number.isFinite(quantity)
        || quantity <= 0
        || quantity > remaining + 0.0005
      ) {
        setError(
          `${item.product_name} has only ${stockNumber(
            remaining
          )} ${item.sale_unit_name} remaining.`
        );
        return;
      }

      if (
        item.stock_reservations?.length
        && quantity > reserved + 0.0005
      ) {
        setError(
          `${item.product_name} has only ${stockNumber(
            reserved
          )} ${item.sale_unit_name} reserved.`
        );
        return;
      }
    }

    onSubmit({
      order_id: order.id,
      items: selected.map(({ item, quantity }) => ({
        sales_order_item_id: item.id,
        quantity
      })),
      delivery_date: deliveryDate,
      delivery_address: address,
      notes
    });
  }

  return (
    <Modal
      title={`Prepare delivery · ${order.order_number}`}
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        className="sales-order-delivery-form"
        onSubmit={submit}
      >
        <div className="sales-order-delivery-heading">
          <div>
            <strong>
              {order.customers?.name}
            </strong>
            <span>
              Select only the quantities being
              delivered now.
            </span>
          </div>

          <button
            type="button"
            className="secondary-button"
            onClick={receiveAll}
          >
            <PackageCheck size={18} />
            Deliver all remaining
          </button>
        </div>

        <div className="sales-order-delivery-table-wrap">
          <table className="sales-order-delivery-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Ordered</th>
                <th>Delivered</th>
                <th>Reserved remaining</th>
                <th>Deliver now</th>
                <th>Estimated value</th>
              </tr>
            </thead>

            <tbody>
              {order.sales_order_items.map((item) => {
                const remaining =
                  orderRemainingQuantity(item);
                const reserved =
                  orderReservedQuantity(item);
                const quantity = Number(
                  quantities[item.id] || 0
                );

                return (
                  <tr key={item.id}>
                    <td data-label="Product">
                      <strong>
                        {item.product_name}
                      </strong>
                      <small>
                        {item.sku
                          || item.barcode
                          || "No product code"}
                      </small>
                    </td>

                    <td data-label="Ordered">
                      {stockNumber(item.quantity)}
                      {" "}
                      {item.sale_unit_name}
                    </td>

                    <td data-label="Delivered">
                      {stockNumber(
                        item.delivered_quantity
                      )}
                    </td>

                    <td data-label="Reserved remaining">
                      {item.stock_reservations?.length
                        ? stockNumber(reserved)
                        : "Not tracked"}
                    </td>

                    <td data-label="Deliver now">
                      <input
                        type="number"
                        min="0"
                        max={remaining}
                        step="0.001"
                        value={quantities[item.id] || ""}
                        onChange={(event) =>
                          setQuantities((current) => ({
                            ...current,
                            [item.id]: event.target.value
                          }))
                        }
                        disabled={remaining <= 0}
                        placeholder="0"
                      />
                    </td>

                    <td data-label="Estimated value">
                      {money(
                        quantity
                          * Number(
                            item.net_unit_price || 0
                          ),
                        order.currency
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="form-grid two">
          <label>
            <span>Delivery date</span>
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
            <span>Estimated subtotal</span>
            <input
              value={money(
                estimatedSubtotal,
                order.currency
              )}
              readOnly
            />
          </label>
        </div>

        <label>
          <span>Delivery address</span>
          <textarea
            rows="2"
            value={address}
            onChange={(event) =>
              setAddress(event.target.value)
            }
          />
        </label>

        <label>
          <span>Delivery note</span>
          <textarea
            rows="2"
            value={notes}
            onChange={(event) =>
              setNotes(event.target.value)
            }
            placeholder="Optional packing or delivery instructions"
          />
        </label>

        <div className="notice info">
          <Truck size={19} />
          The prepared delivery opens in New Sale.
          Payment creates the invoice, deducts stock,
          and completes the delivery note together.
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
            <Truck size={18} />
            {busy
              ? "Preparing delivery..."
              : "Open delivery in New Sale"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
