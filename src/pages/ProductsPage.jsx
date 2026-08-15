import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Download,
  ImageOff,
  Eye,
  Pencil,
  Plus,
  PackageOpen,
  Printer,
  RefreshCw,
  Search,
  Tags
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import Modal from "../components/Modal";
import ProductForm from "../components/ProductForm";
import MediaImage from "../components/MediaImage";
import CategoryForm from "../components/CategoryForm";
import ProductUnitsModal from "../components/ProductUnitsModal";
import ProductInsightsModal from "../components/ProductInsightsModal";
import ListViewControls, { defaultListView } from "../components/ListViewControls";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import {
  createCategory,
  createProduct,
  loadCatalog,
  money,
  removePrimaryImage,
  stockNumber,
  updateCategory,
  updateProduct,
  uploadPrimaryImage
} from "../lib/catalog";
import { saveProductBatchSettings } from "../lib/batches";

export default function ProductsPage() {
  const { supabase, session, profile, can } = useAuth();
  const { language } = useLanguage();
  const canManage = can("products.manage");
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [sortOrder, setSortOrder] = useState("name_az");
  const [productModal, setProductModal] = useState(null);
  const [categoryModal, setCategoryModal] = useState(null);
  const [showCategories, setShowCategories] = useState(false);
  const [unitsProduct, setUnitsProduct] = useState(null);
  const [insightsProduct, setInsightsProduct] = useState(null);
  const [viewMode, setViewMode] = useState(defaultListView);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) return;
    try {
      setLoading(true);
      const data = await loadCatalog(supabase, profile.organization_id, profile.branch_id);
      setCategories(data.categories);
      setProducts(data.products);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile]);

  useEffect(() => { refresh(); }, [refresh]);

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products.filter((product) => {
      const matchesSearch = !needle || [
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
        .some((value) =>
          String(value).toLowerCase().includes(needle)
        );
      const matchesCategory = categoryFilter === "all" || product.category_id === categoryFilter;
      const matchesStatus = (() => {
        if (statusFilter === "all") return true;
        if (statusFilter === "active") return product.is_active;
        if (statusFilter === "inactive") return !product.is_active;
        return product.is_active && product.stock_status === statusFilter;
      })();
      return matchesSearch && matchesCategory && matchesStatus;
    }).sort((a, b) => {
      if (sortOrder === "name_za") return String(b.name || "").localeCompare(String(a.name || ""), "en", { sensitivity: "base" });
      if (sortOrder === "km_az") return String(a.name_km || a.name || "").localeCompare(String(b.name_km || b.name || ""), "km");
      if (sortOrder === "km_za") return String(b.name_km || b.name || "").localeCompare(String(a.name_km || a.name || ""), "km");
      return String(a.name || "").localeCompare(String(b.name || ""), "en", { sensitivity: "base" });
    });
  }, [products, search, categoryFilter, statusFilter, sortOrder]);

  useEffect(() => { setPage(1); }, [search, categoryFilter, statusFilter, sortOrder, pageSize]);
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedProducts = filteredProducts.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function productDisplayNames(product) {
    const englishName = String(product?.name || "").trim();
    const khmerName = String(product?.name_km || "").trim();

    if (language === "km" && khmerName) {
      return { primaryName: khmerName, secondaryName: englishName };
    }

    return {
      primaryName: englishName || khmerName || "Unnamed product",
      secondaryName: khmerName && khmerName !== englishName ? khmerName : ""
    };
  }

  function isLowStock(product) {
    return ["low_stock", "out_of_stock"].includes(product.stock_status);
  }

  function activeUnitCount(product) {
    return (product.product_units || []).filter((unit) => unit.is_active).length;
  }

  // Shared by both the card view and the table view below — previously this
  // exact block (thumbnail + primary/secondary name + code/unit line) was
  // copy-pasted in two places and had to be edited twice for any change.
  function ProductIdentityCell({ product }) {
    const { primaryName, secondaryName } = productDisplayNames(product);
    return (
      <div className="product-cell">
        <div className="product-thumb"><MediaImage src={product.image} alt={product.name} width={96} height={96} /></div>
        <div>
          <strong className="product-name-primary" title={primaryName}>{primaryName}</strong>
          {secondaryName && <span className="product-name-secondary" title={secondaryName}>{secondaryName}</span>}
          <small>{product.sku || "No code"} · {product.unit_name}</small>
        </div>
      </div>
    );
  }

  const productReportColumns = [
    { label: "Code", value: (row) => row.sku || "—" },
    { label: "Barcode", value: (row) => row.barcode || "—" },
    { label: "Product", value: (row) => row.name },
    { label: "Khmer name", value: (row) => row.name_km || "—" },
    { label: "Category", value: (row) => row.categories?.name || "Uncategorized" },
    { label: "Price", value: (row) => money(row.selling_price, row.currency) },
    { label: "Cost", value: (row) => money(row.average_cost || row.default_cost, row.currency) },
    { label: "Stock", value: (row) => row.track_stock ? `${stockNumber(row.stock_quantity)} ${row.unit_name}` : "Not tracked" },
    { label: "Low-stock threshold", value: (row) => stockNumber(row.effective_low_stock_threshold) },
    { label: "Stock status", value: (row) => String(row.stock_status || "").replaceAll("_", " ") },
    { label: "Units", value: (row) => (row.product_units || []).filter((unit) => unit.is_active).map((unit) => unit.name).join(", ") || row.unit_name },
    { label: "Product status", value: (row) => row.is_active ? "Active" : "Inactive" }
  ];

  function exportProducts() {
    exportListExcel({
      filename: `tiny-pos-products-${new Date().toISOString().slice(0, 10)}.xls`,
      title: "Products",
      subtitle: `${filteredProducts.length} product(s)`,
      summary: [
        { label: "Category", value: categoryFilter === "all" ? "All categories" : categories.find((item) => item.id === categoryFilter)?.name || "Selected category" },
        { label: "Status", value: statusFilter },
        { label: "Search", value: search || "All products" }
      ],
      columns: productReportColumns,
      rows: filteredProducts
    });
  }

  function printProducts() {
    printListDocument({
      title: "Products",
      subtitle: `${filteredProducts.length} product(s)`,
      summary: [
        { label: "Category", value: categoryFilter === "all" ? "All categories" : categories.find((item) => item.id === categoryFilter)?.name || "Selected category" },
        { label: "Status", value: statusFilter }
      ],
      columns: productReportColumns,
      rows: filteredProducts
    });
  }

  function openCategoryEditor(category = {}) {
    setShowCategories(false);
    setCategoryModal(category);
  }

  function closeCategoryEditor() {
    setCategoryModal(null);
    setShowCategories(true);
  }

  async function saveProduct({ form, imageFile, removeImage }) {
    if (!canManage) throw new Error("Your role cannot manage products.");
    setBusy(true);
    let productSaved = false;
    try {
      let productId = productModal?.id;
      let oldImage = productModal?.image || null;

      if (productModal?.id) {
        await updateProduct(supabase, productModal.id, form);
      } else {
        const created = await createProduct(supabase, form);
        productId = created.product_id;
      }
      productSaved = true;
      await saveProductBatchSettings(supabase, productId, form);

      if (removeImage && oldImage) {
        await removePrimaryImage({ supabase, session, image: oldImage });
        oldImage = null;
      }

      if (imageFile) {
        await uploadPrimaryImage({ supabase, session, profile, productId, file: imageFile });
      }

      setMessage(productModal?.id ? "Product updated successfully." : "Product created successfully.");
      setProductModal(null);
      await refresh();
    } catch (error) {
      if (productSaved) {
        setMessage(`Product saved, but the photo operation failed: ${error.message}`);
        setProductModal(null);
        await refresh();
        return;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function saveCategory(values) {
    if (!canManage) throw new Error("Your role cannot manage categories.");
    setBusy(true);
    try {
      if (categoryModal?.id) await updateCategory(supabase, categoryModal.id, values);
      else await createCategory(supabase, profile, values);
      setMessage(categoryModal?.id ? "Category updated." : "Category created.");
      setCategoryModal(null);
      setShowCategories(true);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack products-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATALOG</p>
          <h1>Products</h1>
          <p className="muted">Manage categories, product codes, barcodes, prices, opening stock and product photos.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => setShowCategories(true)}><Tags size={18} /> Categories</button>
          <button className="primary-button" onClick={() => setProductModal({})} disabled={!canManage}><Plus size={18} /> Add product</button>
        </div>
      </div>

      <div className="product-print-heading" aria-hidden="true">
        <h1>Products</h1>
        <p>{filteredProducts.length} products · {new Date().toLocaleString()}</p>
      </div>

      {message && <div className="notice success" onClick={() => setMessage("")}>{message}</div>}

      <section className="panel catalog-toolbar">
        <label className="search-box"><Search size={19} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code or barcode" /></label>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="active">Active products</option>
          <option value="low_stock">Low stock</option>
          <option value="out_of_stock">Out of stock</option>
          <option value="healthy">Healthy stock</option>
          <option value="inactive">Inactive products</option>
          <option value="all">All status</option>
        </select>
        <select className="catalog-sort-select" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} aria-label="Sort products">
          <option value="name_az">Name A–Z</option>
          <option value="name_za">Name Z–A</option>
          <option value="km_az">Khmer ក–អ</option>
          <option value="km_za">Khmer អ–ក</option>
        </select>
        <div className="catalog-action-row">
          <button className="icon-button refresh-button" onClick={exportProducts} title="Export fitted Excel"><Download size={20} /></button>
          <button className="icon-button refresh-button" onClick={printProducts} title="Print"><Printer size={20} /></button>
          <button className="icon-button refresh-button" onClick={refresh} title="Refresh"><RefreshCw size={20} /></button>
        </div>
      </section>

      <ListViewControls
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalRows={filteredProducts.length}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setPage}
      />

      <section className="panel product-list-panel">
        <div className="list-summary"><strong>{filteredProducts.length}</strong><span>products shown</span></div>
        {loading ? (
          <div className="empty-state"><RefreshCw className="spin" size={34} /><p>Loading products...</p></div>
        ) : filteredProducts.length === 0 ? (
          <div className="empty-state"><Boxes size={48} /><h2>No products found</h2><p>Add the first product or change the current filters.</p></div>
        ) : (
          viewMode === "cards" ? (
            <div className="list-card-grid product-directory-card-grid">
              {pagedProducts.map((product) => {
                const low = isLowStock(product);
                return (
                  <article className="list-record-card product-directory-card" key={product.id}>
                    <header><ProductIdentityCell product={product} /><span className={`status-pill ${product.is_active ? "active" : "inactive"}`}>{product.is_active ? "Active" : "Inactive"}</span></header>
                    <div className="list-card-fields">
                      <div><span>Barcode</span><strong>{product.barcode || "—"}</strong></div>
                      <div><span>Category</span><strong>{product.categories?.name || "Uncategorized"}</strong></div>
                      <div><span>Price</span><strong>{money(product.selling_price, product.currency)}</strong></div>
                      <div><span>Cost</span><strong>{money(product.average_cost || product.default_cost, product.currency)}</strong></div>
                      <div><span>Stock</span><strong className={low ? "stock-badge low" : "stock-badge"}>{product.track_stock ? `${stockNumber(product.stock_quantity)} ${product.unit_name}` : "Not tracked"}</strong><small>Low at {stockNumber(product.effective_low_stock_threshold)}</small></div>
                      <div><span>Units</span><strong>{activeUnitCount(product)}</strong></div>
                    </div>
                    <div className="list-card-actions product-directory-actions"><button type="button" className="secondary-button compact-button" onClick={() => setUnitsProduct(product)} disabled={!canManage}><PackageOpen size={17} /> Units</button><button type="button" className="secondary-button compact-button" onClick={() => setInsightsProduct(product)}><Eye size={17} /> View</button><button className="secondary-button compact-button" onClick={() => setProductModal(product)} disabled={!canManage}><Pencil size={17} /> Edit</button></div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="product-table-wrap wide-list-scroll">
              <table className="product-table">
                <thead><tr><th>Product</th><th>Barcode</th><th>Category</th><th>Price</th><th>Cost</th><th>Stock</th><th>Status</th><th>Units</th><th></th></tr></thead>
                <tbody>{pagedProducts.map((product) => {
                  const low = isLowStock(product);
                  return <tr key={product.id}>
                    <td data-label="Product"><ProductIdentityCell product={product} /></td>
                    <td data-label="Barcode">{product.barcode || "—"}</td>
                    <td data-label="Category">{product.categories?.name || "Uncategorized"}</td>
                    <td data-label="Price"><strong>{money(product.selling_price, product.currency)}</strong></td>
                    <td data-label="Cost">{money(product.average_cost || product.default_cost, product.currency)}</td>
                    <td data-label="Stock"><span className={low ? "stock-badge low" : "stock-badge"}>{product.track_stock ? `${stockNumber(product.stock_quantity)} ${product.unit_name}` : "Not tracked"}</span><small className="stock-threshold-note">Low at {stockNumber(product.effective_low_stock_threshold)}</small></td>
                    <td data-label="Status"><span className={`status-pill ${product.is_active ? "active" : "inactive"}`}>{product.is_active ? "Active" : "Inactive"}</span></td>
                    <td data-label="Units"><div className="product-table-unit-actions"><button type="button" className="secondary-button product-units-button" onClick={() => setUnitsProduct(product)} disabled={!canManage} title="Manage selling units"><PackageOpen size={17} />{activeUnitCount(product)}</button><button type="button" className="secondary-button compact-button product-view-button" onClick={() => setInsightsProduct(product)} title="View product history and stock summary"><Eye size={17} /> View</button></div></td>
                    <td><button className="icon-button table-action" onClick={() => setProductModal(product)} disabled={!canManage} title="Edit product"><Pencil size={18} /></button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )
        )}
      </section>

      {productModal && <Modal title={productModal.id ? "Edit product" : "Add product"} onClose={() => !busy && setProductModal(null)} wide>
        <ProductForm product={productModal.id ? productModal : null} categories={categories} busy={busy} onCancel={() => setProductModal(null)} onSave={saveProduct} />
      </Modal>}

      {categoryModal && <Modal title={categoryModal.id ? "Edit category" : "Add category"} onClose={() => !busy && closeCategoryEditor()}>
        <CategoryForm category={categoryModal.id ? categoryModal : null} busy={busy} onCancel={closeCategoryEditor} onSave={saveCategory} />
      </Modal>}

      {unitsProduct && (
        <ProductUnitsModal
          product={unitsProduct}
          supabase={supabase}
          profile={profile}
          busy={busy}
          onBusyChange={setBusy}
          onClose={() => setUnitsProduct(null)}
          onSaved={async () => {
            const refreshed = await loadCatalog(
              supabase,
              profile.organization_id,
              profile.branch_id
            );
            setCategories(refreshed.categories);
            setProducts(refreshed.products);
            const updatedProduct = refreshed.products.find(
              (item) => item.id === unitsProduct.id
            );
            setUnitsProduct(updatedProduct || null);
          }}
        />
      )}

      {insightsProduct && (
        <ProductInsightsModal
          supabase={supabase}
          product={insightsProduct}
          onClose={() => setInsightsProduct(null)}
        />
      )}

      {showCategories && <Modal title="Categories" onClose={() => setShowCategories(false)}>
        <div className="category-manager">
          <button className="primary-button" onClick={() => openCategoryEditor({})} disabled={!canManage}><Plus size={18} /> Add category</button>
          <div className="category-list">
            {categories.map((category) => <div className="category-row" key={category.id}>
              <div><strong>{category.name}</strong><small>{category.description || "No description"}</small></div>
              <span className={`status-pill ${category.is_active ? "active" : "inactive"}`}>{category.is_active ? "Active" : "Inactive"}</span>
              <button className="icon-button" onClick={() => openCategoryEditor(category)} disabled={!canManage}><Pencil size={18} /></button>
            </div>)}
          </div>
        </div>
      </Modal>}
    </div>
  );
}
