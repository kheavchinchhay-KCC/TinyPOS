import {
  buildSaleCartItem,
  saleUnitForProduct
} from "./sales";

const QUOTE_TRANSFER_VERSION = 1;

function transferKey(profile) {
  if (
    !profile?.organization_id
    || !profile?.branch_id
    || !profile?.id
  ) {
    return null;
  }

  return [
    "tiny-pos-quote-to-sale",
    profile.organization_id,
    profile.branch_id,
    profile.id
  ].join(":");
}

export function quoteDate(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(
    new Date(`${String(value).slice(0, 10)}T00:00:00`)
  );
}

export function quoteDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function effectiveQuoteStatus(quote) {
  if (
    ["converted", "cancelled", "expired"]
      .includes(quote?.status)
  ) {
    return quote.status;
  }

  if (
    quote?.valid_until
    && String(quote.valid_until)
      < new Date().toISOString().slice(0, 10)
  ) {
    return "expired";
  }

  return quote?.status || "draft";
}

export function quoteStatusLabel(status) {
  const labels = {
    draft: "Draft",
    sent: "Sent",
    accepted: "Accepted",
    expired: "Expired",
    cancelled: "Cancelled",
    converted: "Converted"
  };

  return labels[status] || status;
}

export function quoteCanEdit(quote) {
  const status = effectiveQuoteStatus(quote);
  return ["draft", "sent"].includes(status);
}

export function quoteCanConvert(quote) {
  const status = effectiveQuoteStatus(quote);
  return ["draft", "sent", "accepted"].includes(status);
}

export async function loadSalesQuotes(
  supabase,
  profile,
  filters
) {
  const fromIso = new Date(
    `${filters.from}T00:00:00`
  ).toISOString();

  const toIso = new Date(
    `${filters.to}T23:59:59.999`
  ).toISOString();

  const { data, error } = await supabase
    .from("sales_quotes")
    .select(`
      id,
      organization_id,
      branch_id,
      quote_number,
      customer_id,
      status,
      currency,
      subtotal,
      discount_type,
      discount_value,
      discount_amount,
      coupon_id,
      coupon_code,
      tax_amount,
      total_amount,
      price_list_id,
      price_list_name,
      price_adjustment_amount,
      valid_until,
      notes,
      terms,
      created_by,
      sent_at,
      accepted_at,
      cancelled_at,
      cancel_reason,
      converted_sale_id,
      converted_at,
      created_at,
      updated_at,
      customers (
        id,
        customer_code,
        customer_type,
        name,
        company_name,
        phone,
        email,
        address
      ),
      sales_quote_items (
        id,
        product_id,
        product_unit_id,
        product_name,
        products (
          name_km
        ),
        sku,
        barcode,
        quantity,
        base_quantity,
        sale_unit_name,
        unit_factor,
        unit_price,
        list_price,
        price_list_id,
        price_adjustment_amount,
        unit_cost,
        line_subtotal,
        discount_amount,
        line_total
      )
    `)
    .eq(
      "organization_id",
      profile.organization_id
    )
    .eq("branch_id", profile.branch_id)
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .order("created_at", {
      ascending: false
    })
    .limit(300);

  if (error) throw error;

  return (data || []).map((quote) => ({
    ...quote,
    subtotal: Number(quote.subtotal || 0),
    discount_value: Number(
      quote.discount_value || 0
    ),
    discount_amount: Number(
      quote.discount_amount || 0
    ),
    tax_amount: Number(
      quote.tax_amount || 0
    ),
    total_amount: Number(
      quote.total_amount || 0
    ),
    price_adjustment_amount: Number(
      quote.price_adjustment_amount || 0
    ),
    sales_quote_items: [
      ...(quote.sales_quote_items || [])
    ]
      .map((item) => ({
        ...item,
        quantity: Number(item.quantity || 0),
        base_quantity: Number(
          item.base_quantity || 0
        ),
        unit_factor: Number(
          item.unit_factor || 1
        ),
        unit_price: Number(
          item.unit_price || 0
        ),
        list_price: Number(
          item.list_price
          ?? item.unit_price
          ?? 0
        ),
        price_adjustment_amount: Number(
          item.price_adjustment_amount || 0
        ),
        unit_cost: Number(
          item.unit_cost || 0
        ),
        line_subtotal: Number(
          item.line_subtotal || 0
        ),
        discount_amount: Number(
          item.discount_amount || 0
        ),
        line_total: Number(
          item.line_total || 0
        )
      }))
      .sort((a, b) =>
        String(a.product_name)
          .localeCompare(
            String(b.product_name)
          )
      )
  }));
}

export async function saveSalesQuote(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_sales_quote_v3",
    {
      p_quote_id: values.quote_id || null,
      p_items: values.cart.map((item) => ({
        product_id: item.id,
        product_unit_id:
          item.selected_unit_id || null,
        quantity: Number(item.quantity)
      })),
      p_customer_id:
        values.customer_id || null,
      p_manual_discount_type:
        values.applied_coupon
          ? "none"
          : values.discount_type,
      p_manual_discount_value:
        values.applied_coupon
          ? 0
          : Number(
              values.discount_value || 0
            ),
      p_coupon_code:
        values.applied_coupon?.code
        || null,
      p_currency: values.currency,
      p_valid_until:
        values.valid_until || null,
      p_notes:
        values.notes?.trim() || null,
      p_terms:
        values.terms?.trim() || null,
      p_status: values.status
    }
  );

  if (error) throw error;
  return data;
}

export async function updateSalesQuoteStatus(
  supabase,
  quoteId,
  status,
  reason = ""
) {
  const { data, error } = await supabase.rpc(
    "update_sales_quote_status_v2",
    {
      p_quote_id: quoteId,
      p_status: status,
      p_reason:
        reason.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export function prepareQuoteForSale(
  profile,
  quote
) {
  const key = transferKey(profile);

  if (!key || typeof localStorage === "undefined") {
    throw new Error(
      "This browser cannot prepare the quotation for sale."
    );
  }

  localStorage.setItem(
    key,
    JSON.stringify({
      version: QUOTE_TRANSFER_VERSION,
      prepared_at: new Date().toISOString(),
      quote
    })
  );
}

export function consumeQuoteForSale(profile) {
  const key = transferKey(profile);

  if (!key || typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    localStorage.removeItem(key);

    const parsed = JSON.parse(raw);

    if (
      Number(parsed?.version)
        !== QUOTE_TRANSFER_VERSION
      || !parsed?.quote?.id
    ) {
      return null;
    }

    return parsed.quote;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function hydrateQuoteCart(
  products,
  quote
) {
  const cart = [];
  const missing = [];

  for (const row of quote?.sales_quote_items || []) {
    const product = products.find(
      (item) => item.id === row.product_id
    );

    if (!product || !product.is_active) {
      missing.push(row.product_name);
      continue;
    }

    const unit = saleUnitForProduct(
      product,
      row.product_unit_id
    );

    if (!unit || !unit.is_active) {
      missing.push(row.product_name);
      continue;
    }

    cart.push({
      ...buildSaleCartItem(product, unit.id),
      quantity: Math.max(
        0.001,
        Number(row.quantity || 1)
      )
    });
  }

  return {
    cart,
    missing
  };
}
