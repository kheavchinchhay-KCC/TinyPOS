export function telegramWebApp() {
  return window.Telegram?.WebApp || null;
}

export function isTelegramMiniApp() {
  const app = telegramWebApp();
  return Boolean(app?.initData);
}

export function telegramUnsafeUser() {
  return telegramWebApp()?.initDataUnsafe?.user || null;
}

export function openTelegramUrl(url) {
  const app = telegramWebApp();

  if (app?.openTelegramLink) {
    app.openTelegramLink(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export async function telegramAdminRequest(
  session,
  action = "status",
  payload = {}
) {
  const response = await fetch("/api/telegram-admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ action, ...payload })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.ok) {
    throw new Error(
      body.error || "Telegram request failed."
    );
  }

  return body;
}

export async function createTelegramLinkCode(supabase) {
  const { data, error } = await supabase.rpc(
    "create_my_telegram_link_code"
  );

  if (error) throw error;
  return data;
}

export async function saveTelegramPreferences(
  supabase,
  preferences
) {
  const { data, error } = await supabase.rpc(
    "save_my_telegram_preferences",
    { p_preferences: preferences }
  );

  if (error) throw error;
  return data;
}

export async function disconnectTelegram(supabase) {
  const { data, error } = await supabase.rpc(
    "disconnect_my_telegram"
  );

  if (error) throw error;
  return data;
}

export function telegramLinkUrl(botUsername, code) {
  return `https://t.me/${botUsername}?start=link_${code}`;
}

export function telegramDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export async function notifyTelegramEvent(
  session,
  eventType,
  entityId
) {
  if (!session?.access_token || !eventType || !entityId) return null;

  try {
    const response = await fetch("/api/telegram-event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        event_type: eventType,
        entity_id: entityId
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(body.error || "Telegram event dispatch failed.");
    }
    return body;
  } catch (error) {
    // The database outbox remains pending and the scheduled dispatcher retries.
    console.warn("Tiny POS Telegram event queued for retry:", error.message);
    return null;
  }
}
