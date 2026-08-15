import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BadgeDollarSign,
  Camera,
  ImageOff,
  CirclePause,
  FileText,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Trash2,
  Truck,
  WifiOff
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import BarcodeScanner, { primeScannerFeedback } from "../components/BarcodeScanner";
import Modal from "../components/Modal";
import MediaImage from "../components/MediaImage";
import PaymentModal from "../components/PaymentModal";
import ReceiptModal from "../components/ReceiptModal";
import QuoteSaveModal from "../components/QuoteSaveModal";
import ApprovalRequestModal from "../components/ApprovalRequestModal";
import SaleCart, { SaleCartLinesPanel, SaleCheckoutPanel } from "../components/SaleCart";
import { money, stockNumber } from "../lib/catalog";
import {
  buildSaleCartItem,
  calculateSaleTotals,
  completeSale,
  createCustomer,
  creditAccountForCustomer,
  createIdempotencyKey,
  exactSaleProductMatch,
  hydrateParkedCart,
  loadSalesWorkspace,
  previewCoupon,
  removeParkedSale,
  saleUnitForProduct,
  saveParkedSale
} from "../lib/sales";
import { getOpenCashRegisterSummary } from "../lib/cashRegister";
import {
  clearLocalSaleDraft,
  detachQuoteFromLocalSaleDraft,
  loadLocalSaleDraft,
  saveLocalSaleDraft
} from "../lib/pwa";
import {
  listOfflineSales,
  loadOfflineCheckoutBundle,
  offlineBundleExpired,
  queueOfflineSale,
  workspaceFromOfflineBundle
} from "../lib/offlineCheckout";
import {
  consumeQuoteForSale,
  effectiveQuoteStatus,
  hydrateQuoteCart,
  quoteCanConvert,
  saveSalesQuote
} from "../lib/quotes";
import {
  applyPriceCatalog,
  loadCustomerPriceCatalog
} from "../lib/priceLists";
import {
  saleApprovalPayload,
  saleDiscountApprovalRequirement
} from "../lib/permissions";
import { notifyTelegramEvent } from "../lib/telegram";
import {
  consumeDeliveryForSale,
  hydrateSalesOrderDeliveryCart
} from "../lib/salesOrders";

function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

const emptyCustomer = { customer_type: "regular", name: "", phone: "", email: "", notes: "" };

export default function SalesPage() {
  const {
    supabase,
    session,
    profile,
    shop,
    preferences,
    access,
    can
  } = useAuth();
  const { language } = useLanguage();

  const canSell = can("sales.create");
  const canDiscount = can(
    "sales.discount.apply"
  );
  const [baseProducts, setBaseProducts] = useState([]);
  const [priceCatalogs, setPriceCatalogs] = useState({
    USD: null,
    KHR: null
  });
  const [customerPricingBusy, setCustomerPricingBusy] = useState(false);
  const [customerPricingReadyFor, setCustomerPricingReadyFor] = useState("");
  const [categories, setCategories] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [parkedSales, setParkedSales] = useState([]);
  const [recentSales, setRecentSales] = useState([]);
  const [cashRegisterOpen, setCashRegisterOpen] = useState(false);
  const [bankQr, setBankQr] = useState({ url: "", comment: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [productSort, setProductSort] = useState("name_az");
  const [cart, setCart] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [discountType, setDiscountType] = useState("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerForm, setCustomerForm] = useState(emptyCustomer);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [activeParkedId, setActiveParkedId] = useState(null);
  const [activeParkLabel, setActiveParkLabel] = useState("");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [activeQuote, setActiveQuote] = useState(null);
  const [activeOrderDelivery, setActiveOrderDelivery] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [pendingPayment, setPendingPayment] = useState(null);
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey());
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [offlineBundle, setOfflineBundle] = useState(null);
  const layout2RowsStorageKey = `tiny-pos-layout2-product-rows:${session?.user?.id || "default"}`;
  const [layout2View, setLayout2View] = useState(() => {
    if (typeof window === "undefined") return { storageKey: layout2RowsStorageKey, rows: 2 };
    const stored = Number(window.localStorage.getItem(layout2RowsStorageKey) || 2);
    return {
      storageKey: layout2RowsStorageKey,
      rows: [2, 3].includes(stored) ? stored : (stored === 4 ? 3 : 2)
    };
  });
  const layout2ProductRows = layout2View.storageKey === layout2RowsStorageKey
    ? layout2View.rows
    : 2;
  const draftReadyRef = useRef(false);
  const skipDraftSaveRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = Number(window.localStorage.getItem(layout2RowsStorageKey) || 2);
    setLayout2View({
      storageKey: layout2RowsStorageKey,
      rows: [2, 3].includes(stored) ? stored : (stored === 4 ? 3 : 2)
    });
  }, [layout2RowsStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined" || layout2View.storageKey !== layout2RowsStorageKey) return;
    window.localStorage.setItem(layout2RowsStorageKey, String(layout2View.rows));
  }, [layout2RowsStorageKey, layout2View]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleQuoteDetached = (event) => {
      const quoteId = event?.detail?.quoteId;
      if (!quoteId) return;

      setActiveQuote((current) =>
        String(current?.id || "") === String(quoteId)
          ? null
          : current
      );
    };

    window.addEventListener("tiny-pos-quote-detached", handleQuoteDetached);
    return () => window.removeEventListener("tiny-pos-quote-detached", handleQuoteDetached);
  }, []);

  useEffect(() => {
    if (
      !activeQuote?.id
      || !isOnline
      || !supabase
      || !profile?.id
    ) {
      return undefined;
    }

    let cancelled = false;
    const quoteId = activeQuote.id;

    const validateQuoteLink = async () => {
      const { data, error } = await supabase
        .from("sales_quotes")
        .select("id, quote_number, status, valid_until")
        .eq("id", quoteId)
        .maybeSingle();

      if (cancelled || error) return;

      if (!data || !quoteCanConvert(data)) {
        detachQuoteFromLocalSaleDraft(profile, quoteId);
        setActiveQuote((current) =>
          String(current?.id || "") === String(quoteId)
            ? null
            : current
        );

        const status = data ? effectiveQuoteStatus(data) : "unavailable";
        setMessageType("success");
        setMessage(
          `${data?.quote_number || activeQuote.quote_number || "Quotation"} is ${status}. The quotation link was removed from this sale draft.`
        );
        return;
      }

      setActiveQuote((current) => {
        if (String(current?.id || "") !== String(quoteId)) return current;
        if (
          current?.status === data.status
          && current?.valid_until === data.valid_until
          && current?.quote_number === data.quote_number
        ) {
          return current;
        }

        return {
          ...current,
          quote_number: data.quote_number || current.quote_number,
          status: data.status,
          valid_until: data.valid_until
        };
      });
    };

    const handleFocus = () => {
      void validateQuoteLink();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void validateQuoteLink();
      }
    };

    void validateQuoteLink();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeQuote?.id, isOnline, profile?.id, profile?.organization_id, profile?.branch_id, supabase]);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) return;

    try {
      setLoading(true);

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const bundle = await loadOfflineCheckoutBundle(profile);
        if (!bundle || offlineBundleExpired(bundle)) {
          throw new Error("This device has no valid offline checkout bundle. Reconnect and prepare Offline Checkout first.");
        }
        const localSales = await listOfflineSales(profile);
        const data = workspaceFromOfflineBundle(bundle, localSales);
        setOfflineBundle(bundle);
        setPriceCatalogs({ USD: null, KHR: null });
        setBaseProducts(data.products);
        setCategories(data.categories);
        setCustomers(data.customers);
        setParkedSales([]);
        setRecentSales([]);
        setCashRegisterOpen(Boolean(bundle.settings?.cash_register_open));
        setBankQr({ url: "", comment: "" });
        return;
      }

      const [data, registerSummary] = await Promise.all([
        loadSalesWorkspace(
          supabase,
          profile.organization_id,
          profile.branch_id
        ),
        getOpenCashRegisterSummary(supabase)
      ]);

      setBaseProducts(data.products);
      setCategories(data.categories);
      setCustomers(data.customers);
      setParkedSales(data.parkedSales);
      setRecentSales(data.recentSales);
      setCashRegisterOpen(Boolean(registerSummary?.session));
      setOfflineBundle(await loadOfflineCheckoutBundle(profile));

      try {
        const { data: qrData, error: qrError } = await supabase.rpc(
          "get_pos_payment_qr"
        );
        if (qrError) throw qrError;
        setBankQr({
          url: qrData?.bank_qr_url || "",
          comment: qrData?.bank_comment || ""
        });
      } catch {
        // Bank QR is optional and must never block the sale workspace.
        setBankQr({ url: "", comment: "" });
      }
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      refresh();
    }

    function handleOffline() {
      setIsOnline(false);
      setPriceCatalogs({ USD: null, KHR: null });
      refresh();
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;

    if (
      !supabase
      || !profile?.branch_id
      || !isOnline
    ) {
      setCustomerPricingBusy(false);
      setCustomerPricingReadyFor(customerId || "");
      return undefined;
    }

    const requestedCustomerId = customerId || "";
    setCustomerPricingBusy(true);
    setCustomerPricingReadyFor("");

    (async () => {
      try {
        const [usd, khr] = await Promise.all([
          loadCustomerPriceCatalog(
            supabase,
            customerId || null,
            "USD"
          ),
          loadCustomerPriceCatalog(
            supabase,
            customerId || null,
            "KHR"
          )
        ]);

        if (!active) return;

        setPriceCatalogs({ USD: usd, KHR: khr });
        setCustomerPricingReadyFor(requestedCustomerId);
      } catch (error) {
        if (!active) return;
        setCustomerPricingReadyFor(requestedCustomerId);
      } finally {
        if (active) setCustomerPricingBusy(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    supabase,
    profile?.branch_id,
    customerId,
    isOnline
  ]);

  const products = useMemo(() => {
    const usdProducts = applyPriceCatalog(
      baseProducts.filter(
        (product) => product.currency === "USD"
      ),
      priceCatalogs.USD
    );

    const khrProducts = applyPriceCatalog(
      baseProducts.filter(
        (product) => product.currency === "KHR"
      ),
      priceCatalogs.KHR
    );

    const priced = new Map(
      [...usdProducts, ...khrProducts]
        .map((product) => [product.id, product])
    );

    return baseProducts.map(
      (product) => priced.get(product.id) || product
    );
  }, [baseProducts, priceCatalogs]);

  useEffect(() => {
    if (cart.length === 0 || activeOrderDelivery) return;

    setCart((current) =>
      current.map((item) => {
        const product = products.find(
          (row) => row.id === item.id
        );

        if (!product) return item;

        const unit = saleUnitForProduct(
          product,
          item.selected_unit_id
        );

        return {
          ...buildSaleCartItem(product, unit.id, item.cart_line_id),
          quantity: item.quantity
        };
      })
    );
  }, [priceCatalogs, baseProducts, activeOrderDelivery]);

  useEffect(() => {
    draftReadyRef.current = false;
  }, [profile?.id, profile?.branch_id]);

  useEffect(() => {
    if (
      loading ||
      draftReadyRef.current ||
      products.length === 0 ||
      !profile?.id
    ) {
      return;
    }

    draftReadyRef.current = true;

    const pendingDelivery =
      consumeDeliveryForSale(profile);

    if (pendingDelivery && cart.length === 0) {
      const hydrated =
        hydrateSalesOrderDeliveryCart(
          products,
          pendingDelivery.order,
          pendingDelivery.delivery
        );

      if (hydrated.cart.length > 0) {
        skipDraftSaveRef.current = true;
        setCart(hydrated.cart);
        setCustomerId(
          pendingDelivery.order.customer_id || ""
        );
        setCouponCode("");
        setAppliedCoupon(null);
        setDiscountType("none");
        setDiscountValue("0");
        setNotes(
          pendingDelivery.delivery.notes
          || pendingDelivery.order.notes
          || ""
        );
        setActiveParkedId(null);
        setActiveParkLabel("");
        setActiveQuote(null);
        setActiveOrderDelivery(pendingDelivery);
        setIdempotencyKey(
          createIdempotencyKey()
        );

        announce(
          "success",
          `${pendingDelivery.delivery.delivery_number} loaded from ${pendingDelivery.order.order_number}. Products, customer and quantities are locked.`
        );

        if (hydrated.missing.length > 0) {
          announce(
            "error",
            `${hydrated.missing.length} delivery item(s) are unavailable. Cancel this draft delivery and prepare it again.`
          );
        }

        return;
      }
    }

    const pendingQuote =
      consumeQuoteForSale(profile);

    if (pendingQuote && cart.length === 0) {
      const hydrated =
        hydrateQuoteCart(
          products,
          pendingQuote
        );

      if (hydrated.cart.length > 0) {
        skipDraftSaveRef.current = true;
        setCart(hydrated.cart);
        setCustomerId(
          pendingQuote.customer_id || ""
        );
        setCouponCode(
          pendingQuote.coupon_code || ""
        );
        setAppliedCoupon(null);

        if (pendingQuote.coupon_code) {
          setDiscountType("none");
          setDiscountValue("0");
        } else {
          setDiscountType(
            pendingQuote.discount_type
            || "none"
          );
          setDiscountValue(
            String(
              pendingQuote.discount_value
              || 0
            )
          );
        }

        setNotes(pendingQuote.notes || "");
        setActiveParkedId(null);
        setActiveParkLabel("");
        setActiveQuote(pendingQuote);
        setIdempotencyKey(
          createIdempotencyKey()
        );

        announce(
          pendingQuote.coupon_code
            ? "error"
            : "success",
          pendingQuote.coupon_code
            ? `${pendingQuote.quote_number} loaded. Reapply coupon ${pendingQuote.coupon_code} before saving or payment.`
            : `${pendingQuote.quote_number} loaded into New Sale.`
        );

        if (hydrated.missing.length > 0) {
          announce(
            "error",
            `${hydrated.missing.length} unavailable quotation item(s) were removed.`
          );
        }

        return;
      }
    }

    const draft = loadLocalSaleDraft(profile);
    if (!draft || cart.length > 0) return;

    const hydrated = draft.active_order_delivery
      ? hydrateSalesOrderDeliveryCart(
        products,
        draft.active_order_delivery.order,
        draft.active_order_delivery.delivery
      )
      : hydrateParkedCart(
        products,
        draft.cart || []
      );

    if (hydrated.cart.length === 0) {
      clearLocalSaleDraft(profile);
      return;
    }

    skipDraftSaveRef.current = true;
    setCart(hydrated.cart);
    setCustomerId(draft.customer_id || "");
    setCouponCode(draft.coupon_code || "");
    setAppliedCoupon(null);

    if (draft.coupon_code) {
      setDiscountType("none");
      setDiscountValue("0");
    } else {
      setDiscountType(draft.discount_type || "none");
      setDiscountValue(String(draft.discount_value || 0));
    }

    setNotes(draft.notes || "");
    setActiveParkedId(draft.active_parked_id || null);
    setActiveParkLabel(draft.active_parked_label || "");
    setActiveQuote(
      draft.active_quote_id
        ? {
          id: draft.active_quote_id,
          quote_number:
            draft.active_quote_number,
          status:
            draft.active_quote_status,
          valid_until:
            draft.active_quote_valid_until,
          terms:
            draft.active_quote_terms || ""
        }
        : null
    );
    setActiveOrderDelivery(
      draft.active_order_delivery || null
    );
    setIdempotencyKey(createIdempotencyKey());

    announce(
      draft.coupon_code ? "error" : "success",
      draft.coupon_code
        ? `Local sale draft restored. Reapply coupon ${draft.coupon_code} while online.`
        : "Local sale draft restored from this device."
    );
  }, [
    loading,
    products,
    profile,
    cart.length
  ]);

  useEffect(() => {
    if (!draftReadyRef.current || !profile?.id) {
      return;
    }

    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false;
      return;
    }

    const hasDraft =
      cart.length > 0 ||
      Boolean(customerId) ||
      Boolean(notes.trim()) ||
      discountType !== "none" ||
      Boolean(couponCode.trim()) ||
      Boolean(activeParkedId) ||
      Boolean(activeQuote?.id) ||
      Boolean(activeOrderDelivery?.delivery?.id);

    if (!hasDraft) {
      clearLocalSaleDraft(profile);
      return;
    }

    saveLocalSaleDraft(profile, {
      cart: cart.map((item) => ({
        product_id: item.id,
        product_unit_id:
          item.selected_unit_id || null,
        quantity: Number(item.quantity || 0)
      })),
      customer_id: customerId || null,
      discount_type:
        appliedCoupon ? "none" : discountType,
      discount_value:
        appliedCoupon ? 0 : Number(discountValue || 0),
      coupon_code:
        appliedCoupon?.code || couponCode.trim() || null,
      notes,
      active_parked_id: activeParkedId,
      active_parked_label: activeParkLabel,
      active_quote_id:
        activeQuote?.id || null,
      active_quote_number:
        activeQuote?.quote_number || null,
      active_quote_status:
        activeQuote?.status || null,
      active_quote_valid_until:
        activeQuote?.valid_until || null,
      active_quote_terms:
        activeQuote?.terms || null,
      active_order_delivery:
        activeOrderDelivery || null
    });
  }, [
    profile,
    cart,
    customerId,
    discountType,
    discountValue,
    couponCode,
    appliedCoupon,
    notes,
    activeParkedId,
    activeParkLabel,
    activeQuote,
    activeOrderDelivery
  ]);

  const visibleProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products.filter((product) => {
      const matchesSearch =
        !needle ||
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
          .some((value) =>
            String(value).toLowerCase().includes(needle)
          );
      const matchesCategory =
        categoryFilter === "all" || product.category_id === categoryFilter;
      return matchesSearch && matchesCategory;
    }).sort((a, b) => {
      if (productSort === "name_za") {
        return String(b.name || "").localeCompare(String(a.name || ""), "en", { sensitivity: "base" });
      }
      if (productSort === "km_az") {
        return String(a.name_km || a.name || "").localeCompare(String(b.name_km || b.name || ""), "km");
      }
      if (productSort === "km_za") {
        return String(b.name_km || b.name || "").localeCompare(String(a.name_km || a.name || ""), "km");
      }
      return String(a.name || "").localeCompare(String(b.name || ""), "en", { sensitivity: "base" });
    });
  }, [products, search, categoryFilter, productSort]);

  const currency = cart[0]?.currency || shop?.base_currency || "USD";
  const totals = useMemo(
    () => calculateSaleTotals(
      cart,
      discountType,
      discountValue,
      Number(shop?.tax_percent || 0)
    ),
    [cart, discountType, discountValue, shop]
  );

  const selectedCustomer = customers.find(
    (customer) => String(customer.id) === String(customerId)
  ) || null;
  const selectedCreditAccount = creditAccountForCustomer(
    selectedCustomer,
    currency
  );
  const saleLayoutMode = preferences?.new_sale_layout === "layout2" ? "layout2" : "layout1";
  const saleShowProductCode = preferences?.sale_show_product_code !== false;
  const saleWorkspaceStyle = {
    "--layout2-product-rows": layout2ProductRows,
    "--layout2-products-height": `${96 + layout2ProductRows * 186}px`
  };

  function cleanProductName(nameStr) {
    if (!nameStr) return "";
    return String(nameStr)
      .replace(/^(KH|Kh|kh|EN|En|en)\s*:\s*/i, "")
      .trim();
  }

  function productCardNames(product) {
    const englishName = cleanProductName(product?.name || "");
    const khmerName = cleanProductName(product?.name_km || "");

    const nameHasKhmer = /[\u1780-\u17FF]/.test(englishName);

    if (language === "km") {
      if (khmerName) {
        return {
          primaryName: khmerName,
          secondaryName: englishName && englishName !== khmerName ? englishName : ""
        };
      }
      if (nameHasKhmer) {
        return { primaryName: englishName, secondaryName: "" };
      }
    }

    if (khmerName && khmerName !== englishName) {
      return {
        primaryName: englishName || khmerName || "Unnamed product",
        secondaryName: khmerName
      };
    }

    return {
      primaryName: englishName || khmerName || "Unnamed product",
      secondaryName: ""
    };
  }

  function productCardPrice(product) {
    const unit = saleUnitForProduct(product);
    const value = Number(unit?.selling_price || 0);
    const currencyCode = String(product?.currency || "USD").toUpperCase();
    const isUsd = currencyCode === "USD";
    const amount = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: isUsd ? 2 : 0,
      maximumFractionDigits: isUsd ? 2 : 0
    }).format(value);
    const digitCount = amount.replace(/[^0-9]/g, "").length;
    const sizeClass = digitCount >= 9
      ? "price-xxl"
      : digitCount >= 7
        ? "price-xl"
        : digitCount >= 5
          ? "price-lg"
          : "price-normal";

    return {
      amount,
      symbol: isUsd ? "$" : currencyCode === "KHR" ? "៛" : currencyCode,
      isUsd,
      sizeClass
    };
  }

  function productCardStock(product) {
    const stockValue = Number(product.stock_quantity || 0);
    if (!product.track_stock) return { label: "Stock", value: "∞", out: false };

    return {
      label: "Stock",
      value: `${stockNumber(stockValue)} ${product.unit_name || ""}`.trim(),
      out: stockValue <= 0
    };
  }

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function invalidateCoupon() {
    if (!appliedCoupon) return;
    setAppliedCoupon(null);
    setDiscountType("none");
    setDiscountValue("0");
  }

  async function applyCoupon() {
    if (!isOnline) {
      announce(
        "error",
        "Reconnect before validating a coupon."
      );
      return;
    }

    if (activeOrderDelivery) {
      setQuoteOpen(false);
      announce("error", "A prepared delivery cannot be saved as a quotation.");
      return;
    }

    if (cart.length === 0) {
      announce("error", "Add a product before applying a coupon.");
      return;
    }

    if (!couponCode.trim()) {
      announce("error", "Enter a coupon code.");
      return;
    }

    try {
      setCouponBusy(true);
      const result = await previewCoupon(supabase, {
        code: couponCode,
        cart,
        customer_id: customerId,
        currency
      });

      setAppliedCoupon(result);
      setCouponCode(result.code);
      setDiscountType("fixed");
      setDiscountValue(String(result.discount_amount));
      announce(
        "success",
        `${result.code} applied: ${money(result.discount_amount, currency)} discount.`
      );
    } catch (error) {
      setAppliedCoupon(null);
      setDiscountType("none");
      setDiscountValue("0");
      announce("error", error.message);
    } finally {
      setCouponBusy(false);
    }
  }

  function removeCoupon() {
    setAppliedCoupon(null);
    setCouponCode("");
    setDiscountType("none");
    setDiscountValue("0");
  }

  function lineKey(item) {
    return item.cart_line_id || `${item.id}:${item.selected_unit_id || "base"}`;
  }

  function validateQuantity(product, unit, quantity, excludingLineIds = []) {
    const next = Number(quantity);
    if (!Number.isFinite(next) || next <= 0) {
      throw new Error("Quantity must be greater than zero.");
    }

    const factor = Number(unit?.conversion_factor || 1);
    const requestedBase = next * factor;
    const excluded = new Set(
      Array.isArray(excludingLineIds)
        ? excludingLineIds.filter(Boolean)
        : [excludingLineIds].filter(Boolean)
    );
    const otherBaseQuantity = cart
      .filter((item) =>
        item.id === product.id
        && !excluded.has(lineKey(item))
      )
      .reduce(
        (total, item) => total + (
          Number(item.quantity || 0)
          * Number(item.selected_unit_factor || 1)
        ),
        0
      );
    const totalRequestedBase = requestedBase + otherBaseQuantity;

    if (
      product.track_stock
      && !product.allow_negative_stock
      && !shop?.allow_negative_stock
      && totalRequestedBase > Number(product.stock_quantity || 0)
    ) {
      throw new Error(
        `${product.name} has only ${stockNumber(
          Number(product.stock_quantity || 0) / factor
        )} ${unit?.name || product.unit_name} available across this bill.`
      );
    }

    return next;
  }

  function addProduct(product, preferredUnitId = null, throwOnError = false) {
    try {
      if (!canSell) throw new Error("Your role cannot create sales.");
      if (activeOrderDelivery) {
        throw new Error("Products are locked for this prepared sales-order delivery.");
      }
      if (cart.length > 0 && cart[0].currency !== product.currency) {
        throw new Error(
          `This bill already uses ${cart[0].currency}. Mixed currencies are not allowed.`
        );
      }

      const unit = saleUnitForProduct(product, preferredUnitId);
      const existing = cart.find((item) =>
        item.id === product.id
        && item.selected_unit_id === unit.id
      );
      invalidateCoupon();

      if (existing) {
        const existingLineId = lineKey(existing);
        const nextQuantity = validateQuantity(
          product,
          unit,
          Number(existing.quantity || 0) + 1,
          [existingLineId]
        );
        setCart((current) => current.map((item) =>
          lineKey(item) === existingLineId
            ? { ...item, quantity: nextQuantity }
            : item
        ));
      } else {
        validateQuantity(product, unit, 1);
        setCart((current) => [
          ...current,
          buildSaleCartItem(product, unit.id)
        ]);
      }

      if (!throwOnError && preferences?.scanner_vibration) navigator.vibrate?.(55);
      setSearch("");
      announce("success", `${product.name} · ${unit.name} added to the bill.`);
      return true;
    } catch (error) {
      announce("error", error.message);
      if (throwOnError) throw error;
      return false;
    }
  }

  function changeQuantity(cartLineId, value) {
    if (activeOrderDelivery) return;
    const product = cart.find((item) => lineKey(item) === cartLineId);
    if (!product) return;

    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      invalidateCoupon();
      setCart((current) => current.filter(
        (item) => lineKey(item) !== cartLineId
      ));
      return;
    }

    try {
      const unit = saleUnitForProduct(product, product.selected_unit_id);
      const quantity = validateQuantity(product, unit, number, [cartLineId]);
      invalidateCoupon();
      setCart((current) => current.map((item) =>
        lineKey(item) === cartLineId ? { ...item, quantity } : item
      ));
    } catch (error) {
      announce("error", error.message);
    }
  }

  function changeUnit(cartLineId, unitId) {
    if (activeOrderDelivery) return;
    const product = cart.find((item) => lineKey(item) === cartLineId);
    if (!product) return;

    try {
      const unit = saleUnitForProduct(product, unitId);
      const duplicate = cart.find((item) =>
        item.id === product.id
        && item.selected_unit_id === unit.id
        && lineKey(item) !== cartLineId
      );
      const nextQuantity = Number(product.quantity || 1)
        + Number(duplicate?.quantity || 0);
      validateQuantity(
        product,
        unit,
        nextQuantity,
        duplicate
          ? [cartLineId, lineKey(duplicate)]
          : [cartLineId]
      );
      invalidateCoupon();

      if (duplicate) {
        const duplicateLineId = lineKey(duplicate);
        setCart((current) => current
          .filter((item) => lineKey(item) !== cartLineId)
          .map((item) =>
            lineKey(item) === duplicateLineId
              ? { ...item, quantity: nextQuantity }
              : item
          ));
      } else {
        setCart((current) => current.map((item) =>
          lineKey(item) === cartLineId
            ? {
              ...buildSaleCartItem(product, unit.id, product.cart_line_id),
              quantity: Number(product.quantity || 1)
            }
            : item
        ));
      }

      announce("success", `${product.name} unit changed to ${unit.name}.`);
    } catch (error) {
      announce("error", error.message);
    }
  }

  function clearSale() {
    setCart([]);
    setCustomerId("");
    setDiscountType("none");
    setDiscountValue("0");
    setCouponCode("");
    setAppliedCoupon(null);
    setNotes("");
    setActiveParkedId(null);
    setActiveParkLabel("");
    setActiveQuote(null);
    setActiveOrderDelivery(null);
    setIdempotencyKey(createIdempotencyKey());
    clearLocalSaleDraft(profile);
  }

  function handleScan(code) {
    if (activeOrderDelivery) {
      const error = new Error("Scanning is disabled for a prepared delivery.");
      announce("error", error.message);
      throw error;
    }
    const match = exactSaleProductMatch(products, code);
    if (!match) {
      const error = new Error(`No active product or package matches ${code}.`);
      announce("error", error.message);
      throw error;
    }
    return addProduct(match.product, match.unit?.id || null, true);
  }

  function submitSearch(event) {
    event.preventDefault();
    const match = exactSaleProductMatch(products, search);
    if (match) addProduct(match.product, match.unit?.id || null);
  }

  async function handlePark() {
    if (!isOnline) {
      announce(
        "error",
        "The sale draft is saved on this device. Reconnect before parking it on the server."
      );
      return;
    }

    if (cart.length === 0) return;
    if (activeOrderDelivery) {
      announce("error", "A prepared sales-order delivery cannot be parked.");
      return;
    }

    try {
      setBusy(true);
      const label = activeParkLabel || `Parked ${new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit"
      }).format(new Date())}`;

      const saved = await saveParkedSale(supabase, profile, {
        parked_id: activeParkedId,
        label,
        customer_id: customerId,
        currency,
        cart,
        discount_type: appliedCoupon ? "none" : discountType,
        discount_value: appliedCoupon ? 0 : discountValue,
        coupon_code: appliedCoupon?.code || null,
        notes
      });

      announce("success", `${saved.label || "Sale"} parked successfully.`);
      clearSale();
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  function resumeParked(parked) {
    const hydrated = hydrateParkedCart(products, parked.cart);
    if (hydrated.cart.length === 0) {
      announce("error", "This parked sale has no products that are currently available.");
      return;
    }

    setCart(hydrated.cart);
    setCustomerId(parked.customer_id || "");
    setCouponCode(parked.coupon_code || "");
    setAppliedCoupon(null);
    if (parked.coupon_code) {
      setDiscountType("none");
      setDiscountValue("0");
    } else {
      setDiscountType(parked.discount_type || "none");
      setDiscountValue(String(parked.discount_value || 0));
    }
    setNotes(parked.notes || "");
    setActiveParkedId(parked.id);
    setActiveParkLabel(parked.label || "Parked sale");
    setActiveQuote(null);
    setActiveOrderDelivery(null);
    setIdempotencyKey(createIdempotencyKey());
    setParkedOpen(false);

    if (hydrated.missing.length > 0) {
      announce("error", `${hydrated.missing.length} unavailable product(s) were removed from this parked sale.`);
    } else {
      announce(
        parked.coupon_code ? "error" : "success",
        parked.coupon_code
          ? `${parked.label || "Parked sale"} resumed. Reapply coupon ${parked.coupon_code}.`
          : `${parked.label || "Parked sale"} resumed.`
      );
    }
  }

  async function deleteParked(parkedId) {
    try {
      setBusy(true);
      await removeParkedSale(supabase, parkedId);
      if (activeParkedId === parkedId) clearSale();
      announce("success", "Parked sale deleted.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveCustomer(event) {
    event.preventDefault();

    if (!isOnline) {
      announce(
        "error",
        "Reconnect before creating a customer."
      );
      return;
    }
    if (!customerForm.name.trim()) {
      announce("error", "Customer name is required.");
      return;
    }

    try {
      setBusy(true);
      const customer = await createCustomer(supabase, profile, customerForm);
      setCustomers((current) =>
        [...current, customer].sort((a, b) => a.name.localeCompare(b.name))
      );
      invalidateCoupon();
      setCustomerId(customer.id);
      setCustomerOpen(false);
      setCustomerForm(emptyCustomer);
      announce("success", `${customer.name} added as the customer.`);
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleQuoteSave(values) {
    if (!isOnline) {
      setQuoteOpen(false);
      announce(
        "error",
        "Reconnect before saving a quotation."
      );
      return;
    }

    if (cart.length === 0) {
      announce(
        "error",
        "Add at least one product before saving a quotation."
      );
      return;
    }

    try {
      setBusy(true);

      const result = await saveSalesQuote(
        supabase,
        {
          quote_id:
            activeQuote?.id || null,
          cart,
          customer_id: customerId,
          discount_type: discountType,
          discount_value: discountValue,
          coupon_code: couponCode,
          applied_coupon: appliedCoupon,
          currency,
          valid_until:
            values.valid_until,
          notes,
          terms: values.terms,
          status: values.status
        }
      );

      setQuoteOpen(false);

      // A saved quotation is a finished document, not an active sale draft.
      // Clear every sale-only field so the cashier immediately receives a
      // fresh New Sale board instead of accidentally converting/editing the
      // quotation on the next transaction.
      clearSale();

      announce(
        "success",
        `${result.quote_number} saved for ${money(
          result.total_amount,
          result.currency
        )}. New sale is ready.`
      );

      await refresh();
    } catch (error) {
      announce("error", error.message);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function openPayment() {
    if (!isOnline) {
      announce(
        "error",
        "Reconnect before completing payment."
      );
      return;
    }

    if (customerId && !selectedCustomer) {
      announce("error", "The selected customer is no longer available. Refresh customers before payment.");
      return;
    }

    setPaymentOpen(true);
  }

  async function handlePayment(
    payment,
    approvalRequestId = null
  ) {
    if (!isOnline) {
      try {
        if (!offlineBundle || offlineBundleExpired(offlineBundle)) {
          throw new Error("Offline Checkout is not prepared or has expired on this device.");
        }
        if (activeOrderDelivery || activeQuote || activeParkedId) {
          throw new Error("Sales Orders, quotations and parked sales must be completed online.");
        }
        if (appliedCoupon || couponCode.trim() || discountType !== "none" || Number(discountValue || 0) > 0) {
          throw new Error("Coupons and manual discounts are online-only.");
        }
        if (payment.payment_method === "credit") {
          throw new Error("Customer credit sales are online-only.");
        }
        if (payment.payment_method === "cash" && !offlineBundle.settings?.cash_register_open) {
          throw new Error("Cash was not enabled when this offline bundle was prepared.");
        }

        setBusy(true);
        const queued = await queueOfflineSale(profile, offlineBundle, {
          items: cart.map((item) => ({
            product_id: item.id,
            product_unit_id: item.selected_unit_id || null,
            quantity: Number(item.quantity || 0)
          })),
          customer_id: customerId || null,
          currency,
          payment_method: payment.payment_method,
          amount_received: Number(payment.amount_received || 0),
          payment_reference: payment.payment_reference || null,
          notes,
          subtotal: totals.subtotal,
          tax_amount: totals.taxAmount,
          total_amount: totals.total
        });

        setReceipt({
          invoiceNumber: queued.local_receipt_number,
          completedAt: queued.offline_created_at,
          shopName: shop?.shop_name || "Tiny POS",
          shopPhone: shop?.shop_phone,
          shopAddress: shop?.shop_address,
          footer: `${shop?.receipt_footer || ""} · Pending server synchronization`,
          cashierName: profile?.full_name || profile?.email?.split("@")[0] || "POS Staff",
          customerName: selectedCustomer?.name,
          customerCode: selectedCustomer?.customer_code,
          customerType: selectedCustomer?.customer_type,
          cart: cart.map((item) => ({ ...item })),
          subtotal: totals.subtotal,
          discountAmount: 0,
          taxAmount: totals.taxAmount,
          totalAmount: totals.total,
          amountReceived: Number(payment.amount_received || 0),
          changeAmount: Math.max(0, Number(payment.amount_received || 0) - Number(totals.total || 0)),
          paymentMethod: payment.payment_method,
          payments: payment.payments || [],
          exchangeRate: Number(shop?.usd_to_khr_rate || 4100),
          priceListName: "Offline snapshot",
          currency,
          offlinePending: true,
          offlineSaleId: queued.offline_sale_id
        });

        setPaymentOpen(false);
        clearSale();
        await refresh();
        announce("success", `${queued.local_receipt_number} saved safely on this device. Synchronize when online.`);
      } catch (error) {
        setPaymentOpen(false);
        announce("error", error.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    const saleValues = {
      cart,
      customer_id: customerId,
      discount_type:
        activeOrderDelivery ? "none" : discountType,
      discount_value:
        activeOrderDelivery
          ? 0
          : appliedCoupon ? 0 : discountValue,
      coupon_code:
        activeOrderDelivery
          ? null
          : appliedCoupon?.code || null,
      tax_amount: totals.taxAmount,
      currency,
      notes,
      idempotency_key: idempotencyKey,
      source_quote_id:
        activeOrderDelivery
          ? null
          : activeQuote?.id || null,
      source_sales_order_delivery_id:
        activeOrderDelivery?.delivery?.id || null,
      ...payment
    };

    if (
      !appliedCoupon
      && discountType !== "none"
      && Number(discountValue || 0) > 0
      && !canDiscount
    ) {
      setPaymentOpen(false);
      announce(
        "error",
        "Your account cannot apply a manual discount."
      );
      return;
    }

    const approvalNeed = activeOrderDelivery
      ? { required: false, discountAmount: 0 }
      : saleDiscountApprovalRequirement(
        access,
        {
          discount_type: discountType,
          discount_value:
            appliedCoupon
              ? 0
              : discountValue,
          discount_amount:
            appliedCoupon
              ? 0
              : totals.discountAmount,
          applied_coupon:
            appliedCoupon,
          currency
        }
      );

    if (
      approvalNeed.required
      && !approvalRequestId
    ) {
      setPaymentOpen(false);
      setPendingPayment(payment);

      const payload =
        saleApprovalPayload(
          saleValues
        );

      setApprovalRequest({
        permission_key:
          "sales.discount.exceed_limit",
        action_type:
          "sale_discount",
        action_label:
          "Sale discount above limit",
        payload,
        summary: [
          `Approve ${money(
            approvalNeed.discountAmount,
            currency
          )} discount`,
          selectedCustomer?.name
          || "Walk-in customer",
          `${cart.length} product line${cart.length === 1 ? "" : "s"
          }`
        ].join(" · "),
        amount:
          approvalNeed.discountAmount,
        currency
      });

      announce(
        "error",
        "This discount exceeds your individual limit. Manager approval is required."
      );
      return;
    }

    try {
      setBusy(true);

      const result = await completeSale(
        supabase,
        {
          ...saleValues,
          approval_request_id:
            approvalRequestId
        }
      );

      void notifyTelegramEvent(
        session,
        "sale_completed",
        result.sale_id
      );

      if (activeParkedId) {
        await removeParkedSale(supabase, activeParkedId);
      }

      const completedAt = new Date().toISOString();
      setReceipt({
        invoiceNumber: result.invoice_number,
        completedAt,
        shopName: shop?.shop_name || "Tiny POS",
        shopPhone: shop?.shop_phone,
        shopAddress: shop?.shop_address,
        footer: shop?.receipt_footer,
        cashierName: profile?.full_name || profile?.email?.split("@")[0] || "POS Staff",
        customerName: selectedCustomer?.name,
        customerCode: selectedCustomer?.customer_code,
        customerType: selectedCustomer?.customer_type,
        couponCode: result.coupon_code || appliedCoupon?.code || null,
        couponName: result.coupon_name || appliedCoupon?.name || null,
        cart: cart.map((item) => ({ ...item })),
        subtotal: Number(result.subtotal ?? totals.subtotal),
        discountAmount: Number(result.discount_amount ?? totals.discountAmount),
        taxAmount: Number(result.tax_amount ?? totals.taxAmount),
        totalAmount: Number(result.total_amount ?? totals.total),
        amountReceived: Number(
          result.amount_received
          ?? payment.amount_received
          ?? 0
        ),
        changeAmount: Number(result.change_amount || 0),
        paymentMethod: result.payment_method || payment.payment_method,
        payments: Array.isArray(result.payments)
          ? result.payments
          : (payment.payments || []),
        exchangeRate: Number(
          result.exchange_rate
          || shop?.usd_to_khr_rate
          || 4100
        ),
        priceListName:
          result.price_list_name
          || priceCatalogs[currency]?.price_list_name
          || null,
        priceAdjustmentAmount: Number(
          result.price_adjustment_amount || 0
        ),
        sourceQuoteNumber:
          result.source_quote_number
          || activeQuote?.quote_number
          || null,
        sourceSalesOrderNumber:
          result.source_sales_order_number
          || activeOrderDelivery?.order?.order_number
          || null,
        sourceDeliveryNumber:
          result.source_delivery_number
          || activeOrderDelivery?.delivery?.delivery_number
          || null,
        creditDueDate: result.credit_due_date || null,
        creditAmount: Number(result.credit_amount || 0),
        creditBalanceAfter: Number(
          result.credit_balance_after || 0
        ),
        currency
      });

      setPaymentOpen(false);
      setApprovalRequest(null);
      setPendingPayment(null);
      clearSale();
      announce(
        "success",
        `${result.invoice_number} completed for ${money(result.total_amount, currency)}.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack sales-page">
      <div className="sale-compact-heading">
        <div>
          <p className="eyebrow">POINT OF SALE</p>
          <h1>New Sale</h1>
        </div>

        {message && (
          <div
            className={`notice ${messageType} sale-heading-notice`}
            onClick={() => setMessage("")}
          >
            {message}
          </div>
        )}
      </div>

      {!cashRegisterOpen && (
        <div className="notice warning cash-register-sale-warning">
          <span>
            Cash payments are disabled because this branch has no open
            register.
          </span>
          <Link to="/cash-register">Open cash register</Link>
        </div>
      )}

      {!isOnline && (
        <div className="notice warning offline-sale-warning">
          <WifiOff size={20} />
          <span>
            Offline checkout: cached products and customers are available. Payments create a pending-sync receipt on this device. Coupons, discounts, credit, new customers, quotations and Sales Order deliveries remain online-only.
          </span>
        </div>
      )}

      {activeOrderDelivery && (
        <div className="notice info active-order-delivery-banner">
          <Truck size={20} />
          <span>
            Delivering <strong>{activeOrderDelivery.delivery.delivery_number}</strong>
            {" · "}
            Sales Order <strong>{activeOrderDelivery.order.order_number}</strong>
            {" · Products and customer are locked"}
          </span>
          <Link to="/sales-orders">
            Open Sales Orders
          </Link>
        </div>
      )}

      {activeQuote && (
        <div className="notice info active-quote-sale-banner">
          <FileText size={20} />
          <span>
            Working from quotation{" "}
            <strong>
              {activeQuote.quote_number}
            </strong>
            {activeQuote.valid_until
              ? ` · Valid until ${activeQuote.valid_until}`
              : ""}
          </span>
          <Link to="/quotes">
            Open quotations
          </Link>
        </div>
      )}

      {priceCatalogs[currency]?.price_list_name && (
        <div className="notice success active-price-list-banner">
          <BadgeDollarSign size={20} />
          <span>
            Active price list:{" "}
            <strong>
              {priceCatalogs[currency].price_list_name}
            </strong>
            {selectedCustomer
              ? ` · ${selectedCustomer.name}`
              : " · Walk-in customer"}
          </span>
          {can("price_lists.manage") && (
            <Link to="/price-lists">
              Manage prices
            </Link>
          )}
        </div>
      )}

      <div className={`sale-layout ${saleLayoutMode === "layout2" ? "sale-layout-alt" : ""}`} style={saleWorkspaceStyle}>
        {saleLayoutMode === "layout2" ? (
          <>
            <div className="sale-layout-alt-main">
              <SaleCartLinesPanel
                cart={cart}
                onQuantityChange={changeQuantity}
                onUnitChange={changeUnit}
                onRemove={(cartLineId) => {
                  invalidateCoupon();
                  setCart((current) => current.filter((item) =>
                    lineKey(item) !== cartLineId
                  ));
                }}
                onClear={clearSale}
                parkedCount={parkedSales.length}
                onOpenParked={() => setParkedOpen(true)}
                online={isOnline}
                activeParkLabel={activeParkLabel}
                activeQuoteNumber={activeQuote?.quote_number || ""}
                fulfillmentLocked={Boolean(activeOrderDelivery)}
                fulfillmentLabel={
                  activeOrderDelivery
                    ? `${activeOrderDelivery.delivery.delivery_number} · ${activeOrderDelivery.order.order_number}`
                    : ""
                }
              />

              <section className="sale-products-panel panel layout-two-products-panel">
                <form className="sale-toolbar" onSubmit={submitSearch}>
                  <label className="search-box sale-product-search">
                    <Search size={19} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search product, name, code or barcode"
                    />
                  </label>

                  <button
                    type="button"
                    className="primary-button sale-scan-button"
                    onClick={async () => {
                      await primeScannerFeedback();
                      setScannerOpen(true);
                    }}
                    disabled={!canSell || Boolean(activeOrderDelivery)}
                  >
                    <Camera size={18} /> Scan
                  </button>

                  <select
                    className="sale-category-select"
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                    aria-label="Filter products by category"
                  >
                    <option value="all">All categories</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>

                  <label className="sale-sort-select">
                    <select
                      value={productSort}
                      onChange={(event) => setProductSort(event.target.value)}
                      aria-label="Sort products"
                    >
                      <option value="name_az">A–Z</option>
                      <option value="name_za">Z–A</option>
                      <option value="km_az">ក–អ</option>
                      <option value="km_za">អ–ក</option>
                    </select>
                  </label>
                </form>

                <div className="sale-product-summary">
                  <span><strong>{visibleProducts.length}</strong> products available</span>
                  <div className="sale-summary-actions">
                    <small>Tap a product to add one unit.</small>
                    <label className="layout-two-row-control" title="Choose how many product rows are visible before scrolling">
                      <span>Default view</span>
                      <select
                        value={layout2ProductRows}
                        onChange={(event) => setLayout2View({ storageKey: layout2RowsStorageKey, rows: Number(event.target.value) })}
                        aria-label="Layout 2 product rows"
                      >
                        <option value={2}>2 rows</option>
                        <option value={3}>3 rows</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="icon-button refresh-button"
                      onClick={refresh}
                      title="Refresh products"
                    >
                      <RefreshCw className={loading ? "spin" : ""} size={19} />
                    </button>
                  </div>
                </div>

                {loading ? (
                  <div className="empty-state"><RefreshCw className="spin" size={34} /><p>Loading products...</p></div>
                ) : visibleProducts.length === 0 ? (
                  <div className="empty-state"><ShoppingCart size={46} /><h2>No sale products found</h2><p>Change the filters or add stock first.</p></div>
                ) : (
                  <div className="sale-products-grid layout-two-grid">
                    {visibleProducts.map((product) => {
                      const outOfStock = product.track_stock && Number(product.stock_quantity) <= 0;
                      return (
                        <button
                          type="button"
                          className="sale-product-card"
                          key={product.id}
                          onClick={() => addProduct(product)}
                          disabled={Boolean(activeOrderDelivery) || (outOfStock && !product.allow_negative_stock && !shop?.allow_negative_stock)}
                        >
                          <div className="sale-product-image">
                            <MediaImage
                              src={product.image}
                              alt={product.name}
                              width={360}
                              height={220}
                              className="sale-product-media"
                              imgClassName={!product.image?.secure_url ? "sale-product-placeholder" : ""}
                            />
                          </div>
                          {(() => {
                            const { primaryName, secondaryName } = productCardNames(product);
                            const price = productCardPrice(product);
                            const stock = productCardStock(product);
                            return (
                              <div className="sale-product-content">
                                <div className="sale-product-names">
                                  <strong className="sale-product-name-primary" title={primaryName}>{primaryName}</strong>
                                  {secondaryName ? (
                                    <span className="sale-product-name-secondary" title={secondaryName}>{secondaryName}</span>
                                  ) : (
                                    <span className="sale-product-name-secondary sale-product-name-empty" aria-hidden="true">&nbsp;</span>
                                  )}
                                </div>
                                <div className="sale-product-footer">
                                  <div className={`sale-product-price-block ${price.sizeClass}`}>
                                    <span className={`sale-product-price-symbol ${price.isUsd ? "usd" : ""}`}>{price.symbol}</span>
                                    <b className="sale-product-price-value" title={money(saleUnitForProduct(product).selling_price, product.currency)}>{price.amount}</b>
                                  </div>
                                  <div className="sale-product-meta">
                                    {saleShowProductCode ? (
                                      <small className="sale-product-code" title={product.sku || product.barcode || "No code"}>{product.sku || product.barcode || "No code"}</small>
                                    ) : (
                                      <small className="sale-product-code sale-product-code-hidden" aria-hidden="true">&nbsp;</small>
                                    )}
                                    <small className="sale-product-stock-label">{stock.label}</small>
                                    <em className={`sale-product-stock-value ${stock.out ? "out" : ""}`} title={stock.value}>{stock.value}</em>
                                  </div>
                                </div>
                              </div>
                            );
                          })()}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <SaleCheckoutPanel
              cart={cart}
              customers={customers}
              customerId={customerId}
              creditAccount={selectedCreditAccount}
              onCustomerChange={(value) => {
                invalidateCoupon();
                setCustomerId(value);
              }}
              onAddCustomer={() => setCustomerOpen(true)}
              discountType={discountType}
              discountValue={discountValue}
              onDiscountTypeChange={(value) => {
                setDiscountType(value);
                if (value === "none") setDiscountValue("0");
              }}
              onDiscountValueChange={setDiscountValue}
              couponCode={couponCode}
              appliedCoupon={appliedCoupon}
              couponBusy={couponBusy}
              onCouponCodeChange={(value) => {
                setCouponCode(value);
                if (appliedCoupon) invalidateCoupon();
              }}
              onApplyCoupon={applyCoupon}
              onRemoveCoupon={removeCoupon}
              notes={notes}
              onNotesChange={setNotes}
              totals={totals}
              currency={currency}
              exchangeRate={Number(shop?.usd_to_khr_rate || 4100)}
              taxPercent={shop?.tax_percent || 0}
              onPark={handlePark}
              onSaveQuote={() => {
                if (activeOrderDelivery) {
                  announce("error", "A prepared delivery cannot be saved as a quotation.");
                  return;
                }
                if (!isOnline) {
                  announce(
                    "error",
                    "Reconnect before saving a quotation."
                  );
                  return;
                }
                setQuoteOpen(true);
              }}
              onPay={openPayment}
              canSell={canSell && !busy}
              canDiscount={canDiscount}
              online={isOnline}
              activeParkLabel={activeParkLabel}
              activeQuoteNumber={
                activeQuote?.quote_number || ""
              }
              quoteEditable={
                !activeQuote
                || ["draft", "sent"].includes(
                  activeQuote.status
                )
              }
              priceListName={
                activeOrderDelivery?.order?.price_list_name
                || priceCatalogs[currency]?.price_list_name
                || ""
              }
              fulfillmentLocked={Boolean(activeOrderDelivery)}
            />
          </>
        ) : (
          <>
            <section className="sale-products-panel panel">
              <form className="sale-toolbar" onSubmit={submitSearch}>
                <label className="search-box sale-product-search">
                  <Search size={19} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search product, name, code or barcode"
                  />
                </label>

                <button
                  type="button"
                  className="primary-button sale-scan-button"
                  onClick={async () => {
                    await primeScannerFeedback();
                    setScannerOpen(true);
                  }}
                  disabled={!canSell || Boolean(activeOrderDelivery)}
                >
                  <Camera size={18} /> Scan
                </button>

                <select
                  className="sale-category-select"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  aria-label="Filter products by category"
                >
                  <option value="all">All categories</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>

                <label className="sale-sort-select">
                  <select
                    value={productSort}
                    onChange={(event) => setProductSort(event.target.value)}
                    aria-label="Sort products"
                  >
                    <option value="name_az">A–Z</option>
                    <option value="name_za">Z–A</option>
                    <option value="km_az">ក–អ</option>
                    <option value="km_za">អ–ក</option>
                  </select>
                </label>
              </form>

              <div className="sale-product-summary">
                <span><strong>{visibleProducts.length}</strong> products available</span>
                <div>
                  <small>Tap a product to add one unit.</small>
                  <button
                    type="button"
                    className="icon-button refresh-button"
                    onClick={refresh}
                    title="Refresh products"
                  >
                    <RefreshCw className={loading ? "spin" : ""} size={19} />
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="empty-state"><RefreshCw className="spin" size={34} /><p>Loading products...</p></div>
              ) : visibleProducts.length === 0 ? (
                <div className="empty-state"><ShoppingCart size={46} /><h2>No sale products found</h2><p>Change the filters or add stock first.</p></div>
              ) : (
                <div className="sale-products-grid">
                  {visibleProducts.map((product) => {
                    const outOfStock = product.track_stock && Number(product.stock_quantity) <= 0;
                    return (
                      <button
                        type="button"
                        className="sale-product-card"
                        key={product.id}
                        onClick={() => addProduct(product)}
                        disabled={Boolean(activeOrderDelivery) || (outOfStock && !product.allow_negative_stock && !shop?.allow_negative_stock)}
                      >
                        <div className="sale-product-image">
                          <MediaImage
                            src={product.image}
                            alt={product.name}
                            width={360}
                            height={220}
                            className="sale-product-media"
                            imgClassName={!product.image?.secure_url ? "sale-product-placeholder" : ""}
                          />
                        </div>
                        {(() => {
                          const { primaryName, secondaryName } = productCardNames(product);
                          const price = productCardPrice(product);
                          const stock = productCardStock(product);
                          return (
                            <div className="sale-product-content">
                              <div className="sale-product-names">
                                <strong className="sale-product-name-primary" title={primaryName}>{primaryName}</strong>
                                {secondaryName ? (
                                  <span className="sale-product-name-secondary" title={secondaryName}>{secondaryName}</span>
                                ) : (
                                  <span className="sale-product-name-secondary sale-product-name-empty" aria-hidden="true">&nbsp;</span>
                                )}
                              </div>
                              <div className="sale-product-footer">
                                <div className={`sale-product-price-block ${price.sizeClass}`}>
                                  <span className={`sale-product-price-symbol ${price.isUsd ? "usd" : ""}`}>{price.symbol}</span>
                                  <b className="sale-product-price-value" title={money(saleUnitForProduct(product).selling_price, product.currency)}>{price.amount}</b>
                                </div>
                                <div className="sale-product-meta">
                                  {saleShowProductCode ? (
                                    <small className="sale-product-code" title={product.sku || product.barcode || "No code"}>{product.sku || product.barcode || "No code"}</small>
                                  ) : (
                                    <small className="sale-product-code sale-product-code-hidden" aria-hidden="true">&nbsp;</small>
                                  )}
                                  <small className="sale-product-stock-label">{stock.label}</small>
                                  <em className={`sale-product-stock-value ${stock.out ? "out" : ""}`} title={stock.value}>{stock.value}</em>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <SaleCart
              cart={cart}
              customers={customers}
              customerId={customerId}
              creditAccount={selectedCreditAccount}
              onCustomerChange={(value) => {
                invalidateCoupon();
                setCustomerId(value);
              }}
              onAddCustomer={() => setCustomerOpen(true)}
              discountType={discountType}
              discountValue={discountValue}
              onDiscountTypeChange={(value) => {
                setDiscountType(value);
                if (value === "none") setDiscountValue("0");
              }}
              onDiscountValueChange={setDiscountValue}
              couponCode={couponCode}
              appliedCoupon={appliedCoupon}
              couponBusy={couponBusy}
              onCouponCodeChange={(value) => {
                setCouponCode(value);
                if (appliedCoupon) invalidateCoupon();
              }}
              onApplyCoupon={applyCoupon}
              onRemoveCoupon={removeCoupon}
              notes={notes}
              onNotesChange={setNotes}
              totals={totals}
              currency={currency}
              exchangeRate={Number(shop?.usd_to_khr_rate || 4100)}
              taxPercent={shop?.tax_percent || 0}
              onQuantityChange={changeQuantity}
              onUnitChange={changeUnit}
              onRemove={(cartLineId) => {
                invalidateCoupon();
                setCart((current) => current.filter((item) =>
                  lineKey(item) !== cartLineId
                ));
              }}
              onClear={clearSale}
              parkedCount={parkedSales.length}
              onOpenParked={() => setParkedOpen(true)}
              onPark={handlePark}
              onSaveQuote={() => {
                if (activeOrderDelivery) {
                  announce("error", "A prepared delivery cannot be saved as a quotation.");
                  return;
                }
                if (!isOnline) {
                  announce(
                    "error",
                    "Reconnect before saving a quotation."
                  );
                  return;
                }
                setQuoteOpen(true);
              }}
              onPay={openPayment}
              canSell={canSell && !busy}
              canDiscount={canDiscount}
              online={isOnline}
              activeParkLabel={activeParkLabel}
              activeQuoteNumber={
                activeQuote?.quote_number || ""
              }
              quoteEditable={
                !activeQuote
                || ["draft", "sent"].includes(
                  activeQuote.status
                )
              }
              priceListName={
                activeOrderDelivery?.order?.price_list_name
                || priceCatalogs[currency]?.price_list_name
                || ""
              }
              fulfillmentLocked={Boolean(activeOrderDelivery)}
              fulfillmentLabel={
                activeOrderDelivery
                  ? `${activeOrderDelivery.delivery.delivery_number} · ${activeOrderDelivery.order.order_number}`
                  : ""
              }
            />
          </>
        )}
      </div>

      <BarcodeScanner
        open={scannerOpen}
        title="Scan product for sale"
        onClose={() => setScannerOpen(false)}
        onDetected={handleScan}
        continuous
        vibration={preferences?.scanner_vibration !== false}
        sound={preferences?.scanner_sound !== false}
      />

      <PaymentModal
        open={paymentOpen}
        busy={busy}
        totals={totals}
        currency={currency}
        exchangeRate={Number(shop?.usd_to_khr_rate || 4100)}
        customerName={selectedCustomer?.name}
        creditAccount={selectedCreditAccount}
        cashRegisterOpen={cashRegisterOpen}
        offline={!isOnline}
        bankQrUrl={bankQr.url}
        bankQrComment={bankQr.comment}
        onClose={() => setPaymentOpen(false)}
        onSubmit={handlePayment}
      />

      <ApprovalRequestModal
        request={approvalRequest}
        onClose={() => {
          setApprovalRequest(null);
          setPendingPayment(null);
        }}
        onApproved={(requestId) => {
          const payment = pendingPayment;
          setApprovalRequest(null);
          setPendingPayment(null);

          if (payment) {
            handlePayment(
              payment,
              requestId
            );
          }
        }}
      />

      <QuoteSaveModal
        open={quoteOpen}
        busy={busy}
        activeQuote={activeQuote}
        customerName={selectedCustomer?.name}
        cart={cart}
        totals={totals}
        currency={currency}
        appliedCoupon={appliedCoupon}
        notes={notes}
        onClose={() => setQuoteOpen(false)}
        onSubmit={handleQuoteSave}
      />

      <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />

      {customerOpen && (
        <Modal title="Add customer" onClose={() => !busy && setCustomerOpen(false)}>
          <form className="customer-quick-form" onSubmit={saveCustomer}>
            <label><span>Customer type</span><select value={customerForm.customer_type} onChange={(event) => setCustomerForm((current) => ({ ...current, customer_type: event.target.value }))}><option value="regular">Regular</option><option value="vip">VIP</option><option value="wholesale">Wholesale</option></select></label>
            <label><span>Name *</span><input value={customerForm.name} onChange={(event) => setCustomerForm((current) => ({ ...current, name: event.target.value }))} /></label>
            <label><span>Phone</span><input value={customerForm.phone} onChange={(event) => setCustomerForm((current) => ({ ...current, phone: event.target.value }))} /></label>
            <label><span>Email</span><input type="email" value={customerForm.email} onChange={(event) => setCustomerForm((current) => ({ ...current, email: event.target.value }))} /></label>
            <label><span>Note</span><textarea rows="3" value={customerForm.notes} onChange={(event) => setCustomerForm((current) => ({ ...current, notes: event.target.value }))} /></label>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setCustomerOpen(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="primary-button" disabled={busy}><Plus size={18} /> {busy ? "Saving..." : "Add customer"}</button>
            </div>
          </form>
        </Modal>
      )}

      {parkedOpen && (
        <Modal title="Parked sales" onClose={() => !busy && setParkedOpen(false)}>
          <div className="parked-sales-list">
            {parkedSales.length === 0 ? (
              <div className="cart-empty"><CirclePause size={42} /><strong>No parked sales</strong><span>Park a bill to continue it later.</span></div>
            ) : (
              parkedSales.map((parked) => {
                const customer = customers.find((item) => item.id === parked.customer_id);
                return (
                  <article key={parked.id}>
                    <div>
                      <strong>{parked.label || "Parked sale"}</strong>
                      <span>{customer?.name || "Walk-in"} · {Array.isArray(parked.cart) ? parked.cart.length : 0} products</span>
                      <small>{dateTime(parked.created_at)}</small>
                    </div>
                    <div>
                      <button type="button" className="secondary-button" onClick={() => resumeParked(parked)} disabled={busy}>Resume</button>
                      <button type="button" className="icon-button danger-icon" onClick={() => deleteParked(parked.id)} disabled={busy} aria-label="Delete parked sale"><Trash2 size={18} /></button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
