import { useEffect, useMemo, useState } from "react";
import { ImagePlus, Save, Trash2 } from "lucide-react";
import MediaImage from "./MediaImage";
import { MEDIA_SOURCE_LIMIT } from "../lib/media";

const emptyForm = {
  name: "",
  name_km: "",
  sku: "",
  barcode: "",
  category_id: "",
  description: "",
  unit_name: "pcs",
  selling_price: "",
  default_cost: "",
  currency: "USD",
  opening_quantity: "0",
  low_stock_threshold: "5",
  track_stock: true,
  allow_negative_stock: false,
  batch_tracking: false,
  expiry_tracking: false,
  picking_policy: "fifo",
  default_shelf_life_days: "",
  is_active: true
};

export default function ProductForm({
  product,
  categories,
  busy,
  onCancel,
  onSave
}) {
  const editing = Boolean(product?.id);
  const [form, setForm] = useState(emptyForm);
  const [imageFile, setImageFile] = useState(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setImageFile(null);
    setRemoveImage(false);
    if (!product) {
      setForm(emptyForm);
      return;
    }

    setForm({
      name: product.name || "",
      name_km: product.name_km || "",
      sku: product.sku || "",
      barcode: product.barcode || "",
      category_id: product.category_id || "",
      description: product.description || "",
      unit_name: product.unit_name || "pcs",
      selling_price: String(product.selling_price ?? ""),
      default_cost: String(product.default_cost ?? ""),
      currency: product.currency || "USD",
      opening_quantity: "0",
      low_stock_threshold: String(product.low_stock_threshold ?? 5),
      track_stock: product.track_stock,
      allow_negative_stock: product.allow_negative_stock,
      batch_tracking: Boolean(product.batch_tracking),
      expiry_tracking: Boolean(product.expiry_tracking),
      picking_policy: product.picking_policy || "fifo",
      default_shelf_life_days: String(product.default_shelf_life_days ?? ""),
      is_active: product.is_active
    });
  }, [product]);

  const preview = useMemo(() => {
    if (imageFile) return URL.createObjectURL(imageFile);
    if (!removeImage && product?.image?.secure_url) return product.image.secure_url;
    return "";
  }, [imageFile, product, removeImage]);

  useEffect(() => () => {
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
  }, [preview]);

  function chooseImage(file) {
    setError("");
    if (!file) {
      setImageFile(null);
      return;
    }
    if (!String(file.type || "").startsWith("image/")) {
      setError("Choose a valid image file.");
      return;
    }
    if (Number(file.size || 0) > MEDIA_SOURCE_LIMIT) {
      setError("The source photo must be 30 MB or smaller.");
      return;
    }
    setImageFile(file);
    setRemoveImage(false);
  }

  function setField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();

    if (!form.name.trim()) return setError("Product name is required.");
    if (!form.unit_name.trim()) return setError("Unit is required.");
    if (Number(form.selling_price || 0) < 0 || Number(form.default_cost || 0) < 0) {
      return setError("Price and cost cannot be negative.");
    }
    if (!editing && Number(form.opening_quantity || 0) < 0) {
      return setError("Opening stock cannot be negative.");
    }
    if (form.expiry_tracking && !form.batch_tracking) {
      return setError("Expiry tracking requires batch tracking.");
    }
    if (form.default_shelf_life_days && Number(form.default_shelf_life_days) <= 0) {
      return setError("Default shelf life must be greater than zero.");
    }

    try {
      await onSave({ form, imageFile, removeImage });
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  return (
    <form className="product-form" onSubmit={submit}>
      {error && <div className="notice error">{error}</div>}

      <div className="product-form-layout">
        <div className="product-fields">
          <div className="form-grid two">
            <label>
              <span>Product name *</span>
              <input value={form.name} onChange={(e) => setField("name", e.target.value)} />
            </label>
            <label>
              <span>Khmer name</span>
              <input value={form.name_km} onChange={(e) => setField("name_km", e.target.value)} />
            </label>
          </div>

          <div className="form-grid three">
            <label>
              <span>Product code</span>
              <input
                value={form.sku}
                onChange={(e) => setField("sku", e.target.value)}
                placeholder={editing ? "Product code" : "Auto: P000001"}
              />
            </label>
            <label>
              <span>Barcode</span>
              <input value={form.barcode} onChange={(e) => setField("barcode", e.target.value)} />
            </label>
            <label>
              <span>Category</span>
              <select value={form.category_id} onChange={(e) => setField("category_id", e.target.value)}>
                <option value="">No category</option>
                {categories.filter((c) => c.is_active || c.id === product?.category_id).map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-grid three">
            <label>
              <span>Selling price</span>
              <input type="number" min="0" step="0.01" value={form.selling_price} onChange={(e) => setField("selling_price", e.target.value)} />
            </label>
            <label>
              <span>Cost price</span>
              <input type="number" min="0" step="0.0001" value={form.default_cost} onChange={(e) => setField("default_cost", e.target.value)} />
            </label>
            <label>
              <span>Currency</span>
              <select value={form.currency} onChange={(e) => setField("currency", e.target.value)}>
                <option value="USD">USD</option>
                <option value="KHR">KHR</option>
              </select>
            </label>
          </div>

          <div className="form-grid three">
            <label>
              <span>Unit</span>
              <input value={form.unit_name} onChange={(e) => setField("unit_name", e.target.value)} placeholder="pcs, box, bag" />
            </label>
            {!editing && (
              <label>
                <span>Opening stock</span>
                <input type="number" min="0" step="0.001" value={form.opening_quantity} onChange={(e) => setField("opening_quantity", e.target.value)} disabled={!form.track_stock} />
              </label>
            )}
            <label>
              <span>Low-stock alert</span>
              <input type="number" min="0" step="0.001" value={form.low_stock_threshold} onChange={(e) => setField("low_stock_threshold", e.target.value)} disabled={!form.track_stock} />
            </label>
          </div>

          <label>
            <span>Description</span>
            <textarea rows="3" value={form.description} onChange={(e) => setField("description", e.target.value)} />
          </label>

          <div className="check-grid">
            <label className="check-row"><input type="checkbox" checked={form.track_stock} onChange={(e) => setField("track_stock", e.target.checked)} /><span>Track stock</span></label>
            <label className="check-row"><input type="checkbox" checked={form.allow_negative_stock} onChange={(e) => setField("allow_negative_stock", e.target.checked)} disabled={!form.track_stock || form.batch_tracking} /><span>Allow negative stock</span></label>
            <label className="check-row"><input type="checkbox" checked={form.batch_tracking} onChange={(e) => { setField("batch_tracking", e.target.checked); if (e.target.checked) setField("allow_negative_stock", false); if (!e.target.checked) setField("expiry_tracking", false); }} disabled={!form.track_stock} /><span>Track batch / lot numbers</span></label>
            <label className="check-row"><input type="checkbox" checked={form.expiry_tracking} onChange={(e) => setField("expiry_tracking", e.target.checked)} disabled={!form.batch_tracking} /><span>Track expiry dates</span></label>
            <label className="check-row"><input type="checkbox" checked={form.is_active} onChange={(e) => setField("is_active", e.target.checked)} /><span>Active product</span></label>
          </div>

          {form.batch_tracking && (
            <section className="product-batch-settings">
              <div>
                <strong>Batch picking</strong>
                <span>FIFO uses the oldest received lot. FEFO uses the nearest valid expiry date.</span>
              </div>
              <label><span>Picking policy</span><select value={form.picking_policy} onChange={(e) => setField("picking_policy", e.target.value)}><option value="fifo">FIFO · First received, first sold</option><option value="fefo">FEFO · First expiry, first sold</option></select></label>
              <label><span>Default shelf life (days)</span><input type="number" min="1" step="1" value={form.default_shelf_life_days} onChange={(e) => setField("default_shelf_life_days", e.target.value)} disabled={!form.expiry_tracking} placeholder="Optional" /></label>
            </section>
          )}
        </div>

        <aside className="image-editor">
          <span className="field-title">Primary product photo</span>
          <div className={`image-preview ${preview ? "has-image" : ""}`}>
            <MediaImage
              src={preview}
              alt="Product preview"
              width={900}
              height={700}
              crop="limit"
              gravity={null}
              quality="auto:good"
              eager
            />
          </div>
          <label className="secondary-button file-button">
            <ImagePlus size={17} /> Choose photo
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              onChange={(e) => chooseImage(e.target.files?.[0] || null)}
            />
          </label>
          {(preview || product?.image) && (
            <button type="button" className="danger-button" onClick={() => { setImageFile(null); setRemoveImage(true); }}>
              <Trash2 size={17} /> Remove photo
            </button>
          )}
          <small>Phone photos are resized before upload to a maximum of 1200 × 1200 and compressed for POS use. Source file limit: 30 MB.</small>
        </aside>
      </div>

      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>
          <Save size={18} /> {busy ? "Saving..." : editing ? "Save product" : "Create product"}
        </button>
      </div>
    </form>
  );
}
