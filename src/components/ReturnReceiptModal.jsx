import { printElementDocument } from "../lib/listDocuments";
import { Languages, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import Modal from "./Modal";
import ProductBarcode from "./ProductBarcode";
import { useAuth } from "../context/AuthContext";
import { money, stockNumber } from "../lib/catalog";

function dateTime(value, locale = "en-US") {
  if (!value) return "—";

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export default function ReturnReceiptModal({ receipt, onClose }) {
  const { shop } = useAuth();
  const defaultReceiptLanguage = shop?.receipt_default_language === "km" ? "km" : "en";
  const [receiptLanguage, setReceiptLanguage] = useState(defaultReceiptLanguage);

  useEffect(() => {
    if (receipt) setReceiptLanguage(defaultReceiptLanguage);
  }, [receipt, defaultReceiptLanguage]);

  const label = (english, khmer) => receiptLanguage === "km" ? khmer : english;
  const locale = receiptLanguage === "km" ? "km-KH" : "en-US";

  if (!receipt) return null;

  const receiptWidth = Number(shop?.receipt_width_mm || 80);
  const isKhmer = receiptLanguage === "km";
  const receiptShopName = isKhmer
    ? shop?.shop_name_km || shop?.shop_name || receipt.shopName || "Tiny POS"
    : shop?.shop_name || receipt.shopName || "Tiny POS";
  const receiptHeader = isKhmer ? shop?.receipt_header_km || "" : shop?.receipt_header || "";
  const receiptAddress = isKhmer
    ? shop?.shop_address_km || shop?.shop_address || receipt.shopAddress || ""
    : shop?.shop_address || receipt.shopAddress || "";
  const receiptFooter = isKhmer
    ? shop?.receipt_footer_km || "ការសងប្រាក់ត្រូវបានដំណើរការដោយ Tiny POS"
    : shop?.receipt_footer || "Refund processed by Tiny POS";
  const logoPosition = shop?.receipt_logo_position === "above" ? "above" : "inline";
  const refundMethodText = (value) => {
    const normalized = String(value || "other").toLowerCase();
    if (!isKhmer) return normalized.toUpperCase();
    return ({ cash: "សាច់ប្រាក់", bank: "ធនាគារ", khqr: "KHQR", card: "កាត", credit: "ឥណទាន", other: "ផ្សេងៗ" })[normalized] || normalized;
  };

  return (
    <Modal title={label("Refund completed", "ការសងប្រាក់បានបញ្ចប់")} onClose={onClose} className="receipt-modal no-translate">
      <div className="receipt-wrapper">
        <div className="receipt-language-toolbar" data-print-hide>
          <Languages size={18} />
          <button type="button" className={receiptLanguage === "en" ? "active" : ""} onClick={() => setReceiptLanguage("en")}>English</button>
          <button type="button" className={receiptLanguage === "km" ? "active" : ""} onClick={() => setReceiptLanguage("km")}>ខ្មែរ</button>
        </div>
        <article
          className="receipt-document return-receipt-document"
          style={{ "--receipt-width": `${receiptWidth}mm` }}
        >
          <div className={`receipt-shop receipt-logo-${logoPosition}`}>
            <div className="receipt-brand-line">
              {shop?.receipt_show_logo !== false && shop?.shop_logo_url && (
                <img className="receipt-logo" src={shop.shop_logo_url} alt="" />
              )}
              <h2>{receiptShopName}</h2>
            </div>
            <strong>{label("RETURN / REFUND RECEIPT", "បង្កាន់ដៃសងទំនិញ / សងប្រាក់")}</strong>
            {receiptHeader && <p>{receiptHeader}</p>}
            {shop?.receipt_show_address !== false && receiptAddress && (
              <p>{receiptAddress}</p>
            )}
            {shop?.receipt_show_phone !== false && (shop?.shop_phone || receipt.shopPhone) && (
              <p>{shop?.shop_phone || receipt.shopPhone}</p>
            )}
          </div>

          <div className="receipt-meta">
            <div><span>{label("Return", "លេខសងទំនិញ")}</span><strong>{receipt.returnNumber}</strong></div>
            <div><span>{label("Original invoice", "វិក្កយបត្រដើម")}</span><strong>{receipt.invoiceNumber}</strong></div>
            <div><span>{label("Date", "កាលបរិច្ឆេទ")}</span><strong>{dateTime(receipt.processedAt, locale)}</strong></div>
            {shop?.receipt_show_cashier !== false && (
              <div><span>{label("Processed by", "ដំណើរការដោយ")}</span><strong>{receipt.processedBy}</strong></div>
            )}
            {shop?.receipt_show_customer !== false && (
              <div><span>{label("Customer", "អតិថិជន")}</span><strong>{receipt.customerName || label("Walk-in", "អតិថិជនទូទៅ")}</strong></div>
            )}
          </div>

          {shop?.receipt_show_barcode !== false && (
            <div className="receipt-invoice-barcode">
              <ProductBarcode value={receipt.returnNumber} format="CODE128" height={28} width={1.15} />
              <small>{receipt.returnNumber}</small>
            </div>
          )}

          <div className="receipt-lines">
            {(receipt.items || []).map((item) => (
              <div key={`${item.sale_item_id}-${item.product_name}`}>
                <span>
                  <strong>{isKhmer ? (item.product_name_km || item.product_name) : item.product_name}</strong>
                  <small>
                    {stockNumber(item.quantity)}{" "}
                    {item.unit_name || item.return_unit_name || "pcs"}
                    {" × "}{money(item.unit_refund, receipt.currency)}
                    {item.restock ? label(" · Restocked", " · បានបញ្ចូលស្តុកវិញ") : label(" · Not restocked", " · មិនបានបញ្ចូលស្តុកវិញ")}
                  </small>
                </span>
                <strong>-{money(item.line_refund, receipt.currency)}</strong>
              </div>
            ))}
          </div>

          <div className="receipt-totals">
            {Number(receipt.taxRefund || 0) > 0 && (
              <div><span>{label("Tax included", "ពន្ធរួមបញ្ចូល")}</span><strong>{money(receipt.taxRefund, receipt.currency)}</strong></div>
            )}
            <div className="receipt-grand-total">
              <span>{label("Total refunded", "ប្រាក់សងសរុប")}</span>
              <strong>-{money(receipt.refundAmount, receipt.currency)}</strong>
            </div>
            <div><span>{label("Refund method", "វិធីសងប្រាក់")}</span><strong>{refundMethodText(receipt.refundMethod)}</strong></div>
            {receipt.refundReference && (
              <div><span>{label("Reference", "លេខយោង")}</span><strong>{receipt.refundReference}</strong></div>
            )}
          </div>

          <div className="return-reason">
            <strong>{label("Reason", "មូលហេតុ")}</strong>
            <p>{receipt.reason}</p>
          </div>

          <div className="receipt-footer">
            {receiptFooter}
          </div>
        </article>

        <div className="receipt-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{label("Close", "បិទ")}</button>
          <button type="button" className="primary-button" onClick={() => printElementDocument({ title: "Return Receipt", selector: ".return-receipt-document", page: "auto" })}>
            <Printer size={18} /> {label("Print refund receipt", "បោះពុម្ពបង្កាន់ដៃសងប្រាក់")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
