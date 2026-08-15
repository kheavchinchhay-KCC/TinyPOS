import {
  buildSaleCartItem,
  saleUnitForProduct
} from "./sales";

const DELIVERY_TRANSFER_VERSION = 1;

function transferKey(profile) {
  if (
    !profile?.organization_id
    || !profile?.branch_id
    || !profile?.id
  ) {
    return null;
  }

  return [
    "tiny-pos-sales-order-delivery",
    profile.organization_id,
    profile.branch_id,
    profile.id
  ].join(":");
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function normalizeDeliveryItem(item) {
  return {
    ...item,
    quantity: number(item.quantity),
    base_quantity: number(item.base_quantity),
    unit_factor: number(item.unit_factor || 1),
    list_price: number(item.list_price),
    invoice_unit_price: number(
      item.invoice_unit_price
    ),
    line_total: number(item.line_total)
  };
}

function normalizeOrderItem(item) {
  return {
    ...item,
    quantity: number(item.quantity),
    base_quantity: number(item.base_quantity),
    delivered_quantity: number(
      item.delivered_quantity
    ),
    delivered_base_quantity: number(
      item.delivered_base_quantity
    ),
    unit_factor: number(item.unit_factor || 1),
    list_price: number(item.list_price),
    unit_price: number(item.unit_price),
    net_unit_price: number(item.net_unit_price),
    price_adjustment_amount: number(
      item.price_adjustment_amount
    ),
    line_subtotal: number(item.line_subtotal),
    discount_amount: number(item.discount_amount),
    line_total: number(item.line_total),
    stock_reservations: asArray(
      item.stock_reservations
    ).map((reservation) => ({
      ...reservation,
      reserved_base_quantity: number(
        reservation.reserved_base_quantity
      ),
      delivered_base_quantity: number(
        reservation.delivered_base_quantity
      ),
      released_base_quantity: number(
        reservation.released_base_quantity
      )
    }))
  };
}

function normalizeOrder(order) {
  return {
    ...order,
    subtotal: number(order.subtotal),
    discount_amount: number(
      order.discount_amount
    ),
    tax_amount: number(order.tax_amount),
    total_amount: number(order.total_amount),
    sales_order_items: asArray(
      order.sales_order_items
    )
      .map(normalizeOrderItem)
      .sort((a, b) =>
        String(a.product_name).localeCompare(
          String(b.product_name)
        )
      ),
    sales_order_deliveries: asArray(
      order.sales_order_deliveries
    )
      .map((delivery) => ({
        ...delivery,
        subtotal: number(delivery.subtotal),
        tax_amount: number(delivery.tax_amount),
        total_amount: number(delivery.total_amount),
        sales_order_delivery_items: asArray(
          delivery.sales_order_delivery_items
        ).map(normalizeDeliveryItem)
      }))
      .sort(
        (a, b) =>
          new Date(b.created_at)
          - new Date(a.created_at)
      )
  };
}

export function salesOrderDate(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(
    new Date(`${String(value).slice(0, 10)}T00:00:00`)
  );
}

export function salesOrderDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function salesOrderStatusLabel(status) {
  const labels = {
    draft: "Draft",
    confirmed: "Confirmed",
    partially_delivered: "Partially delivered",
    delivered: "Delivered",
    cancelled: "Cancelled"
  };

  return labels[status] || status;
}

export function orderRemainingQuantity(item) {
  return Math.max(
    0,
    number(item.quantity)
      - number(item.delivered_quantity)
  );
}

export function orderReservedQuantity(item) {
  const reservation = asArray(
    item.stock_reservations
  )[0];

  if (!reservation) return 0;

  const baseRemaining = Math.max(
    0,
    reservation.reserved_base_quantity
      - reservation.delivered_base_quantity
      - reservation.released_base_quantity
  );

  return baseRemaining / number(item.unit_factor || 1);
}

export async function loadSalesOrders(
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
    .from("sales_orders")
    .select(`
      id,
      organization_id,
      branch_id,
      order_number,
      source_quote_id,
      customer_id,
      status,
      currency,
      subtotal,
      discount_amount,
      tax_amount,
      total_amount,
      price_list_id,
      price_list_name,
      requested_delivery_date,
      delivery_address,
      notes,
      terms,
      confirmed_at,
      cancelled_at,
      cancel_reason,
      completed_at,
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
      sales_quotes (
        id,
        quote_number
      ),
      sales_order_items (
        id,
        product_id,
        product_unit_id,
        product_name,
        sku,
        barcode,
        sale_unit_name,
        unit_factor,
        quantity,
        base_quantity,
        delivered_quantity,
        delivered_base_quantity,
        list_price,
        unit_price,
        net_unit_price,
        price_list_id,
        price_adjustment_amount,
        line_subtotal,
        discount_amount,
        line_total,
        stock_reservations (
          id,
          reserved_base_quantity,
          delivered_base_quantity,
          released_base_quantity,
          status
        )
      ),
      sales_order_deliveries (
        id,
        delivery_number,
        status,
        delivery_date,
        delivery_address,
        notes,
        subtotal,
        tax_amount,
        total_amount,
        sale_id,
        invoice_number,
        completed_at,
        cancelled_at,
        cancel_reason,
        created_at,
        sales_order_delivery_items (
          id,
          sales_order_item_id,
          product_id,
          product_unit_id,
          product_name,
          sku,
          barcode,
          sale_unit_name,
          unit_factor,
          quantity,
          base_quantity,
          list_price,
          invoice_unit_price,
          line_total,
          sale_item_id
        )
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

  return (data || []).map(normalizeOrder);
}

export async function createSalesOrderFromQuote(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "create_sales_order_from_quote",
    {
      p_quote_id: values.quote_id,
      p_requested_delivery_date:
        values.requested_delivery_date || null,
      p_delivery_address:
        values.delivery_address?.trim() || null,
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function confirmSalesOrder(
  supabase,
  orderId
) {
  const { data, error } = await supabase.rpc(
    "confirm_sales_order",
    { p_order_id: orderId }
  );

  if (error) throw error;
  return data;
}

export async function prepareSalesOrderDelivery(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "prepare_sales_order_delivery",
    {
      p_order_id: values.order_id,
      p_items: values.items.map((item) => ({
        sales_order_item_id:
          item.sales_order_item_id,
        quantity: number(item.quantity)
      })),
      p_delivery_date:
        values.delivery_date || null,
      p_delivery_address:
        values.delivery_address?.trim() || null,
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function cancelSalesOrder(
  supabase,
  orderId,
  reason
) {
  const { data, error } = await supabase.rpc(
    "cancel_sales_order",
    {
      p_order_id: orderId,
      p_reason: reason.trim()
    }
  );

  if (error) throw error;
  return data;
}

export async function cancelSalesOrderDelivery(
  supabase,
  deliveryId,
  reason
) {
  const { data, error } = await supabase.rpc(
    "cancel_sales_order_delivery",
    {
      p_delivery_id: deliveryId,
      p_reason: reason.trim()
    }
  );

  if (error) throw error;
  return data;
}

export function prepareDeliveryForSale(
  profile,
  order,
  delivery
) {
  const key = transferKey(profile);

  if (!key || typeof localStorage === "undefined") {
    throw new Error(
      "This browser cannot prepare the delivery for checkout."
    );
  }

  localStorage.setItem(
    key,
    JSON.stringify({
      version: DELIVERY_TRANSFER_VERSION,
      prepared_at: new Date().toISOString(),
      order,
      delivery
    })
  );
}

export function consumeDeliveryForSale(profile) {
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
        !== DELIVERY_TRANSFER_VERSION
      || !parsed?.order?.id
      || !parsed?.delivery?.id
    ) {
      return null;
    }

    return parsed;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function hydrateSalesOrderDeliveryCart(
  products,
  order,
  delivery
) {
  const cart = [];
  const missing = [];

  for (
    const row of
      delivery?.sales_order_delivery_items || []
  ) {
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

    const item = buildSaleCartItem(
      product,
      unit.id
    );

    cart.push({
      ...item,
      quantity: number(row.quantity),
      selected_unit_price: number(
        row.invoice_unit_price
      ),
      selling_price: number(
        row.invoice_unit_price
      ),
      standard_unit_price: number(
        row.list_price
      ),
      price_list_id:
        order.price_list_id || null,
      price_list_name:
        order.price_list_name || null,
      stock_quantity: number(
        product.physical_stock_quantity
        ?? product.stock_quantity
      ),
      sales_order_item_id:
        row.sales_order_item_id
    });
  }

  return { cart, missing };
}
