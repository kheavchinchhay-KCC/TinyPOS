export function batchDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" })
    .format(new Date(`${String(value).slice(0, 10)}T00:00:00`));
}

export function batchDaysRemaining(value) {
  if (!value) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Math.ceil((expiry - today) / 86400000);
}

export function effectiveBatchStatus(batch) {
  if (batch.status === "depleted" || Number(batch.quantity || 0) <= 0) return "depleted";
  if (batch.status === "quarantined") return "quarantined";
  const days = batchDaysRemaining(batch.expiry_date);
  if (days !== null && days < 0) return "expired";
  if (days !== null && days <= 30) return "expiring";
  return "active";
}

export async function loadBatchWorkspace(supabase, profile) {
  const [productResult, batchResult] = await Promise.all([
    supabase.from("products").select(`
      id,name,name_km,sku,barcode,unit_name,currency,is_active,track_stock,
      batch_tracking,expiry_tracking,picking_policy,default_shelf_life_days,
      categories(id,name),inventory_balances(branch_id,quantity,average_cost)
    `).eq("organization_id", profile.organization_id).eq("is_active", true)
      .eq("track_stock", true).order("name"),
    supabase.from("inventory_batches").select(`
      id,organization_id,branch_id,product_id,batch_number,expiry_date,received_date,
      source_type,initial_quantity,quantity,unit_cost,status,notes,created_at,updated_at,
      products(id,name,name_km,sku,barcode,unit_name,currency,batch_tracking,expiry_tracking,picking_policy),
      suppliers(id,supplier_code,name),
      purchase_receipt_items(id,receipt_id,purchase_receipts(id,receipt_number,purchase_id))
    `).eq("organization_id", profile.organization_id).eq("branch_id", profile.branch_id)
      .order("expiry_date", { ascending: true, nullsFirst: false })
      .order("received_date", { ascending: true })
  ]);
  if (productResult.error) throw productResult.error;
  if (batchResult.error) throw batchResult.error;
  const products = (productResult.data || []).map((product) => {
    const balance = (product.inventory_balances || []).find((row) => row.branch_id === profile.branch_id);
    return { ...product, stock_quantity: Number(balance?.quantity || 0), average_cost: Number(balance?.average_cost || 0) };
  });
  const batches = (batchResult.data || []).map((batch) => ({
    ...batch,
    initial_quantity: Number(batch.initial_quantity || 0),
    quantity: Number(batch.quantity || 0),
    unit_cost: Number(batch.unit_cost || 0)
  }));
  return { products, batches };
}

export async function saveProductBatchSettings(supabase, productId, values) {
  const { data, error } = await supabase.rpc("save_product_batch_settings", {
    p_product_id: productId,
    p_batch_tracking: Boolean(values.batch_tracking),
    p_expiry_tracking: Boolean(values.expiry_tracking),
    p_picking_policy: values.picking_policy || "fifo",
    p_default_shelf_life_days: values.expiry_tracking && values.default_shelf_life_days
      ? Number(values.default_shelf_life_days) : null
  });
  if (error) throw error;
  return data;
}

export async function createInventoryBatch(supabase, values) {
  const { data, error } = await supabase.rpc("create_inventory_batch", {
    p_product_id: values.product_id,
    p_batch_number: values.batch_number.trim(),
    p_expiry_date: values.expiry_date || null,
    p_quantity: Number(values.quantity),
    p_unit_cost: values.unit_cost === "" ? null : Number(values.unit_cost),
    p_received_date: values.received_date || null,
    p_notes: values.notes?.trim() || null,
    p_assign_existing_stock: Boolean(values.assign_existing_stock)
  });
  if (error) throw error;
  return data;
}

export async function adjustInventoryBatch(supabase, values) {
  const { data, error } = await supabase.rpc("adjust_inventory_batch", {
    p_batch_id: values.batch_id,
    p_quantity_change: Number(values.quantity_change),
    p_reason: values.reason.trim(),
    p_notes: values.notes?.trim() || null
  });
  if (error) throw error;
  return data;
}

export async function changeInventoryBatchStatus(supabase, batchId, status, reason = "") {
  const { data, error } = await supabase.rpc("set_inventory_batch_status", {
    p_batch_id: batchId,
    p_status: status,
    p_reason: reason.trim() || null
  });
  if (error) throw error;
  return data;
}
