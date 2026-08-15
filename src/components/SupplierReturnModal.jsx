import { useMemo, useState } from "react";
import { Box, RotateCcw } from "lucide-react";
import Modal from "./Modal";
import { money, stockNumber } from "../lib/catalog";

export default function SupplierReturnModal({
  purchases,
  products,
  busy,
  onClose,
  onSubmit
}) {
  const [purchaseId, setPurchaseId] = useState("");
  const [quantities, setQuantities] = useState({});
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");

  const purchase = purchases.find(
    (row) => row.id === purchaseId
  );

  const productMap = useMemo(
    () =>
      new Map(
        products.map((product) => [
          product.id,
          product
        ])
      ),
    [products]
  );

  const selectedItems = useMemo(() => {
    if (!purchase) return [];

    return (purchase.purchase_items || [])
      .map((item) => ({
        purchase_item_id: item.id,
        quantity: Number(quantities[item.id] || 0),
        source: item
      }))
      .filter((item) => item.quantity > 0);
  }, [purchase, quantities]);

  const estimatedTotal = selectedItems.reduce(
    (sum, item) =>
      sum
      + item.quantity
        * Number(item.source.unit_cost || 0),
    0
  );

  function choosePurchase(value) {
    setPurchaseId(value);
    setQuantities({});
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!purchase) {
      setError("Choose a purchase with received stock.");
      return;
    }

    if (selectedItems.length === 0) {
      setError(
        "Enter a return quantity for at least one product."
      );
      return;
    }

    for (const selected of selectedItems) {
      const source = selected.source;
      const product = productMap.get(source.product_id);
      const currentBaseStock = Number(
        product?.stock_quantity || 0
      );
      const factor = Number(source.unit_factor || 1);
      const requiredBase =
        selected.quantity * factor;

      if (
        selected.quantity
        > Number(source.returnable_quantity || 0)
      ) {
        setError(
          `${source.products?.name || "Product"} has only `
          + `${stockNumber(source.returnable_quantity)} `
          + `${source.purchase_unit_name || "units"} returnable `
          + `from this purchase.`
        );
        return;
      }

      if (requiredBase > currentBaseStock) {
        setError(
          `${source.products?.name || "Product"} needs `
          + `${stockNumber(requiredBase)} `
          + `${source.products?.unit_name || "base units"}, `
          + `but current stock is only `
          + `${stockNumber(currentBaseStock)}.`
        );
        return;
      }
    }

    if (reason.trim().length < 3) {
      setError("Enter a supplier return reason.");
      return;
    }

    await onSubmit({
      purchase_id: purchase.id,
      items: selectedItems.map((item) => ({
        purchase_item_id: item.purchase_item_id,
        quantity: item.quantity
      })),
      reason,
      supplier_reference: reference
    });
  }

  return (
    <Modal
      title="Return stock to supplier"
      onClose={onClose}
      wide
    >
      <form
        className="supplier-return-form"
        onSubmit={submit}
      >
        <label>
          <span>Purchase with received stock</span>
          <select
            value={purchaseId}
            onChange={(event) =>
              choosePurchase(event.target.value)
            }
          >
            <option value="">Choose purchase</option>
            {purchases.map((row) => (
              <option value={row.id} key={row.id}>
                {row.purchase_number}
                {" · "}
                {row.suppliers?.name || "No supplier"}
                {" · "}
                {money(row.total_amount, row.currency)}
              </option>
            ))}
          </select>
        </label>

        {purchase && (
          <div className="supplier-return-items package-aware">
            {(purchase.purchase_items || []).map((item) => {
              const product = productMap.get(item.product_id);
              const returnable = Number(
                item.returnable_quantity || 0
              );
              const factor = Number(item.unit_factor || 1);
              const currentBaseStock = Number(
                product?.stock_quantity || 0
              );
              const currentPurchaseUnits =
                currentBaseStock / factor;
              const maximum = Math.max(
                0,
                Math.min(
                  returnable,
                  currentPurchaseUnits
                )
              );

              return (
                <article key={item.id}>
                  <div>
                    <strong>
                      {item.products?.name || "Product"}
                    </strong>
                    <span>
                      Ordered{" "}
                      {stockNumber(item.quantity)}
                      {" "}
                      {item.purchase_unit_name || "units"}
                      {" · Received "}
                      {stockNumber(item.received_quantity)}
                      {" · Returned "}
                      {stockNumber(item.returned_quantity)}
                      {" · Current stock "}
                      {stockNumber(currentBaseStock)}
                      {" "}
                      {item.products?.unit_name || "pcs"}
                    </span>
                    <small>
                      1{" "}
                      {item.purchase_unit_name || "unit"}
                      {" = "}
                      {stockNumber(factor)}
                      {" "}
                      {item.products?.unit_name || "pcs"}
                    </small>
                  </div>

                  <div>
                    <span>
                      Cost per{" "}
                      {item.purchase_unit_name || "unit"}
                    </span>
                    <strong>
                      {money(
                        item.unit_cost,
                        purchase.currency
                      )}
                    </strong>
                  </div>

                  <label>
                    <span>
                      Return{" "}
                      {item.purchase_unit_name || "quantity"}
                    </span>
                    <input
                      type="number"
                      min="0"
                      max={maximum}
                      step="0.001"
                      disabled={maximum <= 0}
                      value={quantities[item.id] || 0}
                      onChange={(event) =>
                        setQuantities((current) => ({
                          ...current,
                          [item.id]: event.target.value
                        }))
                      }
                    />
                    <small>
                      Maximum: {stockNumber(maximum)}
                      {" "}
                      {item.purchase_unit_name || "units"}
                    </small>
                  </label>
                </article>
              );
            })}
          </div>
        )}

        <div className="supplier-return-package-note">
          <Box size={19} />
          <span>
            Return quantities use the original purchasing unit.
            Inventory is deducted using the equivalent base quantity.
          </span>
        </div>

        <div className="supplier-return-details">
          <label>
            <span>Supplier reference</span>
            <input
              value={reference}
              onChange={(event) =>
                setReference(event.target.value)
              }
              placeholder="Optional credit note or supplier reference"
            />
          </label>

          <label>
            <span>Reason</span>
            <textarea
              rows="3"
              value={reason}
              onChange={(event) =>
                setReason(event.target.value)
              }
              placeholder="Damaged delivery, incorrect item, excess stock..."
            />
          </label>
        </div>

        <div className="supplier-return-total">
          <span>Estimated supplier return value</span>
          <strong>
            {money(
              estimatedTotal,
              purchase?.currency || "USD"
            )}
          </strong>
        </div>

        {error && (
          <div className="notice error">{error}</div>
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
            className="danger-button"
            disabled={
              busy || selectedItems.length === 0
            }
          >
            <RotateCcw size={18} />
            {busy
              ? "Processing return..."
              : "Complete supplier return"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
