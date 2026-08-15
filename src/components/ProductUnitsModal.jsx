import {
  Box,
  Check,
  Edit3,
  PackagePlus,
  Power,
  Save,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { money, stockNumber } from "../lib/catalog";
import {
  saveProductUnit,
  setProductUnitStatus,
  sortedProductUnits
} from "../lib/productUnits";

const emptyUnit = {
  id: "",
  name: "",
  short_name: "",
  conversion_factor: "1",
  selling_price: "",
  barcode: "",
  is_base: false,
  is_active: true,
  sort_order: "10"
};

export default function ProductUnitsModal({
  product,
  supabase,
  profile,
  busy,
  onBusyChange,
  onClose,
  onSaved
}) {
  const [form, setForm] = useState(emptyUnit);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const units = useMemo(
    () => sortedProductUnits(product),
    [product]
  );

  useEffect(() => {
    setForm(emptyUnit);
    setEditing(false);
    setMessage("");
  }, [product?.id]);

  if (!product) return null;

  function beginNew() {
    setForm({
      ...emptyUnit,
      selling_price: String(product.selling_price || 0),
      sort_order: String((units.length + 1) * 10)
    });
    setEditing(true);
    setMessage("");
  }

  function beginEdit(unit) {
    setForm({
      id: unit.id,
      name: unit.name || "",
      short_name: unit.short_name || "",
      conversion_factor: String(unit.conversion_factor || 1),
      selling_price: String(unit.selling_price || 0),
      barcode: unit.barcode || "",
      is_base: Boolean(unit.is_base),
      is_active: Boolean(unit.is_active),
      sort_order: String(unit.sort_order || 0)
    });
    setEditing(true);
    setMessage("");
  }

  function cancelEdit() {
    setForm(emptyUnit);
    setEditing(false);
  }

  function setField(name, value) {
    setForm((current) => ({
      ...current,
      [name]: value
    }));
    setMessage("");
  }

  async function submit(event) {
    event.preventDefault();

    if (!form.name.trim()) {
      setMessageType("error");
      setMessage("Unit name is required.");
      return;
    }

    const factor = Number(form.conversion_factor);
    const price = Number(form.selling_price);

    if (!Number.isFinite(factor) || factor <= 0) {
      setMessageType("error");
      setMessage("Conversion factor must be greater than zero.");
      return;
    }

    if (!Number.isFinite(price) || price < 0) {
      setMessageType("error");
      setMessage("Selling price cannot be negative.");
      return;
    }

    if (form.is_base && factor !== 1) {
      setMessageType("error");
      setMessage("The base unit must always equal 1.");
      return;
    }

    try {
      onBusyChange(true);
      await saveProductUnit(
        supabase,
        profile,
        product,
        form
      );
      setMessageType("success");
      setMessage(form.id ? "Selling unit updated." : "Selling unit added.");
      cancelEdit();
      await onSaved();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      onBusyChange(false);
    }
  }

  async function toggleStatus(unit) {
    try {
      onBusyChange(true);
      await setProductUnitStatus(
        supabase,
        profile,
        unit,
        !unit.is_active
      );
      setMessageType("success");
      setMessage(
        `${unit.name} ${unit.is_active ? "deactivated" : "activated"}.`
      );
      await onSaved();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <Modal
      title={`Selling units · ${product.name}`}
      onClose={() => !busy && onClose()}
      wide
    >
      <div className="product-units-manager">
        <section className="product-unit-explanation">
          <Box size={24} />
          <div>
            <strong>
              Base stock: {stockNumber(product.stock_quantity)}{" "}
              {product.unit_name}
            </strong>
            <span>
              Every package converts to this base unit. Example:
              1 Box = 24 {product.unit_name}.
            </span>
          </div>
        </section>

        {message && (
          <div className={`notice ${messageType}`}>
            {message}
          </div>
        )}

        <div className="product-unit-toolbar">
          <div>
            <p className="eyebrow">PACKAGING</p>
            <h3>{units.length} selling unit(s)</h3>
          </div>
          {!editing && (
            <button
              type="button"
              className="primary-button"
              onClick={beginNew}
              disabled={busy}
            >
              <PackagePlus size={18} />
              Add selling unit
            </button>
          )}
        </div>

        <div className="product-unit-list">
          {units.map((unit) => (
            <article
              className={`product-unit-card ${
                unit.is_active ? "" : "inactive"
              }`}
              key={unit.id}
            >
              <div className="product-unit-icon">
                {unit.is_base ? <Check size={20} /> : <Box size={20} />}
              </div>

              <div className="product-unit-main">
                <div>
                  <strong>{unit.name}</strong>
                  {unit.is_base && (
                    <span className="base-unit-badge">Base unit</span>
                  )}
                </div>
                <span>
                  1 {unit.name} ={" "}
                  {stockNumber(unit.conversion_factor)}{" "}
                  {product.unit_name}
                </span>
                <small>
                  Barcode: {unit.barcode || "No barcode"}
                </small>
              </div>

              <div className="product-unit-price">
                <span>Selling price</span>
                <strong>
                  {money(unit.selling_price, product.currency)}
                </strong>
              </div>

              <span
                className={`status-pill ${
                  unit.is_active ? "active" : "inactive"
                }`}
              >
                {unit.is_active ? "Active" : "Inactive"}
              </span>

              <div className="product-unit-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => beginEdit(unit)}
                  disabled={busy}
                  title="Edit unit"
                >
                  <Edit3 size={18} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => toggleStatus(unit)}
                  disabled={busy || unit.is_base}
                  title={
                    unit.is_base
                      ? "The base unit must remain active"
                      : unit.is_active
                        ? "Deactivate unit"
                        : "Activate unit"
                  }
                >
                  <Power size={18} />
                </button>
              </div>
            </article>
          ))}
        </div>

        {editing && (
          <form className="product-unit-form" onSubmit={submit}>
            <div className="panel-title-row">
              <div>
                <p className="eyebrow">
                  {form.id ? "EDIT UNIT" : "NEW UNIT"}
                </p>
                <h3>
                  {form.is_base
                    ? "Edit base unit"
                    : form.id
                      ? "Edit package"
                      : "Add package"}
                </h3>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={cancelEdit}
                disabled={busy}
              >
                <X size={19} />
              </button>
            </div>

            <div className="form-grid three">
              <label>
                <span>Unit name *</span>
                <input
                  value={form.name}
                  onChange={(event) =>
                    setField("name", event.target.value)
                  }
                  placeholder="Piece, Box, Carton"
                  autoFocus
                />
              </label>

              <label>
                <span>Short name</span>
                <input
                  value={form.short_name}
                  onChange={(event) =>
                    setField("short_name", event.target.value)
                  }
                  placeholder="pcs, box, ctn"
                />
              </label>

              <label>
                <span>
                  Base quantity in 1 {form.name || "unit"} *
                </span>
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={form.conversion_factor}
                  disabled={form.is_base}
                  onChange={(event) =>
                    setField(
                      "conversion_factor",
                      event.target.value
                    )
                  }
                />
              </label>
            </div>

            <div className="form-grid three">
              <label>
                <span>Selling price *</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.selling_price}
                  onChange={(event) =>
                    setField("selling_price", event.target.value)
                  }
                />
              </label>

              <label>
                <span>Unit barcode</span>
                <input
                  value={form.barcode}
                  onChange={(event) =>
                    setField("barcode", event.target.value)
                  }
                  placeholder="Scan or enter barcode"
                />
              </label>

              <label>
                <span>Sort order</span>
                <input
                  type="number"
                  step="1"
                  value={form.sort_order}
                  onChange={(event) =>
                    setField("sort_order", event.target.value)
                  }
                />
              </label>
            </div>

            {!form.is_base && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(event) =>
                    setField("is_active", event.target.checked)
                  }
                />
                <span>Available for new sales</span>
              </label>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={cancelEdit}
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
                {busy ? "Saving..." : "Save selling unit"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
