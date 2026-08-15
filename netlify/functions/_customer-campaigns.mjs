import { escapeHtml, miniAppUrl, sendTelegramMessage, serviceClient, telegramApi } from "./_telegram-shared.mjs";

function campaignText(campaign, recipient, coupon) {
  const km = recipient.language === "km";
  const title = km ? (campaign.title_km || campaign.title_en) : campaign.title_en;
  const message = km ? (campaign.message_km || campaign.message_en) : campaign.message_en;
  const lines = [`📣 <b>${escapeHtml(title)}</b>`, "", escapeHtml(message)];
  if (coupon?.code) lines.push("", km ? `🎟 កូដប័ណ្ណ: <code>${escapeHtml(coupon.code)}</code>` : `🎟 Coupon: <code>${escapeHtml(coupon.code)}</code>`);
  if (Number(campaign.bonus_points || 0) > 0) lines.push(km ? `🎁 ពិន្ទុបន្ថែម: <b>${Number(campaign.bonus_points).toLocaleString("en-US")}</b>` : `🎁 Bonus points: <b>${Number(campaign.bonus_points).toLocaleString("en-US")}</b>`);
  lines.push("", km ? "ផ្ញើ /stop ដើម្បីឈប់ទទួលសារផ្សព្វផ្សាយ។" : "Send /stop to stop marketing messages.");
  return lines.join("\n");
}

export async function dispatchCampaign(campaignId, limit = 100) {
  const service = serviceClient();
  const { data: campaign, error: campaignError } = await service.from("customer_campaigns").select("*,coupons(code,name)").eq("id", campaignId).single();
  if (campaignError) throw campaignError;
  if (["cancelled","completed"].includes(campaign.status)) return { ok: true, skipped: true, status: campaign.status };
  const { error: prepareError } = await service.rpc("prepare_customer_campaign_recipients", { p_campaign_id: campaignId });
  if (prepareError) throw prepareError;
  const { data: recipients, error: recipientError } = await service.from("customer_campaign_recipients").select("*,customers(name,preferred_language,marketing_opt_in)").eq("campaign_id", campaignId).eq("status", "pending").limit(limit);
  if (recipientError) throw recipientError;
  let sent = 0;
  let failed = 0;
  if (!(recipients || []).length) {
    await service.from("customer_campaigns").update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", campaignId);
    return { ok: true, campaign_id: campaignId, processed: 0, sent: 0, failed: 0 };
  }
  let storeUrl = null;
  if (campaign.branch_id) {
    const { data: store } = await service
      .from("online_store_settings")
      .select("store_slug,is_published")
      .eq("branch_id", campaign.branch_id)
      .eq("is_published", true)
      .maybeSingle();
    if (store?.store_slug) storeUrl = miniAppUrl(`/shop/${store.store_slug}`);
  }
  for (const recipient of recipients || []) {
    try {
      if (!recipient.chat_id || !recipient.customers?.marketing_opt_in) {
        await service.rpc("mark_customer_campaign_recipient", { p_recipient_id: recipient.id, p_status: "skipped", p_error: "Customer is not eligible." });
        continue;
      }
      const payload = {
        chat_id: recipient.chat_id,
        text: campaignText(campaign, recipient, campaign.coupons),
        parse_mode: "HTML",
        disable_web_page_preview: true
      };
      if (storeUrl) payload.reply_markup = { inline_keyboard: [[{ text: recipient.language === "km" ? "បើកហាង" : "Open Store", url: storeUrl }]] };
      const result = await telegramApi("sendMessage", payload);
      await service.rpc("mark_customer_campaign_recipient", { p_recipient_id: recipient.id, p_status: "sent", p_message_id: result.message_id });
      sent += 1;
    } catch (error) {
      failed += 1;
      await service.rpc("mark_customer_campaign_recipient", { p_recipient_id: recipient.id, p_status: "failed", p_error: String(error.message || error).slice(0, 1000) });
    }
  }
  return { ok: true, campaign_id: campaignId, processed: (recipients || []).length, sent, failed };
}

export async function dispatchDueCampaigns(limitCampaigns = 10) {
  const service = serviceClient();
  const { data, error } = await service.from("customer_campaigns").select("id").in("status", ["scheduled","sending"]).lte("scheduled_at", new Date().toISOString()).order("scheduled_at").limit(limitCampaigns);
  if (error) throw error;
  const results = [];
  for (const row of data || []) results.push(await dispatchCampaign(row.id));
  return results;
}
