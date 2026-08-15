import { useEffect, useMemo, useState } from "react";
import { Box, LayoutGrid, Plus, Search, Table2, Trash2 } from "lucide-react";
import Modal from "./Modal";
import MediaImage from "./MediaImage";
import { money, stockNumber } from "../lib/catalog";
import {
  purchaseUnitForProduct,
  sortedPurchaseUnits
} from "../lib/purchaseOrders";

function blankForm() {
  return {
    purchase_id: null,
    supplier_id: "",
    currency: "USD",
    discount_amount: 0,
    tax_amount: 0,
    expected_date: "",
    supplier_invoice_number: "",
    payment_terms: "",
    delivery_address: "",
    notes: "",
    status: "draft",
    items: []
  };
}

function itemFromProduct(product, preferredUnitId = null) {
  const unit = purchaseUnitForProduct(
    product,
    preferredUnitId
  );
  const factor = Number(unit.conversion_factor || 1);

  return {
    product_id: product.id,
    name: product.name,
    sku: product.sku || "",
    barcode: unit.barcode || product.barcode || "",
    base_unit_name: product.unit_name || "pcs",
    product_units: sortedPurchaseUnits(product),
    product_unit_id: unit.id,
    purchase_unit_name: unit.name,
    unit_factor: factor,
    quantity: 1,
    unit_cost:
      Number(product.default_cost || 0) * factor
  };
}

export default function PurchaseOrderFormModal({
  open,
  purchase,
  suppliers,
  products,
  busy,
  onClose,
  onSave,
  onOpenSuppliers
}) {
  const [form, setForm] = useState(blankForm);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [itemViewMode, setItemViewMode] = useState(() =>
    globalThis.matchMedia?.("(max-width: 760px)")?.matches ? "cards" : "table"
  );

  useEffect(() => {
    if (!open) return;

    if (!purchase) {
      setForm(blankForm());
    } else {
      setForm({
        purchase_id: purchase.id,
        supplier_id: purchase.supplier_id || "",
        currency: purchase.currency || "USD",
        discount_amount: Number(
          purchase.discount_amount || 0
        ),
        tax_amount: Number(purchase.tax_amount || 0),
        expected_date: purchase.expected_date || "",
        supplier_invoice_number:
          purchase.supplier_invoice_number || "",
        payment_terms: purchase.payment_terms || "",
        delivery_address: purchase.delivery_address || "",
        notes: purchase.notes || "",
        status: ["draft", "ordered"].includes(
          purchase.status
        )
          ? purchase.status
          : "draft",
        items: (purchase.purchase_items || []).map((item) => {
          const product =
            products.find(
              (row) => row.id === item.product_id
            )
            || item.products
            || {};

          const unit = purchaseUnitForProduct(
            product,
            item.product_unit_id
          );

          return {
            product_id: item.product_id,
            name: item.products?.name || "Product",
            sku: item.products?.sku || "",
            barcode:
              unit.barcode
              || item.products?.barcode
              || "",
            base_unit_name:
              item.products?.unit_name || "pcs",
            product_units: sortedPurchaseUnits(product),
            product_unit_id:
              item.product_unit_id || unit.id,
            purchase_unit_name:
              item.purchase_unit_name || unit.name,
            unit_factor: Number(
              item.unit_factor
              || unit.conversion_factor
              || 1
            ),
            quantity: Number(item.quantity || 0),
            unit_cost: Number(item.unit_cost || 0)
          };
        })
      });
    }

    setSearch("");
    setError("");
    setItemViewMode(
      globalThis.matchMedia?.("(max-width: 760px)")?.matches ? "cards" : "table"
    );
  }, [open, purchase, products]);

  const matchingProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];

    return products
      .filter(
        (product) => product.currency === form.currency
      )
      .filter((product) =>
        [
          product.name,
          product.name_km,
          product.sku,
          product.barcode,
          ...(product.product_units || []).flatMap((unit) => [
            unit.name,
            unit.short_name,
            unit.barcode
          ])
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
      .filter(
        (product) =>
          !form.items.some(
            (item) => item.product_id === product.id
          )
      )
      .slice(0, 8);
  }, [products, form.currency, form.items, search]);

  const subtotal = useMemo(
    () =>
      form.items.reduce(
        (sum, item) =>
          sum
          + Number(item.quantity || 0)
            * Number(item.unit_cost || 0),
        0
      ),
    [form.items]
  );

  const total = Math.max(
    0,
    subtotal
      - Number(form.discount_amount || 0)
      + Number(form.tax_amount || 0)
  );

  function update(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
    setError("");
  }

  function addProduct(product) {
    setForm((current) => ({
      ...current,
      items: [
        ...current.items,
        itemFromProduct(product)
      ]
    }));
    setSearch("");
  }

  function updateItem(productId, changes) {
    setForm((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.product_id === productId
          ? { ...item, ...changes }
          : item
      )
    }));
  }

  function changeUnit(item, unitId) {
    const unit =
      item.product_units.find(
        (candidate) => candidate.id === unitId
      )
      || item.product_units.find(
        (candidate) => candidate.is_base
      );

    if (!unit) return;

    const product = products.find(
      (candidate) => candidate.id === item.product_id
    );

    const factor = Number(
      unit.conversion_factor || 1
    );

    updateItem(item.product_id, {
      product_unit_id: unit.id,
      purchase_unit_name: unit.name,
      unit_factor: factor,
      barcode:
        unit.barcode
        || product?.barcode
        || item.barcode,
      unit_cost:
        Number(product?.default_cost || 0) * factor
    });
  }

  function removeItem(productId) {
    setForm((current) => ({
      ...current,
      items: current.items.filter(
        (item) => item.product_id !== productId
      )
    }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!form.supplier_id) {
      setError("Choose a supplier.");
      return;
    }

    if (form.items.length === 0) {
      setError("Add at least one product.");
      return;
    }

    if (
      form.items.some(
        (item) =>
          !item.product_unit_id
          || !Number.isFinite(Number(item.quantity))
          || Number(item.quantity) <= 0
          || !Number.isFinite(Number(item.unit_cost))
          || Number(item.unit_cost) < 0
      )
    ) {
      setError(
        "Every product needs a unit, quantity and unit cost."
      );
      return;
    }

    await onSave(form);
  }

  if (!open) return null;

  return (
    <Modal
      title={
        purchase
          ? `Edit ${purchase.purchase_number}`
          : "New purchase order"
      }
      onClose={onClose}
      wide
    >
      <form className="po-form" onSubmit={submit}>
        <div className="po-header-grid">
          <label>
            <span>Supplier</span>
            <div className="po-supplier-field">
              <select
                value={form.supplier_id}
                onChange={(event) =>
                  update(
                    "supplier_id",
                    event.target.value
                  )
                }
              >
                <option value="">Choose supplier</option>
                {suppliers
                  .filter(
                    (supplier) => supplier.is_active
                  )
                  .map((supplier) => (
                    <option
                      value={supplier.id}
                      key={supplier.id}
                    >
                      {supplier.supplier_code}
                      {" · "}
                      {supplier.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="secondary-button"
                onClick={onOpenSuppliers}
              >
                <Plus size={17} />
                Supplier
              </button>
            </div>
          </label>

          <label>
            <span>Currency</span>
            <select
              value={form.currency}
              onChange={(event) => {
                if (form.items.length > 0) {
                  setError(
                    "Remove order items before changing currency."
                  );
                  return;
                }

                update("currency", event.target.value);
              }}
            >
              <option value="USD">USD</option>
              <option value="KHR">KHR</option>
            </select>
          </label>

          <label>
            <span>Order status</span>
            <select
              value={form.status}
              onChange={(event) =>
                update("status", event.target.value)
              }
            >
              <option value="draft">Draft</option>
              <option value="ordered">Ordered</option>
            </select>
          </label>

          <label>
            <span>Expected date</span>
            <input
              type="date"
              value={form.expected_date}
              onChange={(event) =>
                update(
                  "expected_date",
                  event.target.value
                )
              }
            />
          </label>
        </div>

        <section className="po-product-picker">
          <div className="search-box">
            <Search size={18} />
            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              placeholder="Search product, code, base barcode or package barcode"
            />
          </div>

          {matchingProducts.length > 0 && (
            <div className="po-search-results">
              {matchingProducts.map((product) => {
                const baseUnit =
                  purchaseUnitForProduct(product);

                return (
                  <button
                    type="button"
                    key={product.id}
                    onClick={() => addProduct(product)}
                  >
                    <MediaImage
                      src={product.image_url}
                      alt={product.name}
                      width={160}
                      height={120}
                      className="po-product-media"
                    />

                    <span>
                      <strong>{product.name}</strong>
                      <small>
                        {[
                          product.sku,
                          product.barcode,
                          `${product.product_units?.length || 1} unit(s)`
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>

                    <strong>
                      {money(
                        Number(product.default_cost || 0)
                          * Number(
                            baseUnit.conversion_factor || 1
                          ),
                        product.currency
                      )}
                    </strong>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <div className="po-modal-item-view-header">
          <div>
            <strong>Selected products</strong>
            <span>{form.items.length} item{form.items.length === 1 ? "" : "s"}</span>
          </div>
          <div className="list-view-mode po-modal-view-toggle" role="group" aria-label="Purchase order item view">
            <button
              type="button"
              className={itemViewMode === "table" ? "active" : ""}
              onClick={() => setItemViewMode("table")}
            >
              <Table2 size={17} /> Table
            </button>
            <button
              type="button"
              className={itemViewMode === "cards" ? "active" : ""}
              onClick={() => setItemViewMode("cards")}
            >
              <LayoutGrid size={17} /> Cards
            </button>
          </div>
        </div>

        {itemViewMode === "table" ? (
          <div className="po-items-table-wrap">
            <table className="po-items-table package-aware">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Purchase unit</th>
                  <th>Quantity</th>
                  <th>Cost per unit</th>
                  <th>Base quantity</th>
                  <th>Line total</th>
                  <th />
                </tr>
              </thead>

              <tbody>
                {form.items.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="po-empty-row">
                      Search and add products above.
                    </td>
                  </tr>
                ) : (
                  form.items.map((item) => {
                    const baseQuantity =
                      Number(item.quantity || 0)
                      * Number(item.unit_factor || 1);

                    return (
                      <tr key={item.product_id}>
                        <td data-label="Product">
                          <strong>{item.name}</strong>
                          <small>
                            {[item.sku, item.barcode]
                              .filter(Boolean)
                              .join(" · ")
                              || "No code"}
                          </small>
                        </td>

                        <td data-label="Purchase unit">
                          <select
                            value={item.product_unit_id || ""}
                            onChange={(event) =>
                              changeUnit(item, event.target.value)
                            }
                          >
                            {item.product_units.map((unit) => (
                              <option value={unit.id} key={unit.id}>
                                {unit.name}
                                {" · 1 = "}
                                {stockNumber(unit.conversion_factor)}
                                {" "}
                                {item.base_unit_name}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td data-label="Quantity">
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={item.quantity}
                            onChange={(event) =>
                              updateItem(item.product_id, { quantity: event.target.value })
                            }
                          />
                        </td>

                        <td data-label="Cost per unit">
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={item.unit_cost}
                            onChange={(event) =>
                              updateItem(item.product_id, { unit_cost: event.target.value })
                            }
                          />
                        </td>

                        <td data-label="Base quantity">
                          <strong>
                            {stockNumber(baseQuantity)} {item.base_unit_name}
                          </strong>
                          <small>
                            Base cost: {money(
                              Number(item.unit_cost || 0)
                                / Math.max(Number(item.unit_factor || 1), 0.001),
                              form.currency
                            )}
                          </small>
                        </td>

                        <td data-label="Line total">
                          <strong>
                            {money(
                              Number(item.quantity || 0) * Number(item.unit_cost || 0),
                              form.currency
                            )}
                          </strong>
                        </td>

                        <td data-label="Remove">
                          <button
                            type="button"
                            className="icon-button danger-icon"
                            onClick={() => removeItem(item.product_id)}
                            title="Remove product"
                          >
                            <Trash2 size={18} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="po-item-card-grid">
            {form.items.length === 0 ? (
              <div className="po-empty-row">Search and add products above.</div>
            ) : (
              form.items.map((item) => {
                const baseQuantity =
                  Number(item.quantity || 0)
                  * Number(item.unit_factor || 1);

                return (
                  <article className="po-item-edit-card" key={item.product_id}>
                    <header>
                      <div>
                        <strong>{item.name}</strong>
                        <small>
                          {[item.sku, item.barcode].filter(Boolean).join(" · ") || "No code"}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="icon-button danger-icon"
                        onClick={() => removeItem(item.product_id)}
                        title="Remove product"
                      >
                        <Trash2 size={18} />
                      </button>
                    </header>

                    <div className="po-item-edit-card-fields">
                      <label>
                        <span>Purchase unit</span>
                        <select
                          value={item.product_unit_id || ""}
                          onChange={(event) => changeUnit(item, event.target.value)}
                        >
                          {item.product_units.map((unit) => (
                            <option value={unit.id} key={unit.id}>
                              {unit.name} · 1 = {stockNumber(unit.conversion_factor)} {item.base_unit_name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        <span>Quantity</span>
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={item.quantity}
                          onChange={(event) =>
                            updateItem(item.product_id, { quantity: event.target.value })
                          }
                        />
                      </label>

                      <label>
                        <span>Cost per unit</span>
                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          value={item.unit_cost}
                          onChange={(event) =>
                            updateItem(item.product_id, { unit_cost: event.target.value })
                          }
                        />
                      </label>
                    </div>

                    <div className="po-item-edit-card-summary">
                      <div>
                        <span>Base quantity</span>
                        <strong>{stockNumber(baseQuantity)} {item.base_unit_name}</strong>
                      </div>
                      <div>
                        <span>Line total</span>
                        <strong>
                          {money(
                            Number(item.quantity || 0) * Number(item.unit_cost || 0),
                            form.currency
                          )}
                        </strong>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        )}

        <div className="po-package-note">
          <Box size={19} />
          <span>
            Quantity and cost are entered in the selected
            purchasing unit. Receiving converts them into the
            product’s base stock automatically.
          </span>
        </div>

        <div className="po-details-grid">
          <label>
            <span>Supplier invoice number</span>
            <input
              value={form.supplier_invoice_number}
              onChange={(event) =>
                update(
                  "supplier_invoice_number",
                  event.target.value
                )
              }
              placeholder="Optional"
            />
          </label>

          <label>
            <span>Payment terms</span>
            <input
              value={form.payment_terms}
              onChange={(event) =>
                update(
                  "payment_terms",
                  event.target.value
                )
              }
              placeholder="Example: Net 30"
            />
          </label>

          <label className="po-wide-field">
            <span>Delivery address</span>
            <input
              value={form.delivery_address}
              onChange={(event) =>
                update(
                  "delivery_address",
                  event.target.value
                )
              }
              placeholder="Optional delivery address"
            />
          </label>

          <label>
            <span>Discount</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.discount_amount}
              onChange={(event) =>
                update(
                  "discount_amount",
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Tax</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.tax_amount}
              onChange={(event) =>
                update(
                  "tax_amount",
                  event.target.value
                )
              }
            />
          </label>

          <label className="po-wide-field">
            <span>Notes</span>
            <textarea
              rows="3"
              value={form.notes}
              onChange={(event) =>
                update("notes", event.target.value)
              }
            />
          </label>
        </div>

        <div className="po-total-box">
          <div>
            <span>Subtotal</span>
            <strong>
              {money(subtotal, form.currency)}
            </strong>
          </div>
          <div>
            <span>Discount</span>
            <strong>
              -{money(
                form.discount_amount,
                form.currency
              )}
            </strong>
          </div>
          <div>
            <span>Tax</span>
            <strong>
              {money(form.tax_amount, form.currency)}
            </strong>
          </div>
          <div className="po-grand-total">
            <span>Total</span>
            <strong>{money(total, form.currency)}</strong>
          </div>
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
            className="primary-button"
            disabled={busy}
          >
            {busy
              ? "Saving..."
              : form.status === "ordered"
                ? "Save and mark ordered"
                : "Save draft"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
