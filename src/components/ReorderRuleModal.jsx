import { useEffect, useMemo, useState } from "react";
import { Box, Save } from "lucide-react";
import Modal from "./Modal";
import { money, stockNumber } from "../lib/catalog";

export default function ReorderRuleModal({
  suggestion,
  suppliers,
  busy,
  onClose,
  onSave
}) {
  const [form, setForm] = useState({
    reorder_point: "0",
    target_stock: "0",
    preferred_supplier_id: "",
    purchase_unit_id: "",
    minimum_order_quantity: "1",
    lead_time_days: "0",
    supplier_sku: "",
    is_active: true
  });
  const [error, setError] = useState("");

  const units = useMemo(
    () =>
      [...(suggestion?.product_units || [])]
        .filter((unit) => unit.is_active)
        .sort(
          (a, b) =>
            Number(b.is_base) - Number(a.is_base)
            || Number(a.sort_order || 0)
              - Number(b.sort_order || 0)
        ),
    [suggestion]
  );

  useEffect(() => {
    if (!suggestion) return;

    setForm({
      reorder_point: String(
        suggestion.configured_reorder_point
          ?? suggestion.reorder_point
          ?? 0
      ),
      target_stock: String(
        suggestion.configured_target_stock
          ?? suggestion.target_stock
          ?? 0
      ),
      preferred_supplier_id:
        suggestion.configured_supplier_id
        || suggestion.preferred_supplier_id
        || "",
      purchase_unit_id:
        suggestion.configured_purchase_unit_id
        || suggestion.purchase_unit_id
        || units[0]?.id
        || "",
      minimum_order_quantity: String(
        suggestion.configured_minimum_order_quantity
          ?? suggestion.minimum_order_quantity
          ?? 1
      ),
      lead_time_days: String(
        suggestion.configured_lead_time_days
          ?? suggestion.lead_time_days
          ?? 0
      ),
      supplier_sku:
        suggestion.supplier_sku || "",
      is_active:
        suggestion.rule_id
          ? Boolean(suggestion.rule_active)
          : true
    });

    setError("");
  }, [suggestion, units]);

  if (!suggestion) return null;

  const selectedUnit =
    units.find(
      (unit) => unit.id === form.purchase_unit_id
    )
    || units[0];

  const factor = Number(
    selectedUnit?.conversion_factor || 1
  );

  const estimatedUnitCost =
    Number(suggestion.estimated_base_unit_cost || 0)
    * factor;

  function update(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();

    const reorderPoint = Number(form.reorder_point);
    const targetStock = Number(form.target_stock);
    const minimumOrder = Number(
      form.minimum_order_quantity
    );
    const leadTime = Number(form.lead_time_days);

    if (
      !Number.isFinite(reorderPoint)
      || reorderPoint < 0
    ) {
      setError(
        "Reorder point must be zero or greater."
      );
      return;
    }

    if (
      !Number.isFinite(targetStock)
      || targetStock < reorderPoint
    ) {
      setError(
        "Target stock must equal or exceed the reorder point."
      );
      return;
    }

    if (
      !Number.isFinite(minimumOrder)
      || minimumOrder <= 0
    ) {
      setError(
        "Minimum order quantity must be greater than zero."
      );
      return;
    }

    if (
      !Number.isInteger(leadTime)
      || leadTime < 0
    ) {
      setError(
        "Lead time must be a whole number of days."
      );
      return;
    }

    if (!form.purchase_unit_id) {
      setError("Choose a purchasing unit.");
      return;
    }

    await onSave({
      product_id: suggestion.product_id,
      ...form
    });
  }

  return (
    <Modal
      title={`Reorder rule · ${suggestion.product_name}`}
      onClose={onClose}
      wide
    >
      <form
        className="reorder-rule-form"
        onSubmit={submit}
      >
        <section className="reorder-rule-stock">
          <div>
            <span>Current stock</span>
            <strong>
              {stockNumber(suggestion.current_stock)}
              {" "}
              {suggestion.base_unit_name}
            </strong>
          </div>
          <div>
            <span>Already ordered</span>
            <strong>
              {stockNumber(
                suggestion.ordered_base_quantity
              )}
              {" "}
              {suggestion.base_unit_name}
            </strong>
          </div>
          <div>
            <span>Projected stock</span>
            <strong>
              {stockNumber(suggestion.projected_stock)}
              {" "}
              {suggestion.base_unit_name}
            </strong>
          </div>
        </section>

        <div className="form-grid three">
          <label>
            <span>
              Reorder point ({suggestion.base_unit_name})
            </span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={form.reorder_point}
              onChange={(event) =>
                update(
                  "reorder_point",
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>
              Target stock ({suggestion.base_unit_name})
            </span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={form.target_stock}
              onChange={(event) =>
                update(
                  "target_stock",
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Supplier lead time</span>
            <div className="input-with-suffix">
              <input
                type="number"
                min="0"
                step="1"
                value={form.lead_time_days}
                onChange={(event) =>
                  update(
                    "lead_time_days",
                    event.target.value
                  )
                }
              />
              <span>days</span>
            </div>
          </label>
        </div>

        <div className="form-grid two">
          <label>
            <span>Preferred supplier</span>
            <select
              value={form.preferred_supplier_id}
              onChange={(event) =>
                update(
                  "preferred_supplier_id",
                  event.target.value
                )
              }
            >
              <option value="">
                No preferred supplier
              </option>
              {suppliers.map((supplier) => (
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
          </label>

          <label>
            <span>Supplier product code</span>
            <input
              value={form.supplier_sku}
              onChange={(event) =>
                update(
                  "supplier_sku",
                  event.target.value
                )
              }
              placeholder="Optional supplier SKU"
            />
          </label>
        </div>

        <section className="reorder-unit-box">
          <div className="reorder-unit-heading">
            <Box size={22} />
            <div>
              <strong>Purchasing package</strong>
              <span>
                Suggested orders will use this unit.
              </span>
            </div>
          </div>

          <div className="form-grid two">
            <label>
              <span>Purchase unit</span>
              <select
                value={form.purchase_unit_id}
                onChange={(event) =>
                  update(
                    "purchase_unit_id",
                    event.target.value
                  )
                }
              >
                {units.map((unit) => (
                  <option
                    value={unit.id}
                    key={unit.id}
                  >
                    {unit.name}
                    {" · 1 = "}
                    {stockNumber(
                      unit.conversion_factor
                    )}
                    {" "}
                    {suggestion.base_unit_name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>
                Minimum order quantity
                {" "}
                ({selectedUnit?.name || "unit"})
              </span>
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={form.minimum_order_quantity}
                onChange={(event) =>
                  update(
                    "minimum_order_quantity",
                    event.target.value
                  )
                }
              />
            </label>
          </div>

          <div className="reorder-unit-preview">
            <span>
              Estimated cost per
              {" "}
              {selectedUnit?.name || "unit"}
            </span>
            <strong>
              {money(
                estimatedUnitCost,
                suggestion.currency
              )}
            </strong>
          </div>
        </section>

        <label className="check-row">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) =>
              update(
                "is_active",
                event.target.checked
              )
            }
          />
          <span>
            Use this custom reorder rule
          </span>
        </label>

        {!form.preferred_supplier_id && (
          <div className="notice warning">
            A preferred supplier is required before
            Tiny POS can create a draft purchase order.
          </div>
        )}

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
            <Save size={18} />
            {busy
              ? "Saving rule..."
              : "Save reorder rule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
