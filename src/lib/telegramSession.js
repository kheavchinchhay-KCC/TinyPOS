import {
  isTelegramMiniApp,
  telegramUnsafeUser,
  telegramWebApp
} from "./telegram";

const TELEGRAM_LOGOUT_PREFIX = "tiny-pos-telegram-explicit-logout";

function explicitLogoutKey() {
  const telegramId = telegramUnsafeUser()?.id;
  return `${TELEGRAM_LOGOUT_PREFIX}:${telegramId || "unknown"}`;
}

export function hasTelegramExplicitLogout() {
  if (!isTelegramMiniApp()) return false;

  try {
    return window.localStorage.getItem(explicitLogoutKey()) === "1";
  } catch {
    return false;
  }
}

export function markTelegramExplicitLogout() {
  if (!isTelegramMiniApp()) return;

  try {
    window.localStorage.setItem(explicitLogoutKey(), "1");
  } catch {
    // Storage is optional. Supabase sign-out still clears the active session.
  }
}

export function clearTelegramExplicitLogout() {
  if (!isTelegramMiniApp()) return;

  try {
    window.localStorage.removeItem(explicitLogoutKey());
  } catch {
    // Storage is optional.
  }
}

export async function resolveTelegramLinkedSession(supabase) {
  if (!isTelegramMiniApp()) return { resolved: false, linked: false };

  const app = telegramWebApp();
  if (!app?.initData) return { resolved: false, linked: false };

  // An explicit Log out must be respected. The linked Telegram account may
  // sign in automatically only while the user has not deliberately logged out.
  // A normal email/password sign-in clears this marker again.
  if (hasTelegramExplicitLogout()) {
    const {
      data: { session: currentSession }
    } = await supabase.auth.getSession();

    if (currentSession) {
      await supabase.auth.signOut({ scope: "local" });
    }

    return {
      resolved: true,
      linked: false,
      explicitLogout: true
    };
  }

  const {
    data: { session: currentSession }
  } = await supabase.auth.getSession();

  const response = await fetch("/api/telegram-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      init_data: app.initData,
      current_user_id: currentSession?.user?.id || null
    })
  });

  const body = await response.json().catch(() => ({}));

  if (response.status === 404 || body.linked === false) {
    if (currentSession) await supabase.auth.signOut({ scope: "local" });
    return { resolved: true, linked: false };
  }

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Could not resolve the Telegram POS account.");
  }

  if (currentSession?.user?.id === body.user_id) {
    return { resolved: true, linked: true, userId: body.user_id };
  }

  if (!body.token_hash) {
    throw new Error("Telegram-linked POS session token was not created.");
  }

  if (currentSession) await supabase.auth.signOut({ scope: "local" });

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: body.token_hash,
    type: "email"
  });

  if (error || !data.session) {
    throw new Error(error?.message || "Could not sign in the Telegram-linked POS user.");
  }

  return { resolved: true, linked: true, userId: body.user_id };
}
