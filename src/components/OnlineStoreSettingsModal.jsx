import { ArrowDown, ArrowUp, ImagePlus, QrCode, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { uploadOnlineStoreMedia } from "../lib/onlineStore";
import Modal from "./Modal";

function defaults(settings, profile) {
  const fallbackSlug = String(profile?.branches?.code || profile?.branches?.name || "tiny-pos-store")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55);

  return {
    slug: settings?.slug || fallbackSlug || "tiny-pos-store",
    is_published: Boolean(settings?.is_published),
    store_title: settings?.store_title || profile?.branches?.name || "Tiny POS Online Store",
    store_description: settings?.store_description || "",
    contact_phone: settings?.contact_phone || "",
    address: settings?.address || "",
    allow_pickup: settings?.allow_pickup ?? true,
    allow_delivery: settings?.allow_delivery ?? false,
    delivery_fee_usd: settings?.delivery_fee_usd ?? 0,
    delivery_fee_khr: settings?.delivery_fee_khr ?? 0,
    minimum_order_usd: settings?.minimum_order_usd ?? 0,
    minimum_order_khr: settings?.minimum_order_khr ?? 0,
    allow_pay_at_store: settings?.allow_pay_at_store ?? true,
    allow_cash_on_delivery: settings?.allow_cash_on_delivery ?? true,
    allow_bank_transfer: settings?.allow_bank_transfer ?? false,
    bank_instructions: settings?.bank_instructions || "",
    bank_qr_url: settings?.bank_qr_url || "",
    bank_qr_public_id: settings?.bank_qr_public_id || "",
    bank_comment: settings?.bank_comment || "",
    banner_images: Array.isArray(settings?.banner_images) ? settings.banner_images : [],
    banner_interval_seconds: Number(settings?.banner_interval_seconds || 5),
    customer_message: settings?.customer_message || "",
    expected_ready_days: settings?.expected_ready_days ?? 1
  };
}

export default function OnlineStoreSettingsModal({
  open,
  settings,
  profile,
  session,
  busy,
  onClose,
  onSave
}) {
  const [values, setValues] = useState(defaults(settings, profile));
  const [uploading, setUploading] = useState("");
  const [uploadError, setUploadError] = useState("");

  useEffect(() => {
    if (open) {
      setValues(defaults(settings, profile));
      setUploadError("");
      setUploading("");
    }
  }, [open, settings, profile]);

  if (!open) return null;

  function update(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  async function uploadBanners(event) {
    const files = [...(event.target.files || [])].slice(0, Math.max(0, 12 - values.banner_images.length));
    event.target.value = "";
    if (!files.length) return;

    try {
      setUploadError("");
      setUploading("banner");
      const uploaded = [];
      for (const file of files) {
        const image = await uploadOnlineStoreMedia(session, file, "banner");
        uploaded.push({
          url: image.url,
          public_id: image.public_id,
          alt_en: "",
          alt_km: ""
        });
      }
      setValues((current) => ({
        ...current,
        banner_images: [...current.banner_images, ...uploaded].slice(0, 12)
      }));
    } catch (error) {
      setUploadError(error.message);
    } finally {
      setUploading("");
    }
  }

  async function uploadBankQr(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setUploadError("");
      setUploading("bank_qr");
      const image = await uploadOnlineStoreMedia(session, file, "bank_qr");
      setValues((current) => ({
        ...current,
        bank_qr_url: image.url,
        bank_qr_public_id: image.public_id
      }));
    } catch (error) {
      setUploadError(error.message);
    } finally {
      setUploading("");
    }
  }

  function moveBanner(index, direction) {
    setValues((current) => {
      const banners = [...current.banner_images];
      const target = index + direction;
      if (target < 0 || target >= banners.length) return current;
      [banners[index], banners[target]] = [banners[target], banners[index]];
      return { ...current, banner_images: banners };
    });
  }

  async function submit(event) {
    event.preventDefault();
    await onSave({
      ...values,
      banner_interval_seconds: Math.max(2, Math.min(30, Number(values.banner_interval_seconds || 5)))
    });
  }

  return (
    <Modal
      title="Online Store Settings"
      onClose={onClose}
      wide
      className="online-admin-modal online-settings-dialog"
      bodyClassName="online-admin-modal-body"
      closeDisabled={busy || Boolean(uploading)}
    >
      <form className="online-settings-form" onSubmit={submit}>
        <div className="online-settings-intro">
          <p className="eyebrow">PUBLIC CUSTOMER ORDERING</p>
          <p className="muted">Manage the public store, advertising pictures, fulfilment and customer payment instructions.</p>
        </div>

        {uploadError && <div className="notice error">{uploadError}</div>}

        <div className="form-grid two">
          <label>
            Store address
            <div className="store-slug-input">
              <span>/shop/</span>
              <input
                value={values.slug}
                onChange={(event) => update("slug", event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                required minLength={3} maxLength={60}
              />
            </div>
          </label>
          <label>Store title<input value={values.store_title} onChange={(event) => update("store_title", event.target.value)} required /></label>
          <label className="full">Store description<textarea rows={3} value={values.store_description} onChange={(event) => update("store_description", event.target.value)} /></label>
          <label>Customer contact phone<input value={values.contact_phone} onChange={(event) => update("contact_phone", event.target.value)} /></label>
          <label>Pickup / delivery address<input value={values.address} onChange={(event) => update("address", event.target.value)} /></label>
        </div>

        <section className="online-settings-section">
          <div className="online-settings-heading">
            <div>
              <h3>Advertising header pictures</h3>
              <p>Upload up to 12 pictures. The public store automatically scrolls through them.</p>
            </div>
            <label className="secondary-button online-upload-button">
              <ImagePlus size={18} />
              {uploading === "banner" ? "Uploading…" : "Add pictures"}
              <input type="file" accept="image/*" multiple hidden disabled={Boolean(uploading)} onChange={uploadBanners} />
            </label>
          </div>

          <label className="online-banner-duration">
            Auto-scroll duration
            <div>
              <input
                type="range" min="2" max="30" step="1"
                value={values.banner_interval_seconds}
                onChange={(event) => update("banner_interval_seconds", Number(event.target.value))}
              />
              <strong>{values.banner_interval_seconds} sec</strong>
            </div>
          </label>

          {values.banner_images.length ? (
            <div className="online-banner-editor-grid">
              {values.banner_images.map((banner, index) => (
                <article key={`${banner.public_id || banner.url}-${index}`}>
                  <img src={banner.url} alt="" />
                  <div className="online-banner-editor-actions">
                    <button type="button" className="icon-button" onClick={() => moveBanner(index, -1)} disabled={index === 0}><ArrowUp size={16} /></button>
                    <button type="button" className="icon-button" onClick={() => moveBanner(index, 1)} disabled={index === values.banner_images.length - 1}><ArrowDown size={16} /></button>
                    <button type="button" className="icon-button danger" onClick={() => update("banner_images", values.banner_images.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="online-media-empty">No advertising pictures yet. The normal store header will be used.</div>
          )}
        </section>

        <section className="online-settings-section">
          <h3>Order fulfilment</h3>
          <div className="form-grid two">
            <label className="check-row"><input type="checkbox" checked={values.allow_pickup} onChange={(event) => update("allow_pickup", event.target.checked)} />Allow branch pickup</label>
            <label className="check-row"><input type="checkbox" checked={values.allow_delivery} onChange={(event) => update("allow_delivery", event.target.checked)} />Allow delivery</label>
            <label>Delivery fee USD<input type="number" min="0" step="0.01" value={values.delivery_fee_usd} onChange={(event) => update("delivery_fee_usd", event.target.value)} /></label>
            <label>Delivery fee KHR<input type="number" min="0" step="1" value={values.delivery_fee_khr} onChange={(event) => update("delivery_fee_khr", event.target.value)} /></label>
            <label>Minimum order USD<input type="number" min="0" step="0.01" value={values.minimum_order_usd} onChange={(event) => update("minimum_order_usd", event.target.value)} /></label>
            <label>Minimum order KHR<input type="number" min="0" step="1" value={values.minimum_order_khr} onChange={(event) => update("minimum_order_khr", event.target.value)} /></label>
            <label>Expected ready time<select value={values.expected_ready_days} onChange={(event) => update("expected_ready_days", Number(event.target.value))}><option value={0}>Same day</option><option value={1}>1 day</option><option value={2}>2 days</option><option value={3}>3 days</option><option value={7}>7 days</option></select></label>
          </div>
        </section>

        <section className="online-settings-section">
          <h3>Payment choices</h3>
          <div className="form-grid two">
            <label className="check-row"><input type="checkbox" checked={values.allow_pay_at_store} onChange={(event) => update("allow_pay_at_store", event.target.checked)} />Pay at store for pickup</label>
            <label className="check-row"><input type="checkbox" checked={values.allow_cash_on_delivery} onChange={(event) => update("allow_cash_on_delivery", event.target.checked)} />Cash on delivery / pickup</label>
            <label className="check-row"><input type="checkbox" checked={values.allow_bank_transfer} onChange={(event) => update("allow_bank_transfer", event.target.checked)} />Bank transfer</label>

            <div className="online-bank-qr-editor full">
              <div className="online-bank-qr-preview">
                {values.bank_qr_url ? <img src={values.bank_qr_url} alt="Bank QR" /> : <QrCode size={44} />}
              </div>
              <div>
                <strong>Bank QR code</strong>
                <p>Customers see this QR only when they choose Bank transfer.</p>
                <div className="button-row">
                  <label className="secondary-button online-upload-button">
                    <Upload size={17} /> {uploading === "bank_qr" ? "Uploading…" : "Upload / replace QR"}
                    <input type="file" accept="image/*" hidden disabled={Boolean(uploading)} onChange={uploadBankQr} />
                  </label>
                  {values.bank_qr_url && <button type="button" className="secondary-button danger-text" onClick={() => setValues((current) => ({ ...current, bank_qr_url: "", bank_qr_public_id: "" }))}>Remove</button>}
                </div>
              </div>
            </div>

            <label className="full">Bank-transfer instructions<textarea rows={3} value={values.bank_instructions} onChange={(event) => update("bank_instructions", event.target.value)} placeholder="Account name, bank name, account number…" /></label>
            <label className="full">Comment shown beside the bank QR<textarea rows={2} value={values.bank_comment} onChange={(event) => update("bank_comment", event.target.value)} placeholder="Example: Scan the QR, pay the exact total, then upload your slip." /></label>
            <label className="full">Message shown after ordering<textarea rows={2} value={values.customer_message} onChange={(event) => update("customer_message", event.target.value)} /></label>
          </div>
        </section>

        <label className="publish-store-toggle">
          <input type="checkbox" checked={values.is_published} onChange={(event) => update("is_published", event.target.checked)} />
          <span><strong>Publish online store</strong><small>Customers can open the public link and submit orders.</small></span>
        </label>

        <div className="modal-actions online-admin-modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy || Boolean(uploading)}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy || Boolean(uploading)}>{busy ? "Saving…" : "Save online store"}</button>
        </div>
      </form>
    </Modal>
  );
}
