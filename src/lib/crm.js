function clean(value) {
  return String(value ?? "").trim();
}

export async function loadCrmDashboard(supabase, branchId = null) {
  const { data, error } = await supabase.rpc("get_crm_dashboard", {
    p_branch_id: branchId || null
  });
  if (error) throw error;
  return data || {};
}

export async function loadCrmCustomers(supabase, organizationId) {
  const { data, error } = await supabase
    .from("crm_customer_directory")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name")
    .limit(1000);
  if (error) throw error;
  return data || [];
}

export async function loadCrmSetup(supabase, organizationId) {
  const [tags, segments, campaigns, loyalty, coupons] = await Promise.all([
    supabase.from("crm_tags").select("*").eq("organization_id", organizationId).order("name"),
    supabase.from("crm_segments").select("*").eq("organization_id", organizationId).order("name"),
    supabase.from("customer_campaigns").select("*,crm_segments(name),coupons(code,name)").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(200),
    supabase.from("loyalty_program_settings").select("*").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("coupons").select("id,code,name,is_active,starts_at,ends_at").eq("organization_id", organizationId).eq("is_active", true).order("name")
  ]);
  for (const result of [tags, segments, campaigns, loyalty, coupons]) {
    if (result.error) throw result.error;
  }
  return {
    tags: tags.data || [],
    segments: segments.data || [],
    campaigns: campaigns.data || [],
    loyalty: loyalty.data || null,
    coupons: coupons.data || []
  };
}

export async function saveCrmTag(supabase, profile, values) {
  const payload = {
    organization_id: profile.organization_id,
    name: clean(values.name),
    description: clean(values.description) || null,
    is_active: values.is_active !== false,
    created_by: profile.id,
    updated_at: new Date().toISOString()
  };
  if (values.id) {
    const { data, error } = await supabase.from("crm_tags").update(payload).eq("id", values.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from("crm_tags").insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function setCustomerTags(supabase, profile, customerId, tagIds) {
  const { error: deleteError } = await supabase.from("crm_customer_tags").delete().eq("customer_id", customerId);
  if (deleteError) throw deleteError;
  if (!tagIds.length) return;
  const { error } = await supabase.from("crm_customer_tags").insert(tagIds.map((tagId) => ({
    organization_id: profile.organization_id,
    customer_id: customerId,
    tag_id: tagId,
    assigned_by: profile.id
  })));
  if (error) throw error;
}

export async function saveCrmSegment(supabase, profile, values) {
  const payload = {
    organization_id: profile.organization_id,
    branch_id: values.branch_id || null,
    name: clean(values.name),
    description: clean(values.description) || null,
    rules: values.rules || {},
    is_active: values.is_active !== false,
    created_by: profile.id,
    updated_at: new Date().toISOString()
  };
  if (values.id) {
    const { data, error } = await supabase.from("crm_segments").update(payload).eq("id", values.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from("crm_segments").insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function previewCrmSegment(supabase, rules, branchId = null) {
  const { data, error } = await supabase.rpc("preview_crm_segment", {
    p_rules: rules || {},
    p_branch_id: branchId || null
  });
  if (error) throw error;
  return data || { count: 0, telegram_eligible: 0, sample: [] };
}

export async function saveLoyaltySettings(supabase, values) {
  const { data, error } = await supabase.rpc("save_loyalty_program_settings", { p_values: values });
  if (error) throw error;
  return data;
}

export async function saveCustomerCampaign(supabase, values) {
  const { data, error } = await supabase.rpc("save_customer_campaign", { p_values: values });
  if (error) throw error;
  return data;
}

export async function createCustomerTelegramCode(supabase, customerId) {
  const { data, error } = await supabase.rpc("create_customer_telegram_link_code", { p_customer_id: customerId });
  if (error) throw error;
  return data;
}

export async function recordCustomerContact(supabase, values) {
  const { data, error } = await supabase.rpc("record_customer_contact", {
    p_customer_id: values.customer_id,
    p_channel: values.channel,
    p_direction: values.direction,
    p_subject: clean(values.subject) || null,
    p_note: clean(values.note),
    p_follow_up_at: values.follow_up_at || null
  });
  if (error) throw error;
  return data;
}

export async function dispatchCustomerCampaign(session, campaignId) {
  const response = await fetch("/api/customer-campaigns", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ action: "dispatch", campaign_id: campaignId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "Campaign dispatch failed.");
  return result;
}
