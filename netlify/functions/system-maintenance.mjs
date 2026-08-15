import {
  sendTelegramMessage,
  serviceClient
} from "./_telegram-shared.mjs";
import { tg, telegramLanguage } from "./_telegram-i18n.mjs";

const RELEASE = "tiny-pos-v1.0.0-rc1-step37";

export const config = { schedule: "15 */6 * * *" };

function criticalKeys(run) {
  return (run?.checks || [])
    .filter((check) => check.status === "fail" && check.severity === "critical")
    .map((check) => check.key)
    .sort();
}

async function notifyCritical(service, organizationId, run) {
  const keys = criticalKeys(run);
  if (keys.length === 0) return 0;

  const { data: links, error: linkError } = await service
    .from("telegram_user_links")
    .select("id,user_id,chat_id")
    .eq("organization_id", organizationId)
    .eq("is_active", true);
  if (linkError) throw linkError;
  if (!links?.length) return 0;

  const ids = links.map((row) => row.user_id);
  const [profilesResult, preferencesResult, languageResult] = await Promise.all([
    service.from("profiles").select("id,role,is_active").in("id", ids),
    service.from("telegram_notification_preferences").select("user_id,system_alerts").in("user_id", ids),
    service.from("user_preferences").select("user_id,language").in("user_id", ids)
  ]);
  for (const result of [profilesResult, preferencesResult, languageResult]) {
    if (result.error) throw result.error;
  }

  const profiles = new Map((profilesResult.data || []).map((row) => [row.id, row]));
  const preferences = new Map((preferencesResult.data || []).map((row) => [row.user_id, row]));
  const languages = new Map((languageResult.data || []).map((row) => [row.user_id, row.language]));
  const date = new Date().toISOString().slice(0, 10);
  const keySuffix = keys.join("-").slice(0, 500);
  let sent = 0;

  for (const link of links) {
    const profile = profiles.get(link.user_id);
    if (!profile?.is_active || !["owner", "admin"].includes(profile.role)) continue;
    if (preferences.get(link.user_id)?.system_alerts === false) continue;

    const language = telegramLanguage(languages.get(link.user_id));
    const eventKey = `system-health:${date}:${keySuffix}`;
    const text = [
      `<b>${tg(language, "system_health_title")}</b>`,
      tg(language, "system_health_score", { score: run.score }),
      tg(language, "system_health_critical", { count: run.critical_count }),
      tg(language, "system_health_help")
    ].join("\n");

    const { data: delivery, error: reserveError } = await service
      .from("telegram_notification_deliveries")
      .insert({
        organization_id: organizationId,
        user_id: link.user_id,
        telegram_link_id: link.id,
        event_type: "system",
        event_key: eventKey,
        chat_id: link.chat_id,
        message_text: text,
        status: "pending",
        payload: { run_id: run.id, checks: keys }
      })
      .select("id")
      .single();

    if (reserveError?.code === "23505") continue;
    if (reserveError) throw reserveError;

    try {
      const message = await sendTelegramMessage({
        chatId: link.chat_id,
        text,
        path: "/system-health",
        buttonText: tg(language, "open_system_health")
      });
      await service.from("telegram_notification_deliveries").update({
        status: "sent",
        telegram_message_id: message.message_id,
        sent_at: new Date().toISOString()
      }).eq("id", delivery.id);
      sent += 1;
    } catch (error) {
      await service.from("telegram_notification_deliveries").update({
        status: "failed",
        error_message: String(error.message || error).slice(0, 1000)
      }).eq("id", delivery.id);
    }
  }

  return sent;
}

export default async () => {
  const service = serviceClient();
  const { data: organizations, error } = await service
    .from("organizations")
    .select("id")
    .order("created_at");
  if (error) throw error;

  const results = [];
  for (const organization of organizations || []) {
    try {
      const { data: run, error: runError } = await service.rpc(
        "run_system_health_check_service",
        { p_organization_id: organization.id, p_release: RELEASE }
      );
      if (runError) throw runError;
      const sent = run.overall_status === "critical"
        ? await notifyCritical(service, organization.id, run)
        : 0;
      results.push({ organization_id: organization.id, status: run.overall_status, sent });
    } catch (runError) {
      results.push({ organization_id: organization.id, error: runError.message });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" }
  });
};
