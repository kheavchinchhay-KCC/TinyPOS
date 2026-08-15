import { createClient } from "@supabase/supabase-js";

let promise;

function telegramStorageScope() {
  try {
    const telegramUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    return telegramUserId ? `telegram-${telegramUserId}` : "browser";
  } catch {
    return "browser";
  }
}

export function getSupabase() {
  if (!promise) {
    promise = (async () => {
      const response = await fetch("/api/public-config");
      const config = await response.json();

      if (!response.ok || !config.ok) {
        throw new Error(config.error || "Could not load configuration");
      }

      return createClient(config.supabaseUrl, config.supabaseKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: `tiny-pos-auth-${telegramStorageScope()}`
        }
      });
    })();
  }

  return promise;
}
