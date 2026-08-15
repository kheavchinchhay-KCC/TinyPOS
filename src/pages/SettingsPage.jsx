import { useEffect, useMemo, useState } from "react";
import { CreditCard, FileText, ReceiptText, Save, Settings2, SlidersHorizontal, Store } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { shopFormFromSettings, uploadShopLogo } from "../lib/settings";
import Modal from "../components/Modal";
import SaleInvoiceDocument from "../components/SaleInvoiceDocument";

const tabs = [
  ["shop", "Shop Identity", Store],
  ["receipt", "Receipt Center", ReceiptText],
  ["preferences", "My Preferences", SlidersHorizontal],
  ["payment", "Payment & Tax", CreditCard]
];

const emptyShop = {
  shop_name: "",
  shop_name_km: "",
  shop_phone: "",
  shop_email: "",
  shop_address: "",
  shop_address_km: "",
  tax_id: "",
  receipt_footer: "",
  receipt_footer_km: "",
  receipt_header: "",
  receipt_header_km: "",
  shop_logo_url: "",
  receipt_width_mm: 80,
  receipt_show_logo: true,
  receipt_show_address: true,
  receipt_show_phone: true,
  receipt_show_customer: true,
  receipt_show_cashier: true,
  receipt_show_barcode: true,
  receipt_logo_position: "inline",
  sale_document_type: "receipt",
  invoice_paper_size: "A5",
  invoice_title: "INVOICE",
  invoice_title_km: "វិក្កយបត្រ",
  invoice_footer: "Thank you for your purchase.",
  invoice_footer_km: "សូមអរគុណចំពោះការគាំទ្រ!",
  invoice_show_logo: true,
  invoice_show_address: true,
  invoice_show_contact: true,
  invoice_show_tax_id: true,
  invoice_show_customer: true,
  invoice_show_cashier: true,
  invoice_show_received: true,
  invoice_show_change: true,
  invoice_show_signatures: true,
  default_language: "en",
  receipt_default_language: "en",
  default_theme: "light",
  tax_percent: 0,
  usd_to_khr_rate: 4100
};

const emptyPersonal = {
  language: "en",
  theme_mode: "light",
  accent_color: "#2563eb",
  compact_mode: false,
  scanner_sound: true,
  scanner_vibration: true,
  new_sale_layout: "layout1",
  sale_product_card_scale: 1,
  sale_show_product_code: true,
  sale_stock_display: "exact"
};

const invoicePreviewReceipt = {
  invoiceNumber: "INV-MAIN-20260810-00001",
  completedAt: "2026-08-10T11:00:00+07:00",
  cashierName: "POS Staff",
  customerName: "Walk-in customer",
  currency: "USD",
  cart: [
    {
      id: "preview-1",
      name: "Coca-Cola 330ml",
      name_km: "កូកាខូឡា",
      quantity: 10,
      selected_unit_name: "can",
      selected_unit_price: 1,
      selling_price: 1,
      currency: "USD"
    }
  ],
  subtotal: 10,
  discountAmount: 0,
  taxAmount: 0,
  totalAmount: 10,
  amountReceived: 10,
  changeAmount: 0,
  paymentMethod: "cash",
  payments: [],
  exchangeRate: 4100
};


function NewSaleLayoutPreview({ active, title, description, layout }) {
  return (
    <div className={`new-sale-layout-preview ${active ? "active" : ""}`}>
      <div className={`new-sale-layout-sample ${layout}`} aria-hidden="true">
        {layout === "layout1" ? (
          <>
            <div className="sample-products-area">
              <div className="sample-toolbar-row" />
              <div className="sample-card-grid">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="sample-cart-area">
              <div className="sample-cart-head" />
              <div className="sample-cart-lines">
                <span />
                <span />
                <span />
              </div>
              <div className="sample-cart-footer" />
            </div>
          </>
        ) : (
          <>
            <div className="sample-layout2-left">
              <div className="sample-bill-wide">
                <span />
                <span />
                <span />
              </div>
              <div className="sample-products-area layout2">
                <div className="sample-toolbar-row" />
                <div className="sample-card-grid two-rows">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
            <div className="sample-layout2-right">
              <div className="sample-checkout-card" />
              <div className="sample-checkout-card tall" />
              <div className="sample-cart-footer" />
            </div>
          </>
        )}
      </div>
      <div className="new-sale-layout-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { supabase, session, shop, profile, preferences, saveShopSettings, savePreferences, loading } = useAuth();
  const { language, setLanguage } = useLanguage();
  const [tab, setTab] = useState("shop");
  const [shopForm, setShopForm] = useState(emptyShop);
  const [personal, setPersonal] = useState(emptyPersonal);
  const [message, setMessage] = useState("");
  const [savingShop, setSavingShop] = useState(false);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [receiptCenterModal, setReceiptCenterModal] = useState(null);

  useEffect(() => {
    if (shop) setShopForm({ ...emptyShop, ...shopFormFromSettings(shop), ...shop });
  }, [shop]);

  useEffect(() => {
    if (preferences) {
      setPersonal({
        ...emptyPersonal,
        ...preferences,
        language: language || preferences.language || "en",
        theme_mode: (preferences.theme || preferences.theme_mode) === "dark" ? "dark" : "light",
        accent_color: preferences.accent_color || "#2563eb",
        scanner_sound: preferences.sound_enabled ?? preferences.scanner_sound ?? true,
        new_sale_layout: preferences.new_sale_layout || "layout1",
        sale_show_product_code: preferences.sale_show_product_code !== false,
        sale_stock_display: preferences.sale_stock_display || "exact"
      });
    }
  }, [language, preferences]);

  const receiptPreviewWidth = useMemo(
    () => `${Math.max(58, Number(shopForm.receipt_width_mm || 80))}mm`,
    [shopForm.receipt_width_mm]
  );

  if (loading) return <div className="panel">Loading settings...</div>;

  function updateShop(key, value) {
    setShopForm((current) => ({ ...current, [key]: value }));
  }

  function updatePersonal(key, value) {
    setPersonal((current) => ({ ...current, [key]: value }));
  }

  function closeReceiptCenterModal() {
    if (shop) {
      setShopForm({ ...emptyShop, ...shopFormFromSettings(shop), ...shop });
    }
    setReceiptCenterModal(null);
  }

  async function persistShopForm(successMessage = "Shop settings saved.") {
    setSavingShop(true);
    setMessage("");
    try {
      await saveShopSettings(shopForm);
      setMessage(successMessage);
      return true;
    } catch (error) {
      setMessage(error.message || "Unable to save shop settings.");
      return false;
    } finally {
      setSavingShop(false);
    }
  }

  async function handleShopSave(event) {
    event.preventDefault();
    await persistShopForm();
  }

  async function handleReceiptSetupSave(event) {
    event.preventDefault();
    const saved = await persistShopForm("Receipt setup saved.");
    if (saved) setReceiptCenterModal(null);
  }

  async function handleInvoiceSetupSave(event) {
    event.preventDefault();
    const saved = await persistShopForm("Invoice setup saved.");
    if (saved) setReceiptCenterModal(null);
  }

  async function saveSaleDocumentPreference() {
    await persistShopForm(
      shopForm.sale_document_type === "invoice"
        ? "Completed sales will now open the invoice print view."
        : "Completed sales will now open the receipt print view."
    );
  }

  async function handlePersonalSave(event) {
    event.preventDefault();
    setSavingPersonal(true);
    setMessage("");
    try {
      await savePreferences({
        ...personal,
        language: personal.language || "en",
        theme: personal.theme_mode === "dark" ? "dark" : "light",
        theme_mode: personal.theme_mode === "dark" ? "dark" : "light",
        sale_product_card_scale: 1
      });

      if ((personal.language || "en") !== language) {
        setLanguage(personal.language || "en");
      }

      setMessage("Your preferences were updated.");
    } catch (error) {
      setMessage(error.message || "Unable to save preferences.");
    } finally {
      setSavingPersonal(false);
    }
  }

  async function onLogoChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    setMessage("");
    try {
      await uploadShopLogo({ supabase, session, file });
      setMessage("Logo uploaded. Reloading Tiny POS...");
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setMessage(error.message || "Unable to upload logo.");
    } finally {
      setLogoUploading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="page-stack settings-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SYSTEM</p>
          <h1>Settings</h1>
        </div>
        {message && <div className="notice info">{message}</div>}
      </div>

      <div className="settings-tabs">
        {tabs.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            <Icon size={18} /> {label}
          </button>
        ))}
      </div>

      <div className="settings-layout">
        {tab === "shop" && (
          <form className="settings-section" onSubmit={handleShopSave}>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Shop identity</h2>
                  <p>These details appear across the POS, invoices and receipts.</p>
                </div>
              </div>

              <div className="shop-identity-layout">
                <div className="shop-identity-fields">
                  <div className="shop-language-grid">
                    <section className="shop-language-block">
                      <h3>English</h3>
                      <label><span>Shop name</span><input value={shopForm.shop_name || ""} onChange={(event) => updateShop("shop_name", event.target.value)} /></label>
                      <label><span>Address</span><textarea rows="3" value={shopForm.shop_address || ""} onChange={(event) => updateShop("shop_address", event.target.value)} /></label>
                      <label><span>Receipt header</span><textarea rows="2" value={shopForm.receipt_header || ""} onChange={(event) => updateShop("receipt_header", event.target.value)} /></label>
                      <label><span>Receipt footer</span><textarea rows="2" value={shopForm.receipt_footer || ""} onChange={(event) => updateShop("receipt_footer", event.target.value)} /></label>
                    </section>

                    <section className="shop-language-block khmer-fields" data-i18n-skip>
                      <h3>ខ្មែរ</h3>
                      <label><span>ឈ្មោះហាង</span><input value={shopForm.shop_name_km || ""} onChange={(event) => updateShop("shop_name_km", event.target.value)} /></label>
                      <label><span>អាសយដ្ឋាន</span><textarea rows="3" value={shopForm.shop_address_km || ""} onChange={(event) => updateShop("shop_address_km", event.target.value)} /></label>
                      <label><span>ក្បាលបង្កាន់ដៃ</span><textarea rows="2" value={shopForm.receipt_header_km || ""} onChange={(event) => updateShop("receipt_header_km", event.target.value)} /></label>
                      <label><span>បាតបង្កាន់ដៃ</span><textarea rows="2" value={shopForm.receipt_footer_km || ""} onChange={(event) => updateShop("receipt_footer_km", event.target.value)} /></label>
                    </section>
                  </div>

                  <div className="form-grid four shop-contact-grid">
                    <label><span>Phone</span><input value={shopForm.shop_phone || ""} onChange={(event) => updateShop("shop_phone", event.target.value)} /></label>
                    <label><span>Email</span><input value={shopForm.shop_email || ""} onChange={(event) => updateShop("shop_email", event.target.value)} /></label>
                    <label><span>Tax ID</span><input value={shopForm.tax_id || ""} onChange={(event) => updateShop("tax_id", event.target.value)} /></label>
                    <label><span>Default receipt language</span><select value={shopForm.receipt_default_language || "en"} onChange={(event) => updateShop("receipt_default_language", event.target.value)}><option value="en">English</option><option value="km">Khmer</option></select></label>
                  </div>
                  <small className="field-help">Receipts open in this language by default. English / Khmer can still be switched manually on each receipt.</small>
                </div>

                <div className="shop-logo-editor">
                  <div className="shop-logo-preview">
                    {shopForm.shop_logo_url ? <img src={shopForm.shop_logo_url} alt="Shop logo" /> : <span>No logo uploaded</span>}
                  </div>
                  <label className="secondary-button" style={{ justifyContent: "center", cursor: logoUploading ? "wait" : "pointer" }}>
                    {logoUploading ? "Uploading..." : "Upload logo"}
                    <input type="file" accept="image/*" onChange={onLogoChange} hidden disabled={logoUploading} />
                  </label>
                </div>
              </div>
            </section>

            <div className="settings-save-row">
              <button type="submit" className="primary-button" disabled={savingShop || logoUploading}>
                <Save size={18} /> {savingShop ? "Saving..." : "Save shop settings"}
              </button>
            </div>
          </form>
        )}

        {tab === "receipt" && (
          <div className="settings-section receipt-center-page">
            <section className="panel receipt-center-home">
              <div className="panel-heading">
                <div>
                  <h2>Receipt Center</h2>
                  <p>Choose how receipts and invoices are configured, then choose which document opens after a completed sale.</p>
                </div>
              </div>

              <div className="receipt-center-setup-grid">
                <button
                  type="button"
                  className="receipt-center-setup-card"
                  onClick={() => setReceiptCenterModal("receipt")}
                >
                  <span className="receipt-center-setup-icon"><ReceiptText size={28} /></span>
                  <span>
                    <strong>Receipt set up</strong>
                    <small>80 mm / 58 mm receipt, logo, barcode and receipt visibility options.</small>
                  </span>
                  <Settings2 size={20} />
                </button>

                <button
                  type="button"
                  className="receipt-center-setup-card"
                  onClick={() => setReceiptCenterModal("invoice")}
                >
                  <span className="receipt-center-setup-icon"><FileText size={28} /></span>
                  <span>
                    <strong>Invoice set up</strong>
                    <small>A5 / A4 invoice layout with bilingual print view, totals, payment and signatures.</small>
                  </span>
                  <Settings2 size={20} />
                </button>
              </div>

              <footer className="receipt-center-default-document">
                <div>
                  <strong>Document after completed sale</strong>
                  <small>The New Sale buttons stay the same. Choose which document opens and prints after payment.</small>
                </div>
                <div className="receipt-center-document-choice" role="group" aria-label="Completed sale document">
                  <select
                    value={shopForm.sale_document_type || "receipt"}
                    onChange={(event) => updateShop("sale_document_type", event.target.value)}
                    className="default-print-select"
                  >
                    <option value="receipt">Receipt (80mm / 58mm)</option>
                    <option value="invoice">Invoice (A5 / A4)</option>
                    <option value="inline">Ask / Choice</option>
                  </select>
                </div>
                <button type="button" className="primary-button" onClick={saveSaleDocumentPreference} disabled={savingShop}>
                  <Save size={18} /> {savingShop ? "Saving..." : "Save preference"}
                </button>
              </footer>
            </section>

            {receiptCenterModal === "receipt" && (
              <Modal title="Receipt set up" onClose={() => !savingShop && closeReceiptCenterModal()} wide closeDisabled={savingShop}>
                <form className="receipt-center-modal-form" onSubmit={handleReceiptSetupSave}>
                  <section className="receipt-settings-layout">
                    <div className="receipt-settings-fields">
                      <div>
                        <h2>Receipt setup</h2>
                        <p>Control the default receipt width and what prints for every sale.</p>
                      </div>

                      <div className="form-grid two">
                        <label>
                          <span>Receipt width (mm)</span>
                          <input type="number" min="58" max="120" value={shopForm.receipt_width_mm || 80} onChange={(event) => updateShop("receipt_width_mm", Number(event.target.value || 80))} />
                        </label>
                        <label>
                          <span>Cashier name on receipt</span>
                          <select value={shopForm.receipt_show_cashier !== false ? "yes" : "no"} onChange={(event) => updateShop("receipt_show_cashier", event.target.value === "yes")}>
                            <option value="yes">Show</option>
                            <option value="no">Hide</option>
                          </select>
                        </label>
                        <label>
                          <span>Logo placement</span>
                          <select value={shopForm.receipt_logo_position || "inline"} onChange={(event) => updateShop("receipt_logo_position", event.target.value)}>
                            <option value="inline">Same row with store name</option>
                            <option value="above">Above store name</option>
                          </select>
                        </label>
                      </div>

                      <div className="settings-toggle-list compact-toggles">
                        {[
                          ["receipt_show_logo", "Shop logo", "Display the shop logo at the top of each receipt."],
                          ["receipt_show_address", "Shop address", "Show the shop address block."],
                          ["receipt_show_phone", "Phone and email", "Show phone number and email if available."],
                          ["receipt_show_customer", "Customer details", "Include customer name and profile details."],
                          ["receipt_show_barcode", "Invoice barcode", "Render a scannable barcode on the printed receipt."]
                        ].map(([key, title, note]) => (
                          <label key={key} className="settings-toggle">
                            <span><strong>{title}</strong><small>{note}</small></span>
                            <input type="checkbox" checked={shopForm[key] !== false} onChange={(event) => updateShop(key, event.target.checked)} />
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="receipt-settings-preview" style={{ "--receipt-preview-width": receiptPreviewWidth }}>
                      <div className={`receipt-preview-brand ${shopForm.receipt_logo_position === "above" ? "logo-above" : "logo-inline"}`}>
                        {shopForm.shop_logo_url && shopForm.receipt_show_logo !== false && <img src={shopForm.shop_logo_url} alt="Preview logo" />}
                        <b>{shopForm.receipt_default_language === "km" ? (shopForm.shop_name_km || shopForm.shop_name || "Tiny POS") : (shopForm.shop_name || "Tiny POS")}</b>
                      </div>
                      {(shopForm.receipt_default_language === "km" ? shopForm.receipt_header_km : shopForm.receipt_header) && <span>{shopForm.receipt_default_language === "km" ? shopForm.receipt_header_km : shopForm.receipt_header}</span>}
                      {shopForm.receipt_show_address !== false && <span>{shopForm.receipt_default_language === "km" ? (shopForm.shop_address_km || shopForm.shop_address || "Shop address") : (shopForm.shop_address || "Shop address")}</span>}
                      {shopForm.receipt_show_phone !== false && <span>{shopForm.shop_phone || "+855 xx xxx xxx"}</span>}
                      <hr />
                      <div>Invoice · INV-00001</div>
                      <div>Cashier · {profile?.full_name || "Cashier"}</div>
                      {shopForm.receipt_show_customer !== false && <div>Customer · Walk-in</div>}
                      <hr />
                      <div>1 × Sample product — $1.50</div>
                      <div>Subtotal — $1.50</div>
                      <div>Total — $1.50</div>
                      {shopForm.receipt_show_barcode !== false && <div>[ barcode ]</div>}
                      <hr />
                      <span>{shopForm.receipt_default_language === "km" ? (shopForm.receipt_footer_km || "សូមអរគុណសម្រាប់ការទិញ។") : (shopForm.receipt_footer || "Thank you for your purchase.")}</span>
                    </div>
                  </section>

                  <div className="modal-actions">
                    <button type="button" className="secondary-button" onClick={closeReceiptCenterModal} disabled={savingShop}>Cancel</button>
                    <button type="submit" className="primary-button" disabled={savingShop}>
                      <Save size={18} /> {savingShop ? "Saving..." : "Save receipt settings"}
                    </button>
                  </div>
                </form>
              </Modal>
            )}

            {receiptCenterModal === "invoice" && (
              <Modal title="Invoice set up" onClose={() => !savingShop && closeReceiptCenterModal()} wide closeDisabled={savingShop}>
                <form className="receipt-center-modal-form" onSubmit={handleInvoiceSetupSave}>
                  <section className="invoice-settings-layout">
                    <div className="invoice-settings-fields">
                      <div>
                        <h2>Invoice setup</h2>
                        <p>The invoice uses Shop Identity for shop name, address, phone, email and logo. It supports bilingual print view, totals, payment and signatures.</p>
                      </div>

                      <div className="form-grid two">
                        <label>
                          <span>Print paper</span>
                          <select value={shopForm.invoice_paper_size === "A4" ? "A4" : "A5"} onChange={(event) => updateShop("invoice_paper_size", event.target.value)}>
                            <option value="A5">A5</option>
                            <option value="A4">A4</option>
                          </select>
                        </label>
                        <label>
                          <span>Default print language</span>
                          <input value={shopForm.receipt_default_language === "km" ? "Khmer" : "English"} readOnly />
                        </label>
                        <label>
                          <span>Invoice title — English</span>
                          <input value={shopForm.invoice_title || "INVOICE"} onChange={(event) => updateShop("invoice_title", event.target.value)} />
                        </label>
                        <label className="khmer-fields" data-i18n-skip>
                          <span>ចំណងជើងវិក្កយបត្រ — ខ្មែរ</span>
                          <input value={shopForm.invoice_title_km || "វិក្កយបត្រ"} onChange={(event) => updateShop("invoice_title_km", event.target.value)} />
                        </label>
                        <label>
                          <span>Invoice footer — English</span>
                          <textarea rows="3" value={shopForm.invoice_footer || ""} onChange={(event) => updateShop("invoice_footer", event.target.value)} />
                        </label>
                        <label className="khmer-fields" data-i18n-skip>
                          <span>បាតវិក្កយបត្រ — ខ្មែរ</span>
                          <textarea rows="3" value={shopForm.invoice_footer_km || ""} onChange={(event) => updateShop("invoice_footer_km", event.target.value)} />
                        </label>
                      </div>

                      <div className="settings-toggle-list compact-toggles invoice-setup-toggles">
                        {[
                          ["invoice_show_logo", "Shop logo", "Show the Shop Identity logo on the top left."],
                          ["invoice_show_shop_name", "Shop / Store name", "Show shop name centered at top of invoice."],
                          ["invoice_show_address", "Shop address", "Show the selected-language address."],
                          ["invoice_show_contact", "Phone and email", "Show shop phone and email."],
                          ["invoice_show_tax_id", "Tax ID", "Show the shop tax ID when available."],
                          ["invoice_show_product_code", "Product Code / Pic Column", "Show the Code/Pic column in invoice table."],
                          ["invoice_show_customer", "Customer", "Show customer name on the invoice."],
                          ["invoice_show_cashier", "Cashier", "Show the original cashier name."],
                          ["invoice_show_received", "Received payment", "Show received/tender amounts."],
                          ["invoice_show_change", "Change", "Show customer change when applicable."],
                          ["invoice_show_signatures", "Seller / buyer signatures", "Print both signature lines at the bottom."]
                        ].map(([key, title, note]) => (
                          <label key={key} className="settings-toggle">
                            <span><strong>{title}</strong><small>{note}</small></span>
                            <input type="checkbox" checked={shopForm[key] !== false} onChange={(event) => updateShop(key, event.target.checked)} />
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="invoice-settings-preview-shell">
                      <SaleInvoiceDocument
                        receipt={{ ...invoicePreviewReceipt, exchangeRate: Number(shopForm.usd_to_khr_rate || 4100) }}
                        shop={shopForm}
                        language={shopForm.receipt_default_language === "km" ? "km" : "en"}
                      />
                    </div>
                  </section>

                  <div className="modal-actions">
                    <button type="button" className="secondary-button" onClick={closeReceiptCenterModal} disabled={savingShop}>Cancel</button>
                    <button type="submit" className="primary-button" disabled={savingShop}>
                      <Save size={18} /> {savingShop ? "Saving..." : "Save invoice settings"}
                    </button>
                  </div>
                </form>
              </Modal>
            )}
          </div>
        )}

        {tab === "preferences" && (
          <form className="settings-section" onSubmit={handlePersonalSave}>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>My preferences</h2>
                  <p>These settings are saved per user, so each staff member can keep a comfortable New Sale view.</p>
                </div>
              </div>

              <div className="form-grid three preference-appearance-grid">
                <label>
                  <span>Language</span>
                  <select value={personal.language || "en"} onChange={(event) => updatePersonal("language", event.target.value)}>
                    <option value="en">English</option>
                    <option value="km">Khmer</option>
                  </select>
                </label>
                <label>
                  <span>Theme mode</span>
                  <select value={personal.theme_mode === "dark" ? "dark" : "light"} onChange={(event) => updatePersonal("theme_mode", event.target.value)}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label className="preference-accent-field">
                  <span>Color</span>
                  <div className="preference-color-control">
                    <input
                      type="color"
                      value={personal.accent_color || "#2563eb"}
                      onChange={(event) => updatePersonal("accent_color", event.target.value)}
                      aria-label="Choose Tiny POS color"
                    />
                    <strong>{String(personal.accent_color || "#2563eb").toUpperCase()}</strong>
                  </div>
                </label>
              </div>

              <div className="settings-toggle-list">
                <label className="settings-toggle">
                  <span><strong>Compact mode</strong><small>Use a denser interface when you want to fit more content on screen.</small></span>
                  <input type="checkbox" checked={Boolean(personal.compact_mode)} onChange={(event) => updatePersonal("compact_mode", event.target.checked)} />
                </label>
                <label className="settings-toggle">
                  <span><strong>Scanner sound</strong><small>Play a sound after a successful barcode scan.</small></span>
                  <input type="checkbox" checked={personal.scanner_sound !== false} onChange={(event) => updatePersonal("scanner_sound", event.target.checked)} />
                </label>
                <label className="settings-toggle">
                  <span><strong>Scanner vibration</strong><small>Vibrate supported devices after a successful scan.</small></span>
                  <input type="checkbox" checked={personal.scanner_vibration !== false} onChange={(event) => updatePersonal("scanner_vibration", event.target.checked)} />
                </label>
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>New Sale workspace</h2>
                  <p>Choose your preferred layout and how products appear in the New Sale screen.</p>
                </div>
              </div>

              <div className="new-sale-layout-grid">
                <label className={`new-sale-layout-card ${personal.new_sale_layout === "layout1" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="new-sale-layout"
                    value="layout1"
                    checked={personal.new_sale_layout === "layout1"}
                    onChange={(event) => updatePersonal("new_sale_layout", event.target.value)}
                  />
                  <NewSaleLayoutPreview
                    active={personal.new_sale_layout === "layout1"}
                    title="Layout 1 · Classic"
                    description="Products on the left and the full bill on the right."
                    layout="layout1"
                  />
                </label>

                <label className={`new-sale-layout-card ${personal.new_sale_layout === "layout2" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="new-sale-layout"
                    value="layout2"
                    checked={personal.new_sale_layout === "layout2"}
                    onChange={(event) => updatePersonal("new_sale_layout", event.target.value)}
                  />
                  <NewSaleLayoutPreview
                    active={personal.new_sale_layout === "layout2"}
                    title="Layout 2 · Wide bill + right checkout"
                    description="Current bill above, product search below, and checkout tools on the right."
                    layout="layout2"
                  />
                </label>
              </div>

              <div className="new-sale-preference-grid">
                <label>
                  <span>Product code display</span>
                  <select value={personal.sale_show_product_code !== false ? "show" : "hide"} onChange={(event) => updatePersonal("sale_show_product_code", event.target.value === "show")}>
                    <option value="show">Show code / barcode on all devices</option>
                    <option value="hide">Hide code / barcode on all devices</option>
                  </select>
                </label>

                <label>
                  <span>Stock display style</span>
                  <select value={personal.sale_stock_display || "exact"} onChange={(event) => updatePersonal("sale_stock_display", event.target.value)}>
                    <option value="exact">Show exact units</option>
                    <option value="status">Show only In stock / Out</option>
                  </select>
                </label>
              </div>
            </section>

            <div className="settings-save-row">
              <button type="submit" className="primary-button" disabled={savingPersonal}>
                <Save size={18} /> {savingPersonal ? "Saving..." : "Save my preferences"}
              </button>
            </div>
          </form>
        )}

        {tab === "payment" && (
          <form className="settings-section" onSubmit={handleShopSave}>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Payment & tax</h2>
                  <p>Control the default rate used for USD/KHR conversion and tax calculation.</p>
                </div>
              </div>

              <div className="form-grid two">
                <label>
                  <span>Tax percent (%)</span>
                  <input type="number" min="0" max="100" step="0.01" value={shopForm.tax_percent || 0} onChange={(event) => updateShop("tax_percent", Number(event.target.value || 0))} />
                </label>
                <label>
                  <span>USD → KHR rate</span>
                  <input type="number" min="1" step="1" value={shopForm.usd_to_khr_rate || 4100} onChange={(event) => updateShop("usd_to_khr_rate", Number(event.target.value || 4100))} />
                </label>
              </div>
            </section>

            <div className="settings-save-row">
              <button type="submit" className="primary-button" disabled={savingShop}>
                <Save size={18} /> {savingShop ? "Saving..." : "Save payment settings"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
