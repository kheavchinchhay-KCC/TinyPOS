function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function emptyCustomerForm() {
  return {
    id: null,
    customer_code: "",
    customer_type: "regular",
    name: "",
    company_name: "",
    phone: "",
    email: "",
    address: "",
    date_of_birth: "",
    credit_limit: "0",
    allow_unlimited_credit: false,
    notes: "",
    is_active: true
  };
}

export function customerToForm(customer) {
  return {
    id: customer.id,
    customer_code: customer.customer_code || "",
    customer_type: customer.customer_type || "regular",
    name: customer.name || "",
    company_name: customer.company_name || "",
    phone: customer.phone || "",
    email: customer.email || "",
    address: customer.address || "",
    date_of_birth: customer.date_of_birth || "",
    credit_limit: String(customer.credit_limit || 0),
    allow_unlimited_credit: Boolean(customer.allow_unlimited_credit),
    notes: customer.notes || "",
    is_active: Boolean(customer.is_active)
  };
}

export async function loadCustomerDirectory(supabase, organizationId) {
  const { data, error } = await supabase
    .from("customer_directory")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function saveCustomer(supabase, profile, values) {
  const payload = {
    customer_code: values.customer_code.trim().toUpperCase() || null,
    customer_type: values.customer_type,
    name: values.name.trim(),
    company_name: values.company_name.trim() || null,
    phone: values.phone.trim() || null,
    email: values.email.trim().toLowerCase() || null,
    address: values.address.trim() || null,
    date_of_birth: values.date_of_birth || null,
    credit_limit: roundMoney(values.credit_limit),
    allow_unlimited_credit: Boolean(values.allow_unlimited_credit),
    notes: values.notes.trim() || null,
    is_active: Boolean(values.is_active)
  };

  if (values.id) {
    const { data, error } = await supabase
      .from("customers")
      .update(payload)
      .eq("id", values.id)
      .eq("organization_id", profile.organization_id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("customers")
    .insert({
      ...payload,
      organization_id: profile.organization_id,
      created_by: profile.id
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setCustomerStatus(
  supabase,
  profile,
  customerId,
  isActive
) {
  const { data, error } = await supabase
    .from("customers")
    .update({ is_active: Boolean(isActive) })
    .eq("id", customerId)
    .eq("organization_id", profile.organization_id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function adjustCustomerLoyalty(
  supabase,
  customerId,
  pointsChange,
  reason
) {
  const { data, error } = await supabase.rpc(
    "adjust_customer_loyalty",
    {
      p_customer_id: customerId,
      p_points_change: Number(pointsChange),
      p_reason: reason.trim()
    }
  );

  if (error) throw error;
  return data;
}

export async function loadCustomerDetail(
  supabase,
  profile,
  customerId
) {
  const [salesResult, returnsResult, loyaltyResult] = await Promise.all([
    supabase
      .from("sales")
      .select(`
        id,
        invoice_number,
        branch_id,
        status,
        payment_status,
        currency,
        subtotal,
        discount_amount,
        tax_amount,
        total_amount,
        gross_profit,
        completed_at,
        created_at,
        branches (
          id,
          name,
          code
        ),
        payments (
          id,
          method,
          amount,
          reference_number
        ),
        sale_items (
          id,
          product_name,
          barcode,
          quantity,
          unit_price,
          line_total
        )
      `)
      .eq("organization_id", profile.organization_id)
      .eq("customer_id", customerId)
      .in("status", ["completed", "partially_refunded", "refunded"])
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("returns")
      .select(`
        id,
        return_number,
        original_sale_id,
        branch_id,
        status,
        currency,
        refund_amount,
        refund_method,
        refund_reference,
        reason,
        processed_at,
        branches (
          id,
          name,
          code
        ),
        sales!returns_original_sale_id_fkey (
          invoice_number
        ),
        return_items (
          id,
          quantity,
          line_refund,
          restock,
          sale_items!return_items_sale_item_id_fkey (
            product_name,
            barcode
          )
        )
      `)
      .eq("organization_id", profile.organization_id)
      .eq("customer_id", customerId)
      .eq("status", "completed")
      .order("processed_at", { ascending: false })
      .limit(100),
    supabase
      .from("customer_loyalty_movements")
      .select(`
        id,
        points_change,
        points_before,
        points_after,
        reason,
        created_at
      `)
      .eq("organization_id", profile.organization_id)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  for (const result of [salesResult, returnsResult, loyaltyResult]) {
    if (result.error) throw result.error;
  }

  return {
    sales: salesResult.data || [],
    returns: returnsResult.data || [],
    loyalty: loyaltyResult.data || []
  };
}
