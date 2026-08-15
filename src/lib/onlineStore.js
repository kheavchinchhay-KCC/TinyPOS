const API_PATH =
  "/.netlify/functions/storefront-public";

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function onlineMoney(
  value,
  currency = "USD"
) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits:
      currency === "KHR" ? 0 : 2
  }).format(number(value));
}

export function onlineDate(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(
    new Date(
      `${String(value).slice(0, 10)}T00:00:00`
    )
  );
}

export function onlineDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function onlineStatusLabel(status, language = "en") {
  const labels = language === "km"
    ? {
        pending: "រង់ចាំពិនិត្យ",
        confirmed: "បានទទួល",
        preparing: "កំពុងរៀបចំ",
        ready: "រួចរាល់",
        partially_fulfilled: "បានប្រគល់មួយផ្នែក",
        fulfilled: "បានបញ្ចប់",
        cancelled: "បានលុប",
        rejected: "បានបដិសេធ"
      }
    : {
        pending: "Pending",
        confirmed: "Received",
        preparing: "Preparing",
        ready: "Ready",
        partially_fulfilled: "Partially fulfilled",
        fulfilled: "Fulfilled",
        cancelled: "Cancelled",
        rejected: "Rejected"
      };
  return labels[status] || status;
}

async function parseResponse(response) {
  const result = await response
    .json()
    .catch(() => ({}));

  if (!response.ok || result?.ok === false) {
    throw new Error(
      result?.error
      || "The storefront request failed."
    );
  }

  return result;
}

export async function loadPublicStorefront(
  slug
) {
  const query = new URLSearchParams({
    slug
  });

  const response = await fetch(
    `${API_PATH}?${query.toString()}`
  );

  return parseResponse(response);
}

export async function submitPublicOrder(
  slug,
  payload
) {
  const query = new URLSearchParams({
    slug
  });

  const response = await fetch(
    `${API_PATH}?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  return parseResponse(response);
}

export async function trackPublicOrder(
  slug,
  orderNumber,
  token
) {
  const query = new URLSearchParams({
    slug,
    action: "track",
    order: orderNumber,
    token
  });

  const response = await fetch(
    `${API_PATH}?${query.toString()}`
  );

  return parseResponse(response);
}

export async function findPublicOrdersByPhone(
  slug,
  phone
) {
  const query = new URLSearchParams({
    slug,
    action: "phone-orders",
    phone: String(phone || "").trim()
  });

  const response = await fetch(
    `${API_PATH}?${query.toString()}`
  );

  return parseResponse(response);
}

export async function loadOnlineStoreAdmin(
  supabase,
  profile,
  filters = {}
) {
  let orderQuery = supabase
    .from("online_orders")
    .select(`
      id,
      organization_id,
      branch_id,
      order_number,
      status,
      payment_status,
      payment_method,
      fulfilment_type,
      currency,
      customer_id,
      customer_name,
      customer_phone,
      customer_email,
      delivery_address,
      requested_date,
      customer_note,
      bank_slip_url,
      bank_slip_public_id,
      bank_slip_uploaded_at,
      bank_reference,
      subtotal,
      delivery_fee,
      total_amount,
      sales_order_id,
      confirmed_at,
      cancelled_at,
      cancel_reason,
      completed_at,
      created_at,
      updated_at,
      branches(name,code),
      customers(id,customer_code,name,phone),
      sales_orders(id,order_number,status),
      online_order_items(
        id,
        product_id,
        product_unit_id,
        product_name,
        sku,
        barcode,
        unit_name,
        unit_factor,
        quantity,
        base_quantity,
        list_price,
        unit_price,
        line_total
      ),
      online_order_status_history(
        id,
        from_status,
        to_status,
        note,
        changed_at,
        changed_by
      )
    `)
    .eq(
      "organization_id",
      profile.organization_id
    )
    .order("created_at", {
      ascending: false
    })
    .limit(250);

  if (filters.branch_id) {
    orderQuery = orderQuery.eq(
      "branch_id",
      filters.branch_id
    );
  }

  if (filters.status === "current") {
    orderQuery = orderQuery.not(
      "status",
      "in",
      "(fulfilled,cancelled,rejected)"
    );
  } else if (filters.status && filters.status !== "all") {
    orderQuery = orderQuery.eq("status", filters.status);
  }

  if (filters.payment && filters.payment !== "all") {
    orderQuery = orderQuery.eq("payment_method", filters.payment);
  }

  if (filters.fulfilment && filters.fulfilment !== "all") {
    orderQuery = orderQuery.eq("fulfilment_type", filters.fulfilment);
  }

  if (filters.from) {
    orderQuery = orderQuery.gte(
      "created_at",
      new Date(
        `${filters.from}T00:00:00`
      ).toISOString()
    );
  }

  if (filters.to) {
    orderQuery = orderQuery.lte(
      "created_at",
      new Date(
        `${filters.to}T23:59:59.999`
      ).toISOString()
    );
  }

  const search = String(
    filters.search || ""
  ).trim();

  if (search) {
    const clean = search.replaceAll(",", " ");
    orderQuery = orderQuery.or(
      [
        `order_number.ilike.%${clean}%`,
        `customer_name.ilike.%${clean}%`,
        `customer_phone.ilike.%${clean}%`
      ].join(",")
    );
  }

  const [
    settingsResult,
    productsResult,
    ordersResult
  ] = await Promise.all([
    supabase
      .from("online_store_settings")
      .select("*")
      .eq(
        "organization_id",
        profile.organization_id
      )
      .eq("branch_id", profile.branch_id)
      .maybeSingle(),
    supabase
      .from("products")
      .select(`
        id,
        name,
        name_km,
        sku,
        barcode,
        currency,
        is_active,
        online_enabled,
        online_featured,
        online_description,
        online_sort_order,
        categories(id,name),
        product_images(
          id,
          secure_url,
          is_primary,
          sort_order
        ),
        product_units(
          id,
          name,
          short_name,
          conversion_factor,
          selling_price,
          is_base,
          is_active,
          sort_order
        )
      `)
      .eq(
        "organization_id",
        profile.organization_id
      )
      .eq("is_active", true)
      .order("online_enabled", {
        ascending: false
      })
      .order("online_sort_order")
      .order("name"),
    orderQuery
  ]);

  if (settingsResult.error) {
    throw settingsResult.error;
  }
  if (productsResult.error) {
    throw productsResult.error;
  }
  if (ordersResult.error) {
    throw ordersResult.error;
  }

  return {
    settings: settingsResult.data || null,
    products: productsResult.data || [],
    orders: (ordersResult.data || []).map(
      (order) => ({
        ...order,
        subtotal: number(order.subtotal),
        delivery_fee: number(
          order.delivery_fee
        ),
        total_amount: number(
          order.total_amount
        ),
        online_order_items: (
          order.online_order_items || []
        ).map((item) => ({
          ...item,
          quantity: number(item.quantity),
          base_quantity: number(
            item.base_quantity
          ),
          list_price: number(
            item.list_price
          ),
          unit_price: number(
            item.unit_price
          ),
          line_total: number(
            item.line_total
          )
        })),
        online_order_status_history: (
          order.online_order_status_history
          || []
        ).sort(
          (a, b) =>
            new Date(a.changed_at)
            - new Date(b.changed_at)
        )
      })
    )
  };
}

export async function saveOnlineStoreSettings(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_online_store_settings",
    {
      p_values: values
    }
  );

  if (error) throw error;
  return data;
}

export async function saveOnlineProduct(
  supabase,
  productId,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_online_product_settings",
    {
      p_product_id: productId,
      p_values: values
    }
  );

  if (error) throw error;
  return data;
}

export async function confirmOnlineOrder(
  supabase,
  orderId
) {
  const { data, error } = await supabase.rpc(
    "receive_online_order",
    {
      p_order_id: orderId
    }
  );

  if (error) throw error;
  return data;
}

export async function setOnlineOrderStatus(
  supabase,
  orderId,
  status,
  note
) {
  const { data, error } = await supabase.rpc(
    "update_online_order_status",
    {
      p_order_id: orderId,
      p_status: status,
      p_note: note || null
    }
  );

  if (error) throw error;
  return data;
}


async function uploadSignedImage(file, signed) {
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
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.secure_url) {
    throw new Error(result.error?.message || "Image upload failed.");
  }
  return {
    url: result.secure_url,
    public_id: result.public_id,
    width: result.width,
    height: result.height
  };
}

export async function uploadOnlineStoreMedia(session, file, kind = "banner") {
  if (!session?.access_token) throw new Error("Your POS session is not ready.");
  if (!file?.type?.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Image must be 8 MB or smaller.");

  const response = await fetch("/api/online-store-media", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ kind, file_type: file.type, file_size: file.size })
  });
  const signed = await response.json().catch(() => ({}));
  if (!response.ok || signed.ok === false) {
    throw new Error(signed.error || "Unable to prepare the image upload.");
  }
  return uploadSignedImage(file, signed);
}

export async function uploadPublicBankSlip(slug, file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Choose a bank-slip image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Bank-slip image must be 5 MB or smaller.");

  const query = new URLSearchParams({ slug, action: "upload-signature" });
  const response = await fetch(`${API_PATH}?${query.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_type: file.type, file_size: file.size })
  });
  const signed = await parseResponse(response);
  return uploadSignedImage(file, signed);
}

export function cloudinaryDownloadUrl(url) {
  const value = String(url || "");
  return value.includes("/upload/")
    ? value.replace("/upload/", "/upload/fl_attachment/")
    : value;
}
