export function dateOnly(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(
    new Date(`${String(value).slice(0, 10)}T00:00:00`)
  );
}

export function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function purchasePaymentStatus(purchase) {
  const total = Number(purchase?.total_amount || 0);
  const paid = Number(purchase?.amount_paid || 0);

  if (total <= 0 || paid >= total) return "paid";
  if (paid > 0) return "partial";
  return "unpaid";
}

export function purchaseBalance(purchase) {
  return Math.max(
    0,
    Number(purchase?.total_amount || 0)
      - Number(purchase?.amount_paid || 0)
  );
}

export function sortedPurchaseUnits(product) {
  return [...(product?.product_units || [])]
    .filter((unit) => unit.is_active || unit.is_base)
    .sort(
      (a, b) =>
        Number(b.is_base) - Number(a.is_base)
        || Number(a.sort_order || 0)
          - Number(b.sort_order || 0)
        || String(a.name).localeCompare(String(b.name))
    );
}

export function purchaseUnitForProduct(product, unitId = null) {
  const units = sortedPurchaseUnits(product);

  return (
    units.find((unit) => unit.id === unitId)
    || units.find((unit) => unit.is_base)
    || units[0]
    || {
      id: null,
      name: product?.unit_name || "pcs",
      short_name: product?.unit_name || "pcs",
      conversion_factor: 1,
      barcode: product?.barcode || null,
      is_base: true,
      is_active: true,
      sort_order: 0
    }
  );
}

export function purchaseItemBaseQuantity(item) {
  return Number(item?.quantity || 0)
    * Number(item?.unit_factor || 1);
}

export function purchaseItemRemainingQuantity(item) {
  return Math.max(
    0,
    Number(item?.quantity || 0)
      - Number(item?.received_quantity || 0)
  );
}

export function purchaseItemBaseRemainingQuantity(item) {
  return Math.max(
    0,
    Number(item?.base_quantity || 0)
      - Number(item?.base_received_quantity || 0)
  );
}

export function purchaseReceivingTotals(purchase) {
  const items = purchase?.purchase_items || [];

  return items.reduce(
    (result, item) => {
      result.orderedPurchaseUnits += Number(
        item.quantity || 0
      );
      result.receivedPurchaseUnits += Number(
        item.received_quantity || 0
      );
      result.orderedBaseUnits += Number(
        item.base_quantity || 0
      );
      result.receivedBaseUnits += Number(
        item.base_received_quantity || 0
      );
      result.receivedValue += Number(
        item.received_quantity || 0
      ) * Number(item.unit_cost || 0);
      return result;
    },
    {
      orderedPurchaseUnits: 0,
      receivedPurchaseUnits: 0,
      orderedBaseUnits: 0,
      receivedBaseUnits: 0,
      receivedValue: 0
    }
  );
}

export function purchaseReceivingStatus(purchase) {
  if (!purchase) return "draft";

  if (["cancelled", "draft", "received"]
    .includes(purchase.status)) {
    return purchase.status;
  }

  const totals = purchaseReceivingTotals(purchase);

  return totals.receivedBaseUnits > 0
    ? "partially_received"
    : "ordered";
}

export function purchaseReceivingStatusLabel(purchase) {
  const status = purchaseReceivingStatus(purchase);

  const labels = {
    draft: "Draft",
    ordered: "Ordered",
    partially_received: "Partially received",
    received: "Received",
    cancelled: "Cancelled"
  };

  return labels[status] || status;
}

export async function loadPurchaseOrderWorkspace(
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

  const [supplierResult, productResult, purchaseResult] =
    await Promise.all([
      supabase
        .from("suppliers")
        .select(
          "id,supplier_code,name,contact_name,phone,email,address,tax_id,notes,is_active,created_at,updated_at"
        )
        .eq("organization_id", profile.organization_id)
        .order("name"),

      supabase
        .from("products")
        .select(`
          id,
          name,
          name_km,
          sku,
          barcode,
          unit_name,
          currency,
          default_cost,
          batch_tracking,
          expiry_tracking,
          picking_policy,
          default_shelf_life_days,
          is_active,
          product_images (
            secure_url,
            is_primary,
            sort_order
          ),
          product_units (
            id,
            name,
            short_name,
            conversion_factor,
            selling_price,
            barcode,
            is_base,
            is_active,
            sort_order
          )
        `)
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name"),

      supabase
        .from("purchases")
        .select(`
          id,
          organization_id,
          branch_id,
          purchase_number,
          supplier_id,
          status,
          currency,
          subtotal,
          discount_amount,
          tax_amount,
          total_amount,
          amount_paid,
          supplier_invoice_number,
          notes,
          expected_date,
          payment_terms,
          delivery_address,
          ordered_at,
          received_at,
          first_received_at,
          last_received_at,
          cancelled_at,
          cancel_reason,
          created_at,
          updated_at,
          suppliers (
            id,
            supplier_code,
            name,
            contact_name,
            phone,
            email,
            address,
            tax_id
          ),
          purchase_items (
            id,
            product_id,
            product_unit_id,
            purchase_unit_name,
            unit_factor,
            quantity,
            base_quantity,
            received_quantity,
            base_received_quantity,
            unit_cost,
            base_unit_cost,
            tax_amount,
            line_total,
            products (
              id,
              name,
              name_km,
              sku,
              barcode,
              unit_name,
              currency,
              default_cost,
              batch_tracking,
              expiry_tracking,
              picking_policy,
              default_shelf_life_days,
              product_units (
                id,
                name,
                short_name,
                conversion_factor,
                selling_price,
                barcode,
                is_base,
                is_active,
                sort_order
              )
            )
          ),
          purchase_receipts (
            id,
            receipt_number,
            supplier_invoice_number,
            received_at,
            notes,
            created_at,
            purchase_receipt_items (
              id,
              purchase_item_id,
              product_id,
              purchase_unit_name,
              unit_factor,
              quantity,
              base_quantity,
              unit_cost,
              base_unit_cost,
              line_total,
              purchase_receipt_item_batches (
                id,
                purchase_unit_quantity,
                base_quantity,
                unit_cost,
                inventory_batches (
                  id,
                  batch_number,
                  expiry_date,
                  status
                )
              ),
              products (
                id,
                name,
                sku,
                barcode,
                unit_name,
                currency
              )
            )
          ),
          purchase_payments (
            id,
            method,
            amount,
            reference_number,
            notes,
            paid_at
          )
        `)
        .eq("organization_id", profile.organization_id)
        .eq("branch_id", profile.branch_id)
        .gte("created_at", fromIso)
        .lte("created_at", toIso)
        .order("created_at", { ascending: false })
        .limit(300)
    ]);

  for (const result of [
    supplierResult,
    productResult,
    purchaseResult
  ]) {
    if (result.error) throw result.error;
  }

  const products = (productResult.data || []).map((product) => ({
    ...product,
    product_units: sortedPurchaseUnits(product),
    image_url:
      [...(product.product_images || [])].sort((a, b) => {
        if (a.is_primary !== b.is_primary) {
          return a.is_primary ? -1 : 1;
        }
        return Number(a.sort_order || 0)
          - Number(b.sort_order || 0);
      })[0]?.secure_url || null
  }));

  const purchases = (purchaseResult.data || []).map((purchase) => ({
    ...purchase,
    payment_status: purchasePaymentStatus(purchase),
    balance_due: purchaseBalance(purchase),
    purchase_items: [...(purchase.purchase_items || [])]
      .map((item) => ({
        ...item,
        unit_factor: Number(item.unit_factor || 1),
        quantity: Number(item.quantity || 0),
        base_quantity: Number(
          item.base_quantity
            ?? Number(item.quantity || 0)
              * Number(item.unit_factor || 1)
        ),
        received_quantity: Number(
          item.received_quantity || 0
        ),
        base_received_quantity: Number(
          item.base_received_quantity || 0
        ),
        unit_cost: Number(item.unit_cost || 0),
        base_unit_cost: Number(
          item.base_unit_cost
            ?? (
              Number(item.unit_cost || 0)
              / Math.max(Number(item.unit_factor || 1), 0.001)
            )
        ),
        products: item.products
          ? {
              ...item.products,
              product_units:
                sortedPurchaseUnits(item.products)
            }
          : null
      }))
      .sort((a, b) =>
        String(a.products?.name || "").localeCompare(
          String(b.products?.name || "")
        )
      ),
    purchase_receipts: [...(purchase.purchase_receipts || [])]
      .map((receipt) => ({
        ...receipt,
        purchase_receipt_items: [
          ...(receipt.purchase_receipt_items || [])
        ]
          .map((item) => ({
            ...item,
            unit_factor: Number(item.unit_factor || 1),
            quantity: Number(item.quantity || 0),
            base_quantity: Number(item.base_quantity || 0),
            unit_cost: Number(item.unit_cost || 0),
            base_unit_cost: Number(item.base_unit_cost || 0),
            line_total: Number(item.line_total || 0)
          }))
          .sort((a, b) =>
            String(a.products?.name || "").localeCompare(
              String(b.products?.name || "")
            )
          )
      }))
      .sort(
        (a, b) =>
          new Date(b.received_at) - new Date(a.received_at)
      ),
    purchase_payments: [...(purchase.purchase_payments || [])]
      .sort(
        (a, b) =>
          new Date(b.paid_at) - new Date(a.paid_at)
      )
  }));

  return {
    suppliers: supplierResult.data || [],
    products,
    purchases
  };
}

export async function savePurchaseOrder(supabase, values) {
  const { data, error } = await supabase.rpc(
    "save_purchase_order_v3",
    {
      p_purchase_id: values.purchase_id || null,
      p_supplier_id: values.supplier_id,
      p_items: values.items.map((item) => ({
        product_id: item.product_id,
        product_unit_id: item.product_unit_id || null,
        quantity: Number(item.quantity),
        unit_cost: Number(item.unit_cost)
      })),
      p_currency: values.currency,
      p_discount_amount: Number(values.discount_amount || 0),
      p_tax_amount: Number(values.tax_amount || 0),
      p_expected_date: values.expected_date || null,
      p_supplier_invoice_number:
        values.supplier_invoice_number?.trim() || null,
      p_payment_terms:
        values.payment_terms?.trim() || null,
      p_delivery_address:
        values.delivery_address?.trim() || null,
      p_notes: values.notes?.trim() || null,
      p_status: values.status
    }
  );

  if (error) throw error;
  return data;
}

export async function receivePurchaseOrder(supabase, values) {
  const { data, error } = await supabase.rpc(
    "receive_purchase_order_v5",
    {
      p_purchase_id: values.purchase_id,
      p_items: values.items.map((item) => ({
        purchase_item_id: item.purchase_item_id,
        quantity: Number(item.quantity)
      })),
      p_batch_allocations: (values.items || []).flatMap((item) =>
        (item.batches || []).map((batch) => ({
          purchase_item_id: item.purchase_item_id,
          batch_number: String(batch.batch_number || "").trim(),
          expiry_date: batch.expiry_date || null,
          quantity: Number(batch.quantity),
          notes: batch.notes?.trim() || null
        }))
      ),
      p_amount_paid: Number(values.amount_paid || 0),
      p_payment_method: values.payment_method,
      p_payment_reference:
        values.payment_reference?.trim() || null,
      p_supplier_invoice_number:
        values.supplier_invoice_number?.trim() || null,
      p_received_at: values.received_at || null,
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function recordPurchasePayment(supabase, values) {
  const { data, error } = await supabase.rpc(
    "record_purchase_payment",
    {
      p_purchase_id: values.purchase_id,
      p_amount: Number(values.amount),
      p_method: values.method,
      p_reference_number:
        values.reference_number?.trim() || null,
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function cancelPurchaseOrder(
  supabase,
  purchaseId,
  reason
) {
  const { data, error } = await supabase.rpc(
    "cancel_purchase_order_v2",
    {
      p_purchase_id: purchaseId,
      p_reason: reason.trim()
    }
  );

  if (error) throw error;
  return data;
}

export async function saveSupplier(supabase, values) {
  const { data, error } = await supabase.rpc("save_supplier", {
    p_supplier_id: values.supplier_id || null,
    p_name: values.name.trim(),
    p_contact_name: values.contact_name?.trim() || null,
    p_phone: values.phone?.trim() || null,
    p_email: values.email?.trim() || null,
    p_address: values.address?.trim() || null,
    p_tax_id: values.tax_id?.trim() || null,
    p_notes: values.notes?.trim() || null,
    p_is_active: Boolean(values.is_active)
  });

  if (error) throw error;
  return data;
}
