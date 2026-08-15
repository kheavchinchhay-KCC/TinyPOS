import { savePurchaseOrder } from "./purchaseOrders";

export function reorderStatusLabel(status) {
  const labels = {
    out_of_stock: "Out of stock",
    reorder: "Reorder now",
    draft_order: "Draft PO exists",
    incoming: "Incoming stock",
    unconfigured: "Default rule",
    ok: "Stock healthy"
  };

  return labels[status] || status;
}

export function reorderStatusClass(status) {
  const classes = {
    out_of_stock: "danger",
    reorder: "warning",
    draft_order: "draft",
    incoming: "incoming",
    unconfigured: "muted",
    ok: "healthy"
  };

  return classes[status] || "muted";
}

export async function loadReorderWorkspace(supabase, profile) {
  const [suggestionResult, supplierResult] =
    await Promise.all([
      supabase.rpc("get_reorder_suggestions"),
      supabase
        .from("suppliers")
        .select(
          "id,supplier_code,name,is_active,phone,email"
        )
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name")
    ]);

  if (suggestionResult.error) {
    throw suggestionResult.error;
  }

  if (supplierResult.error) {
    throw supplierResult.error;
  }

  const suggestions = Array.isArray(suggestionResult.data)
    ? suggestionResult.data
    : [];
  const productIds = [...new Set(
    suggestions.map((item) => item.product_id).filter(Boolean)
  )];
  const imageByProduct = new Map();

  if (productIds.length > 0) {
    const { data: productRows, error: productError } = await supabase
      .from("products")
      .select(`
        id,
        product_images (
          secure_url,
          is_primary,
          sort_order
        )
      `)
      .in("id", productIds);

    if (productError) throw productError;

    for (const product of productRows || []) {
      const image = [...(product.product_images || [])].sort(
        (a, b) =>
          Number(b.is_primary) - Number(a.is_primary)
          || Number(a.sort_order || 0) - Number(b.sort_order || 0)
      )[0];
      imageByProduct.set(product.id, image?.secure_url || null);
    }
  }

  return {
    suggestions: suggestions.map((item) => ({
      ...item,
      product_image_url: imageByProduct.get(item.product_id) || null
    })),
    suppliers: supplierResult.data || []
  };
}

export async function saveReorderRule(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_reorder_rule",
    {
      p_product_id: values.product_id,
      p_reorder_point: Number(
        values.reorder_point || 0
      ),
      p_target_stock: Number(
        values.target_stock || 0
      ),
      p_preferred_supplier_id:
        values.preferred_supplier_id || null,
      p_purchase_unit_id:
        values.purchase_unit_id || null,
      p_minimum_order_quantity: Number(
        values.minimum_order_quantity || 1
      ),
      p_lead_time_days: Number(
        values.lead_time_days || 0
      ),
      p_supplier_sku:
        values.supplier_sku?.trim() || null,
      p_is_active: Boolean(values.is_active)
    }
  );

  if (error) throw error;
  return data;
}

function expectedDateFromLeadTime(days) {
  const date = new Date();
  date.setDate(
    date.getDate() + Math.max(0, Number(days || 0))
  );
  return date.toISOString().slice(0, 10);
}

export async function createDraftPurchaseOrders(
  supabase,
  suggestions,
  profile
) {
  const eligible = suggestions.filter(
    (item) =>
      item.can_create_order
      && item.preferred_supplier_id
      && item.purchase_unit_id
      && Number(item.suggested_purchase_quantity) > 0
  );

  if (eligible.length === 0) {
    throw new Error(
      "No selected item is ready for a draft purchase order."
    );
  }

  const groups = new Map();

  for (const item of eligible) {
    const key = [
      item.preferred_supplier_id,
      item.currency
    ].join("::");

    if (!groups.has(key)) {
      groups.set(key, {
        supplier_id: item.preferred_supplier_id,
        supplier_name:
          item.preferred_supplier_name || "Supplier",
        currency: item.currency,
        lead_time_days: 0,
        items: []
      });
    }

    const group = groups.get(key);
    group.lead_time_days = Math.max(
      group.lead_time_days,
      Number(item.lead_time_days || 0)
    );

    group.items.push({
      product_id: item.product_id,
      product_unit_id: item.purchase_unit_id,
      quantity: Number(
        item.suggested_purchase_quantity
      ),
      unit_cost: Number(
        item.estimated_purchase_unit_cost || 0
      )
    });
  }

  const created = [];

  for (const group of groups.values()) {
    const result = await savePurchaseOrder(
      supabase,
      {
        purchase_id: null,
        supplier_id: group.supplier_id,
        items: group.items,
        currency: group.currency,
        discount_amount: 0,
        tax_amount: 0,
        expected_date: expectedDateFromLeadTime(
          group.lead_time_days
        ),
        supplier_invoice_number: "",
        payment_terms: "",
        delivery_address: "",
        notes: [
          "Draft created by Tiny POS Reorder Planner.",
          `Branch: ${profile.branches?.name || "Current branch"}.`
        ].join(" "),
        status: "draft"
      }
    );

    created.push({
      ...result,
      supplier_name: group.supplier_name,
      item_count: group.items.length
    });
  }

  return created;
}
