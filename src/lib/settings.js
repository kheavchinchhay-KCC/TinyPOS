async function authorizedPost(path, token, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

export function shopFormFromSettings(shop) {
  return {
    shop_name: shop?.shop_name || "Tiny POS",
    shop_name_km: shop?.shop_name_km || "",
    shop_phone: shop?.shop_phone || "",
    shop_email: shop?.shop_email || "",
    shop_address: shop?.shop_address || "",
    shop_address_km: shop?.shop_address_km || "",
    tax_id: shop?.tax_id || "",
    receipt_header: shop?.receipt_header || "",
    receipt_header_km: shop?.receipt_header_km || "",
    receipt_footer: shop?.receipt_footer || "Thank you for your purchase.",
    receipt_footer_km: shop?.receipt_footer_km || "",
    default_language: shop?.default_language || "en",
    receipt_default_language: shop?.receipt_default_language === "km" ? "km" : "en",
    default_theme: shop?.default_theme || "system",
    base_currency: shop?.base_currency || "USD",
    usd_to_khr_rate: Number(shop?.usd_to_khr_rate || 4100),
    tax_percent: Number(shop?.tax_percent || 0),
    low_stock_threshold: Number(shop?.low_stock_threshold || 5),
    allow_negative_stock: Boolean(shop?.allow_negative_stock),
    receipt_width_mm: Number(shop?.receipt_width_mm || 80),
    invoice_prefix: shop?.invoice_prefix || "INV",
    receipt_show_logo: shop?.receipt_show_logo !== false,
    receipt_show_address: shop?.receipt_show_address !== false,
    receipt_show_phone: shop?.receipt_show_phone !== false,
    receipt_show_customer: shop?.receipt_show_customer !== false,
    receipt_show_cashier: shop?.receipt_show_cashier !== false,
    receipt_show_barcode: shop?.receipt_show_barcode !== false,
    receipt_logo_position: shop?.receipt_logo_position === "above" ? "above" : "inline",
    sale_document_type: ["invoice", "inline", "receipt"].includes(shop?.sale_document_type) ? shop.sale_document_type : "receipt",
    invoice_paper_size: shop?.invoice_paper_size === "A4" ? "A4" : "A5",
    invoice_title: shop?.invoice_title || "INVOICE",
    invoice_title_km: shop?.invoice_title_km || "វិក្កយបត្រ",
    invoice_footer: shop?.invoice_footer || "Thank you for your purchase.",
    invoice_footer_km: shop?.invoice_footer_km || "សូមអរគុណចំពោះការគាំទ្រ!",
    invoice_show_logo: shop?.invoice_show_logo !== false,
    invoice_show_shop_name: shop?.invoice_show_shop_name !== false,
    invoice_show_address: shop?.invoice_show_address !== false,
    invoice_show_contact: shop?.invoice_show_contact !== false,
    invoice_show_tax_id: shop?.invoice_show_tax_id !== false,
    invoice_show_customer: shop?.invoice_show_customer !== false,
    invoice_show_cashier: shop?.invoice_show_cashier !== false,
    invoice_show_received: shop?.invoice_show_received !== false,
    invoice_show_change: shop?.invoice_show_change !== false,
    invoice_show_signatures: shop?.invoice_show_signatures !== false,
    invoice_show_product_code: shop?.invoice_show_product_code !== undefined
      ? shop.invoice_show_product_code !== false
      : (typeof window !== "undefined" && window.localStorage.getItem("invoice_show_product_code") === "false" ? false : true),
    label_width_mm: Number(shop?.label_width_mm || 50),
    label_height_mm: Number(shop?.label_height_mm || 30),
    label_columns: Number(shop?.label_columns || 3),
    label_show_name: shop?.label_show_name !== false,
    label_show_price: shop?.label_show_price !== false,
    label_show_sku: shop?.label_show_sku !== false,
    label_barcode_format: shop?.label_barcode_format || "CODE128"
  };
}

export async function saveShopSettings(supabase, values) {
  const text = (value, fallback = "") => String(value ?? fallback).trim();
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const directPayload = {
    shop_name: text(values.shop_name, "Tiny POS"),
    shop_name_km: text(values.shop_name_km) || null,
    shop_phone: text(values.shop_phone) || null,
    shop_email: text(values.shop_email) || null,
    shop_address: text(values.shop_address) || null,
    shop_address_km: text(values.shop_address_km) || null,
    tax_id: text(values.tax_id) || null,
    receipt_header: text(values.receipt_header) || null,
    receipt_header_km: text(values.receipt_header_km) || null,
    receipt_footer: text(values.receipt_footer, "Thank you for your purchase."),
    receipt_footer_km: text(values.receipt_footer_km) || null,
    default_language: values.default_language === "km" ? "km" : "en",
    receipt_default_language: values.receipt_default_language === "km" ? "km" : "en",
    default_theme: ["light", "dark", "system"].includes(values.default_theme)
      ? values.default_theme
      : "system",
    base_currency: values.base_currency === "KHR" ? "KHR" : "USD",
    usd_to_khr_rate: Math.max(1, number(values.usd_to_khr_rate, 4100)),
    tax_percent: Math.min(100, Math.max(0, number(values.tax_percent, 0))),
    low_stock_threshold: Math.max(0, number(values.low_stock_threshold, 5)),
    allow_negative_stock: Boolean(values.allow_negative_stock),
    receipt_width_mm: Number(values.receipt_width_mm) === 58 ? 58 : 80,
    invoice_prefix: text(values.invoice_prefix, "INV").toUpperCase(),
    receipt_show_logo: values.receipt_show_logo !== false,
    receipt_show_address: values.receipt_show_address !== false,
    receipt_show_phone: values.receipt_show_phone !== false,
    receipt_show_customer: values.receipt_show_customer !== false,
    receipt_show_cashier: values.receipt_show_cashier !== false,
    receipt_show_barcode: values.receipt_show_barcode !== false,
    receipt_logo_position: values.receipt_logo_position === "above" ? "above" : "inline",
    sale_document_type: ["invoice", "inline", "receipt"].includes(values.sale_document_type) ? values.sale_document_type : "receipt",
    invoice_paper_size: values.invoice_paper_size === "A4" ? "A4" : "A5",
    invoice_title: text(values.invoice_title, "INVOICE"),
    invoice_title_km: text(values.invoice_title_km, "វិក្កយបត្រ"),
    invoice_footer: text(values.invoice_footer, "Thank you for your purchase."),
    invoice_footer_km: text(values.invoice_footer_km, "សូមអរគុណចំពោះការគាំទ្រ!"),
    invoice_show_logo: values.invoice_show_logo !== false,
    invoice_show_shop_name: values.invoice_show_shop_name !== false,
    invoice_show_address: values.invoice_show_address !== false,
    invoice_show_contact: values.invoice_show_contact !== false,
    invoice_show_tax_id: values.invoice_show_tax_id !== false,
    invoice_show_customer: values.invoice_show_customer !== false,
    invoice_show_cashier: values.invoice_show_cashier !== false,
    invoice_show_received: values.invoice_show_received !== false,
    invoice_show_change: values.invoice_show_change !== false,
    invoice_show_signatures: values.invoice_show_signatures !== false,
    invoice_show_product_code: values.invoice_show_product_code !== false,
    label_width_mm: Math.min(120, Math.max(20, number(values.label_width_mm, 50))),
    label_height_mm: Math.min(100, Math.max(15, number(values.label_height_mm, 30))),
    label_columns: Math.min(6, Math.max(1, Math.round(number(values.label_columns, 3)))),
    label_show_name: values.label_show_name !== false,
    label_show_price: values.label_show_price !== false,
    label_show_sku: values.label_show_sku !== false,
    label_barcode_format: values.label_barcode_format === "EAN13" ? "EAN13" : "CODE128"
  };

  // Try direct update on app_settings first
  let { data: directData, error: directError } = await supabase
    .from("app_settings")
    .update(directPayload)
    .select()
    .single();

  if (directError && (directError.message?.includes("invoice_show_product_code") || directError.message?.includes("schema cache"))) {
    if (values.invoice_show_product_code !== undefined) {
      try {
        localStorage.setItem("invoice_show_product_code", String(values.invoice_show_product_code !== false));
      } catch (e) { /* localStorage unavailable (private browsing, quota, etc.) — best-effort fallback only, safe to ignore */ }
    }
    const safePayload = { ...directPayload };
    delete safePayload.invoice_show_product_code;
    const res = await supabase
      .from("app_settings")
      .update(safePayload)
      .select()
      .single();
    directData = res.data;
    directError = res.error;
    if (directData) {
      directData.invoice_show_product_code = values.invoice_show_product_code !== false;
    }
  }

  if (!directError && directData) {
    return directData;
  }

  // Fallback to RPC if direct table update returns an error
  const rpcPayload = {
    p_shop_name: directPayload.shop_name,
    p_shop_name_km: directPayload.shop_name_km || "",
    p_shop_phone: directPayload.shop_phone || "",
    p_shop_email: directPayload.shop_email || "",
    p_shop_address: directPayload.shop_address || "",
    p_shop_address_km: directPayload.shop_address_km || "",
    p_tax_id: directPayload.tax_id || "",
    p_receipt_header: directPayload.receipt_header || "",
    p_receipt_header_km: directPayload.receipt_header_km || "",
    p_receipt_footer: directPayload.receipt_footer,
    p_receipt_footer_km: directPayload.receipt_footer_km || "",
    p_default_language: directPayload.default_language,
    p_receipt_default_language: directPayload.receipt_default_language,
    p_default_theme: directPayload.default_theme,
    p_base_currency: directPayload.base_currency,
    p_usd_to_khr_rate: directPayload.usd_to_khr_rate,
    p_tax_percent: directPayload.tax_percent,
    p_low_stock_threshold: directPayload.low_stock_threshold,
    p_allow_negative_stock: directPayload.allow_negative_stock,
    p_receipt_width_mm: directPayload.receipt_width_mm,
    p_invoice_prefix: directPayload.invoice_prefix,
    p_receipt_show_logo: directPayload.receipt_show_logo,
    p_receipt_show_address: directPayload.receipt_show_address,
    p_receipt_show_phone: directPayload.receipt_show_phone,
    p_receipt_show_customer: directPayload.receipt_show_customer,
    p_receipt_show_cashier: directPayload.receipt_show_cashier,
    p_receipt_show_barcode: directPayload.receipt_show_barcode,
    p_receipt_logo_position: directPayload.receipt_logo_position,
    p_sale_document_type: directPayload.sale_document_type,
    p_invoice_paper_size: directPayload.invoice_paper_size,
    p_invoice_title: directPayload.invoice_title,
    p_invoice_title_km: directPayload.invoice_title_km,
    p_invoice_footer: directPayload.invoice_footer,
    p_invoice_footer_km: directPayload.invoice_footer_km,
    p_invoice_show_logo: directPayload.invoice_show_logo,
    p_invoice_show_address: directPayload.invoice_show_address,
    p_invoice_show_contact: directPayload.invoice_show_contact,
    p_invoice_show_tax_id: directPayload.invoice_show_tax_id,
    p_invoice_show_customer: directPayload.invoice_show_customer,
    p_invoice_show_cashier: directPayload.invoice_show_cashier,
    p_invoice_show_received: directPayload.invoice_show_received,
    p_invoice_show_change: directPayload.invoice_show_change,
    p_invoice_show_signatures: directPayload.invoice_show_signatures,
    p_label_width_mm: directPayload.label_width_mm,
    p_label_height_mm: directPayload.label_height_mm,
    p_label_columns: directPayload.label_columns,
    p_label_show_name: directPayload.label_show_name,
    p_label_show_price: directPayload.label_show_price,
    p_label_show_sku: directPayload.label_show_sku,
    p_label_barcode_format: directPayload.label_barcode_format
  };

  const { data: rpcData, error: rpcError } = await supabase.rpc("update_shop_settings_v2", {
    p_settings: rpcPayload
  });

  if (rpcError) throw directError || rpcError;
  return rpcData;
}


export async function uploadShopLogo({ supabase, session, file }) {
  if (!file?.type?.startsWith("image/")) {
    throw new Error("Choose a valid logo image.");
  }

  if (file.size > 3 * 1024 * 1024) {
    throw new Error("The shop logo must be 3 MB or smaller.");
  }

  const signed = await authorizedPost(
    "/api/shop-logo",
    session.access_token,
    { action: "sign" }
  );

  const form = new FormData();
  form.append("file", file);
  form.append("api_key", signed.apiKey);
  form.append("timestamp", String(signed.timestamp));
  form.append("signature", signed.signature);
  form.append("folder", signed.folder);
  form.append("public_id", signed.publicId);
  form.append("overwrite", signed.overwrite);
  form.append("invalidate", signed.invalidate);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(signed.cloudName)}/image/upload`,
    { method: "POST", body: form }
  );
  const result = await response.json();

  if (!response.ok || !result.secure_url || !result.public_id) {
    throw new Error(result.error?.message || "Shop logo upload failed.");
  }

  const { data, error } = await supabase.rpc("set_shop_logo", {
    p_logo_url: result.secure_url,
    p_logo_public_id: result.public_id
  });

  if (error) throw error;
  return data;
}

export async function removeShopLogo({ supabase, session, publicId }) {
  if (publicId) {
    await authorizedPost("/api/shop-logo", session.access_token, {
      action: "delete",
      publicId
    });
  }

  const { data, error } = await supabase.rpc("set_shop_logo", {
    p_logo_url: null,
    p_logo_public_id: null
  });

  if (error) throw error;
  return data;
}
