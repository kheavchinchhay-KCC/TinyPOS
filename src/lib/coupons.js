function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function couponStatus(coupon) {
  const now = Date.now();
  const start = new Date(coupon.starts_at).getTime();
  const end = coupon.ends_at
    ? new Date(coupon.ends_at).getTime()
    : null;

  if (!coupon.is_active) return "inactive";
  if (Number.isFinite(start) && now < start) return "scheduled";
  if (Number.isFinite(end) && now > end) return "expired";
  if (
    coupon.usage_limit !== null &&
    Number(coupon.usage_count || 0) >= Number(coupon.usage_limit)
  ) {
    return "used_up";
  }
  return "active";
}

export async function loadCouponsWorkspace(supabase, profile) {
  const [couponResult, branchResult, redemptionResult] = await Promise.all([
    supabase
      .from("coupons")
      .select(`
        id,
        organization_id,
        branch_id,
        code,
        name,
        description,
        discount_type,
        discount_value,
        max_discount_amount,
        minimum_spend,
        currency,
        customer_type,
        starts_at,
        ends_at,
        usage_limit,
        per_customer_limit,
        is_active,
        created_at,
        updated_at,
        branches (id,name,code)
      `)
      .eq("organization_id", profile.organization_id)
      .order("created_at", { ascending: false }),
    supabase
      .from("branches")
      .select("id,name,code,is_active")
      .eq("organization_id", profile.organization_id)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("coupon_redemptions")
      .select(`
        id,
        coupon_id,
        sale_id,
        customer_id,
        coupon_code,
        discount_amount,
        currency,
        redeemed_at,
        branches (id,name,code),
        customers (id,name,customer_code),
        sales (id,invoice_number,total_amount)
      `)
      .eq("organization_id", profile.organization_id)
      .order("redeemed_at", { ascending: false })
      .limit(500)
  ]);

  for (const result of [couponResult, branchResult, redemptionResult]) {
    if (result.error) throw result.error;
  }

  const redemptionMap = new Map();

  for (const redemption of redemptionResult.data || []) {
    const current = redemptionMap.get(redemption.coupon_id) || {
      count: 0,
      discount_total: 0,
      latest_at: null
    };

    current.count += 1;
    current.discount_total += Number(redemption.discount_amount || 0);
    current.latest_at = current.latest_at || redemption.redeemed_at;
    redemptionMap.set(redemption.coupon_id, current);
  }

  const coupons = (couponResult.data || []).map((coupon) => {
    const usage = redemptionMap.get(coupon.id) || {
      count: 0,
      discount_total: 0,
      latest_at: null
    };

    const hydrated = {
      ...coupon,
      usage_count: usage.count,
      discount_total: usage.discount_total,
      latest_redemption_at: usage.latest_at
    };

    return {
      ...hydrated,
      computed_status: couponStatus(hydrated)
    };
  });

  return {
    coupons,
    branches: branchResult.data || [],
    redemptions: redemptionResult.data || []
  };
}

export async function saveCoupon(supabase, profile, values) {
  const payload = {
    organization_id: profile.organization_id,
    branch_id: values.branch_id || null,
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    description: values.description.trim() || null,
    discount_type: values.discount_type,
    discount_value: Number(values.discount_value),
    max_discount_amount:
      values.discount_type === "percent" && values.max_discount_amount
        ? Number(values.max_discount_amount)
        : null,
    minimum_spend: Number(values.minimum_spend || 0),
    currency: values.currency,
    customer_type: values.customer_type || null,
    starts_at: toIsoOrNull(values.starts_at) || new Date().toISOString(),
    ends_at: toIsoOrNull(values.ends_at),
    usage_limit: values.usage_limit
      ? Number.parseInt(values.usage_limit, 10)
      : null,
    per_customer_limit: values.per_customer_limit
      ? Number.parseInt(values.per_customer_limit, 10)
      : null,
    is_active: Boolean(values.is_active),
    updated_by: profile.id
  };

  if (values.id) {
    const { data, error } = await supabase
      .from("coupons")
      .update(payload)
      .eq("id", values.id)
      .eq("organization_id", profile.organization_id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("coupons")
    .insert({
      ...payload,
      created_by: profile.id
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setCouponActive(
  supabase,
  profile,
  couponId,
  isActive
) {
  const { data, error } = await supabase
    .from("coupons")
    .update({
      is_active: Boolean(isActive),
      updated_by: profile.id
    })
    .eq("id", couponId)
    .eq("organization_id", profile.organization_id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
