export const adjustmentReasons = [
  ["opening_stock", "Opening stock"],
  ["count_correction", "Stock count correction"],
  ["damaged", "Damaged"],
  ["expired", "Expired"],
  ["lost", "Lost"],
  ["found", "Found"],
  ["internal_use", "Internal use"],
  ["other", "Other"]
];

export const movementLabels = {
  opening: "Opening stock",
  sale: "Sale",
  sale_void: "Voided sale",
  purchase: "Purchase received",
  purchase_cancel: "Purchase cancelled",
  customer_return: "Customer return",
  supplier_return: "Supplier return",
  adjustment: "Inventory adjustment",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out"
};

export async function loadInventory(supabase, organizationId, branchId) {
  const [productResult, categoryResult, supplierResult, movementResult, purchaseResult, settingsResult, reorderResult, batchResult] =
    await Promise.all([
      supabase
        .from("products")
        .select(`
          id,
          category_id,
          name,
          name_km,
          sku,
          barcode,
          unit_name,
          selling_price,
          default_cost,
          currency,
          track_stock,
          allow_negative_stock,
          low_stock_threshold,
          batch_tracking,
          expiry_tracking,
          picking_policy,
          is_active,
          categories (id, name),
          product_images (
            id,
            secure_url,
            cloudinary_public_id,
            is_primary,
            sort_order
          ),
          inventory_balances (
            branch_id,
            quantity,
            average_cost,
            updated_at
          )
        `)
        .eq("organization_id", organizationId)
        .order("name"),
      supabase
        .from("categories")
        .select("id,name,is_active,sort_order")
        .eq("organization_id", organizationId)
        .order("sort_order")
        .order("name"),
      supabase
        .from("suppliers")
        .select("id,name,phone,email,address,is_active,created_at")
        .eq("organization_id", organizationId)
        .order("name"),
      supabase
        .from("stock_movements")
        .select(`
          id,
          movement_type,
          quantity_change,
          quantity_before,
          quantity_after,
          unit_cost,
          reference_table,
          reference_id,
          notes,
          created_at,
          products (id,name,sku,barcode,unit_name,currency)
        `)
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId)
        .order("created_at", { ascending: false })
        .limit(250),
      supabase
        .from("purchases")
        .select(`
          id,
          purchase_number,
          supplier_id,
          status,
          currency,
          total_amount,
          amount_paid,
          supplier_invoice_number,
          received_at,
          created_at,
          suppliers (id,name)
        `)
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("app_settings")
        .select("low_stock_threshold")
        .eq("organization_id", organizationId)
        .maybeSingle(),
      supabase
        .from("reorder_rules")
        .select("product_id,reorder_point,target_stock,is_active")
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId),
      supabase
        .from("inventory_batches")
        .select("id,product_id,batch_number,expiry_date,received_date,quantity,unit_cost,status,updated_at")
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId)
        .order("received_date", { ascending: true })
        .order("created_at", { ascending: true })
    ]);

  for (const result of [
    productResult,
    categoryResult,
    supplierResult,
    movementResult,
    purchaseResult,
    settingsResult,
    reorderResult,
    batchResult
  ]) {
    if (result.error) throw result.error;
  }

  const organizationThreshold = Number(settingsResult?.data?.low_stock_threshold || 0);
  const reorderByProduct = new Map((reorderResult?.data || []).map((rule) => [rule.product_id, rule]));
  const batchesByProduct = new Map();
  for (const batch of batchResult?.data || []) {
    const list = batchesByProduct.get(batch.product_id) || [];
    list.push({
      ...batch,
      quantity: Number(batch.quantity || 0),
      unit_cost: Number(batch.unit_cost || 0)
    });
    batchesByProduct.set(batch.product_id, list);
  }

  const products = (productResult.data || []).map((product) => {
    const balance = (product.inventory_balances || []).find(
      (row) => row.branch_id === branchId
    );

    const stockQuantity = Number(balance?.quantity || 0);
    const rule = reorderByProduct.get(product.id);
    const effectiveThreshold = Number(
      rule?.is_active
        ? rule.reorder_point
        : product.low_stock_threshold ?? organizationThreshold ?? 0
    );
    const image = [...(product.product_images || [])].sort(
      (a, b) => Number(b.is_primary) - Number(a.is_primary)
        || Number(a.sort_order || 0) - Number(b.sort_order || 0)
    )[0] || null;

    return {
      ...product,
      image,
      inventory_batches: batchesByProduct.get(product.id) || [],
      stock_quantity: stockQuantity,
      average_cost: Number(balance?.average_cost || product.default_cost || 0),
      balance_updated_at: balance?.updated_at || null,
      effective_low_stock_threshold: effectiveThreshold,
      stock_status: !product.track_stock
        ? "not_tracked"
        : stockQuantity <= 0
          ? "out_of_stock"
          : stockQuantity <= effectiveThreshold
            ? "low_stock"
            : "healthy"
    };
  });

  return {
    products,
    categories: categoryResult.data || [],
    suppliers: supplierResult.data || [],
    movements: movementResult.data || [],
    purchases: purchaseResult.data || []
  };
}

export async function adjustInventory(supabase, values) {
  if (values.batch_id) {
    const quantity = Number(values.quantity);
    const batchQuantity = Number(values.batch_quantity || 0);
    const quantityChange = values.mode === "remove"
      ? -quantity
      : values.mode === "set"
        ? quantity - batchQuantity
        : quantity;

    if (Math.abs(quantityChange) < 0.0005) {
      throw new Error("The selected batch already has that quantity. No adjustment is needed.");
    }

    const { data, error } = await supabase.rpc("adjust_inventory_batch", {
      p_batch_id: values.batch_id,
      p_quantity_change: quantityChange,
      p_reason: values.reason,
      p_notes: values.notes?.trim() || null
    });

    if (error) throw error;
    return {
      ...data,
      adjustment_number: `Batch ${data?.batch?.batch_number || values.batch_number || "adjustment"}`,
      quantity_after: Number(data?.inventory_quantity_after || 0),
      batch_quantity_after: Number(data?.batch?.quantity || 0)
    };
  }

  const { data, error } = await supabase.rpc("adjust_inventory_v2", {
    p_product_id: values.product_id,
    p_mode: values.mode,
    p_quantity: Number(values.quantity),
    p_reason: values.reason,
    p_notes: values.notes?.trim() || null
  });

  if (error) throw error;
  return data;
}

export async function receivePurchase(supabase, values) {
  const { data, error } = await supabase.rpc("receive_purchase", {
    p_items: values.items.map((item) => ({
      product_id: item.product_id,
      quantity: Number(item.quantity),
      unit_cost: Number(item.unit_cost)
    })),
    p_supplier_id: values.supplier_id || null,
    p_supplier_invoice_number: values.supplier_invoice_number?.trim() || null,
    p_amount_paid: Number(values.amount_paid || 0),
    p_currency: values.currency,
    p_notes: values.notes?.trim() || null
  });

  if (error) throw error;
  return data;
}

export async function createSupplier(supabase, profile, values) {
  const { data, error } = await supabase
    .from("suppliers")
    .insert({
      organization_id: profile.organization_id,
      name: values.name.trim(),
      phone: values.phone.trim() || null,
      email: values.email.trim() || null,
      address: values.address.trim() || null,
      notes: values.notes.trim() || null,
      is_active: true,
      created_by: profile.id
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export function exactProductMatch(products, code) {
  const needle = String(code || "").trim().toLowerCase();
  if (!needle) return null;

  return (
    products.find(
      (product) =>
        String(product.barcode || "").trim().toLowerCase() === needle ||
        String(product.sku || "").trim().toLowerCase() === needle
    ) || null
  );
}
