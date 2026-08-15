import { authenticatedProfile, json } from "./_telegram-shared.mjs";
import { dispatchCampaign } from "./_customer-campaigns.mjs";
import { hasEffectivePermission } from "./_permission.mjs";

export default async (request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
    const context = await authenticatedProfile(request);
    if (!await hasEffectivePermission(context.service, context.profile, "crm.campaigns.send", ["admin", "manager"])) return json({ ok: false, error: "Permission required: crm.campaigns.send" }, 403);
    const body = await request.json().catch(() => ({}));
    if (body.action !== "dispatch" || !body.campaign_id) return json({ ok: false, error: "Campaign ID is required." }, 400);
    const { data: campaign, error } = await context.service.from("customer_campaigns").select("id,organization_id").eq("id", body.campaign_id).eq("organization_id", context.profile.organization_id).single();
    if (error || !campaign) return json({ ok: false, error: "Campaign not found." }, 404);
    return json(await dispatchCampaign(campaign.id));
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
