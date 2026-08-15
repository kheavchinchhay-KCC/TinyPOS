import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Barcode,
  CheckSquare,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Square
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import ProductBarcode, { isValidBarcodeValue } from "../components/ProductBarcode";
import { loadCatalog, money } from "../lib/catalog";
import { printHtmlDocument } from "../lib/listDocuments";

function copiesValue(value) {
  const number = Math.floor(Number(value || 0));
  return Math.min(100, Math.max(0, number));
}

function barcodeValue(product) {
  return String(product.barcode || product.sku || "").trim();
}

export default function LabelsPage() {
  const { supabase, profile, shop, can } = useAuth();
  const canUse = can("labels.print");

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [copies, setCopies] = useState({});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState({
    width: Number(shop?.label_width_mm || 50),
    height: Number(shop?.label_height_mm || 30),
    columns: Number(shop?.label_columns || 3),
    format: shop?.label_barcode_format || "CODE128",
    showName: shop?.label_show_name !== false,
    showPrice: shop?.label_show_price !== false,
    showSku: shop?.label_show_sku !== false
  });

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) return;

    try {
      setLoading(true);
      const data = await loadCatalog(
        supabase,
        profile.organization_id,
        profile.branch_id
      );
      setProducts(data.products.filter((product) => product.is_active));
      setCategories(data.categories.filter((row) => row.is_active));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setSettings({
      width: Number(shop?.label_width_mm || 50),
      height: Number(shop?.label_height_mm || 30),
      columns: Number(shop?.label_columns || 3),
      format: shop?.label_barcode_format || "CODE128",
      showName: shop?.label_show_name !== false,
      showPrice: shop?.label_show_price !== false,
      showSku: shop?.label_show_sku !== false
    });
  }, [shop]);

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return products.filter((product) => {
      const matchesSearch =
        !needle ||
        [product.name, product.name_km, product.sku, product.barcode]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      const matchesCategory =
        category === "all" || product.category_id === category;

      return matchesSearch && matchesCategory;
    });
  }, [products, search, category]);

  const selectedLabels = useMemo(() => {
    const result = [];

    for (const product of products) {
      const count = copiesValue(copies[product.id]);
      for (let index = 0; index < count; index += 1) {
        result.push({
          ...product,
          labelKey: `${product.id}-${index}`
        });
      }
    }

    return result;
  }, [products, copies]);

  const selectedProductCount = Object.values(copies).filter(
    (value) => copiesValue(value) > 0
  ).length;

  function setProductCopies(productId, value) {
    setCopies((current) => ({
      ...current,
      [productId]: copiesValue(value)
    }));
  }

  function selectVisible() {
    setCopies((current) => {
      const next = { ...current };
      for (const product of filteredProducts) {
        if (barcodeValue(product)) next[product.id] = Math.max(1, next[product.id] || 0);
      }
      return next;
    });
  }

  function clearSelection() {
    setCopies({});
  }

  function printLabels() {
    if (selectedLabels.length === 0) {
      setMessage("Choose at least one product label before printing.");
      return;
    }

    const invalid = selectedLabels.find(
      (product) => !isValidBarcodeValue(barcodeValue(product), settings.format)
    );

    if (invalid) {
      setMessage(
        settings.format === "EAN13"
          ? `${invalid.name} does not have a valid 12 or 13 digit EAN-13 barcode.`
          : `${invalid.name} does not have a barcode or product code.`
      );
      return;
    }

    const area = document.querySelector(".label-print-area");
    if (!area) {
      setMessage("The label preview is not ready yet.");
      return;
    }

    setMessage("");
    printHtmlDocument({
      title: `${shop?.shop_name || "Tiny POS"} Price Labels`,
      html: area.outerHTML,
      page: "auto",
      fallbackClassName: "tiny-pos-label-print-root",
      preferCurrentWindow: true,
      styles: `
        body{padding:0}
        .label-print-area{
          width:100%;
          padding:0;
          display:grid;
          grid-template-columns:repeat(${Math.max(1, Number(settings.columns || 1))},${Number(settings.width || 50)}mm);
          grid-auto-rows:${Number(settings.height || 30)}mm;
          gap:0;
          justify-content:start;
          background:#fff;
          overflow:visible;
        }
        .product-print-label{
          width:${Number(settings.width || 50)}mm;
          height:${Number(settings.height || 30)}mm;
          padding:2.2mm;
          border:1px solid #999;
          background:#fff;
          color:#111;
          overflow:hidden;
          display:grid;
          grid-template-rows:auto 1fr auto;
          align-items:center;
          text-align:center;
          gap:1mm;
          break-inside:avoid;
          font-family:Arial,sans-serif;
        }
        .print-label-name{font-size:10px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .product-print-label svg{width:100%;max-width:100%;height:auto;max-height:12mm}
        .print-label-footer{display:flex;align-items:flex-end;justify-content:space-between;gap:4px;font-size:8px}
        .print-label-footer strong{font-size:12px}
      `
    });
  }

  if (!canUse) {
    return (
      <section className="panel empty-state">
        <Barcode size={46} />
        <h2>Label printing is restricted</h2>
        <p>Only an owner, admin, or manager can print product labels.</p>
      </section>
    );
  }

  return (
    <div className="page-stack labels-page">
      <div className="page-heading labels-heading">
        <div>
          <p className="eyebrow">PRODUCT TOOLS</p>
          <h1>Barcode & Price Labels</h1>
          <p className="muted">
            Select products, choose the number of copies, preview, and print.
          </p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={clearSelection}>
            Clear
          </button>
          <button className="primary-button" type="button" onClick={printLabels}>
            <Printer size={18} />
            Print {selectedLabels.length || ""} labels
          </button>
        </div>
      </div>

      {message && (
        <div className="notice error" onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      <section className="panel label-settings-panel">
        <div className="label-filter-row">
          <label className="search-box">
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search product, code, or barcode"
            />
          </label>

          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((row) => (
              <option value={row.id} key={row.id}>{row.name}</option>
            ))}
          </select>

          <button className="secondary-button" type="button" onClick={selectVisible}>
            <CheckSquare size={18} />
            Select visible
          </button>

          <button className="icon-button refresh-button" type="button" onClick={refresh}>
            <RefreshCw size={19} className={loading ? "spin" : ""} />
          </button>
        </div>

        <div className="label-option-grid">
          <label>
            <span>Barcode format</span>
            <select
              value={settings.format}
              onChange={(event) =>
                setSettings((current) => ({ ...current, format: event.target.value }))
              }
            >
              <option value="CODE128">CODE128</option>
              <option value="EAN13">EAN-13</option>
            </select>
          </label>
          <label>
            <span>Label width (mm)</span>
            <input
              type="number"
              min="20"
              max="120"
              step="1"
              value={settings.width}
              onChange={(event) =>
                setSettings((current) => ({ ...current, width: Number(event.target.value) }))
              }
            />
          </label>
          <label>
            <span>Label height (mm)</span>
            <input
              type="number"
              min="15"
              max="100"
              step="1"
              value={settings.height}
              onChange={(event) =>
                setSettings((current) => ({ ...current, height: Number(event.target.value) }))
              }
            />
          </label>
          <label>
            <span>Columns</span>
            <select
              value={settings.columns}
              onChange={(event) =>
                setSettings((current) => ({ ...current, columns: Number(event.target.value) }))
              }
            >
              {[1, 2, 3, 4, 5, 6].map((number) => (
                <option value={number} key={number}>{number}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="label-toggle-row">
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.showName}
              onChange={(event) =>
                setSettings((current) => ({ ...current, showName: event.target.checked }))
              }
            />
            Show name
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.showPrice}
              onChange={(event) =>
                setSettings((current) => ({ ...current, showPrice: event.target.checked }))
              }
            />
            Show price
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.showSku}
              onChange={(event) =>
                setSettings((current) => ({ ...current, showSku: event.target.checked }))
              }
            />
            Show product code
          </label>
        </div>
      </section>

      <div className="label-workspace">
        <section className="panel label-product-list">
          <div className="label-list-summary">
            <span>{filteredProducts.length} products</span>
            <strong>{selectedProductCount} selected</strong>
          </div>

          {loading ? (
            <div className="empty-state"><RefreshCw className="spin" /></div>
          ) : (
            <div className="label-product-rows">
              {filteredProducts.map((product) => {
                const count = copiesValue(copies[product.id]);
                const value = barcodeValue(product);
                const usable = Boolean(value);

                return (
                  <article
                    className={`label-product-row ${count > 0 ? "selected" : ""}`}
                    key={product.id}
                  >
                    <button
                      type="button"
                      className="label-select-button"
                      disabled={!usable}
                      onClick={() => setProductCopies(product.id, count > 0 ? 0 : 1)}
                      title={usable ? "Select product" : "Add a barcode or product code first"}
                    >
                      {count > 0 ? <CheckSquare size={21} /> : <Square size={21} />}
                    </button>

                    <div className="label-product-info">
                      <strong>{product.name}</strong>
                      <span>{product.sku || "No product code"} · {product.barcode || "No barcode"}</span>
                    </div>

                    <strong className="label-product-price">
                      {money(product.selling_price, product.currency)}
                    </strong>

                    <div className="copy-stepper">
                      <button
                        type="button"
                        disabled={count <= 0}
                        onClick={() => setProductCopies(product.id, count - 1)}
                      >
                        <Minus size={16} />
                      </button>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={count}
                        disabled={!usable}
                        onChange={(event) => setProductCopies(product.id, event.target.value)}
                        aria-label={`${product.name} label copies`}
                      />
                      <button
                        type="button"
                        disabled={!usable || count >= 100}
                        onClick={() => setProductCopies(product.id, count + 1)}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel label-preview-panel">
          <div className="label-preview-heading">
            <div>
              <h2>Print preview</h2>
              <p className="muted">{selectedLabels.length} labels</p>
            </div>
            <Barcode size={24} />
          </div>

          {selectedLabels.length === 0 ? (
            <div className="empty-state compact-empty">
              <Barcode size={44} />
              <p>Select products to preview labels.</p>
            </div>
          ) : (
            <div
              className="label-print-area"
              style={{
                "--label-width": `${settings.width}mm`,
                "--label-height": `${settings.height}mm`,
                "--label-columns": settings.columns
              }}
            >
              {selectedLabels.map((product) => (
                <article className="product-print-label" key={product.labelKey}>
                  {settings.showName && (
                    <strong className="print-label-name">{product.name}</strong>
                  )}

                  <ProductBarcode
                    value={barcodeValue(product)}
                    format={settings.format}
                    height={34}
                    width={1.25}
                  />

                  <div className="print-label-footer">
                    {settings.showSku && (
                      <span>{product.sku || product.barcode}</span>
                    )}
                    {settings.showPrice && (
                      <strong>{money(product.selling_price, product.currency)}</strong>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
