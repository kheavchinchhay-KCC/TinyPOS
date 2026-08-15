import {
  authenticatedProfile,
  json
} from "./_telegram-shared.mjs";
import { dispatchOperationalEvent } from "./_telegram-events.mjs";

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  try {
    const { profile, service } = await authenticatedProfile(request);
    const body = await request.json().catch(() => ({}));
    const eventType = String(body.event_type || "").trim();
    const entityId = String(body.entity_id || "").trim();

    if (!eventType || !/^[0-9a-f-]{36}$/i.test(entityId)) {
      return json({ ok: false, error: "Valid event type and entity ID are required." }, 400);
    }

    const eventKey = `${eventType}:${entityId}`;
    const { data: event, error } = await service
      .from("telegram_operational_events")
      .select("id,organization_id")
      .eq("event_key", eventKey)
      .maybeSingle();
    if (error) throw error;
    if (!event || event.organization_id !== profile.organization_id) {
      return json({ ok: true, queued: false, reason: "Event is not available yet." });
    }

    const result = await dispatchOperationalEvent(service, event.id);
    return json({ ok: true, queued: true, ...result });
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
