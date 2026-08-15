import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";

function normalizedFormat(format) {
  return String(format || "CODE128").toUpperCase() === "EAN13"
    ? "EAN13"
    : "CODE128";
}

export function isValidBarcodeValue(value, format) {
  const text = String(value || "").trim();
  if (!text) return false;

  if (normalizedFormat(format) === "EAN13") {
    return /^\d{12,13}$/.test(text);
  }

  return text.length <= 80;
}

export default function ProductBarcode({
  value,
  format = "CODE128",
  height = 42,
  width = 1.5,
  showValue = false,
  className = ""
}) {
  const ref = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ref.current) return;

    const text = String(value || "").trim();
    const barcodeFormat = normalizedFormat(format);

    if (!isValidBarcodeValue(text, barcodeFormat)) {
      setError(
        barcodeFormat === "EAN13"
          ? "EAN-13 needs 12 or 13 digits."
          : "No barcode value."
      );
      ref.current.innerHTML = "";
      return;
    }

    try {
      JsBarcode(ref.current, text, {
        format: barcodeFormat,
        displayValue: showValue,
        height,
        width,
        margin: 0,
        background: "transparent",
        lineColor: "currentColor",
        fontSize: 12
      });
      setError("");
    } catch (barcodeError) {
      ref.current.innerHTML = "";
      setError(barcodeError.message || "Barcode could not be generated.");
    }
  }, [value, format, height, width, showValue]);

  if (error) {
    return <span className={`barcode-error ${className}`}>{error}</span>;
  }

  return <svg ref={ref} className={`generated-barcode ${className}`} />;
}
