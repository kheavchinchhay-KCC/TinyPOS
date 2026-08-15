import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import { getSupabase } from "../lib/supabase";
import {
  clearTelegramExplicitLogout,
  markTelegramExplicitLogout,
  resolveTelegramLinkedSession
} from "../lib/telegramSession";
import {
  accessAllows,
  accessAllowsAny,
  fallbackAccessForRole,
  loadMyAccess
} from "../lib/permissions";
import {
  clearOfflineAuthSnapshot,
  loadOfflineAuthSnapshot,
  saveOfflineAuthSnapshot
} from "../lib/offlineCheckout";
import {
  saveShopSettings as persistShopSettings,
  shopFormFromSettings
} from "../lib/settings";

const AuthContext = createContext(null);

async function loadProfileWithCustomRole(client, userId) {
  // Load the core profile first. Do not embed custom_staff_roles here:
  // Step 46 creates multiple foreign keys between profiles and custom roles,
  // which can make the PostgREST relationship ambiguous and prevent every
  // account (owner/admin/cashier) from loading.
  const { data: baseProfile, error: profileError } = await client
    .from("profiles")
    .select("*,organizations(*),branches(*)")
    .eq("id", userId)
    .single();

  if (profileError || !baseProfile) {
    throw new Error(profileError?.message || "POS profile not found.");
  }

  if (!baseProfile.custom_role_id) {
    return {
      ...baseProfile,
      custom_staff_roles: null
    };
  }

  // A custom role is optional. If its table/relationship is temporarily
  // unavailable, keep the user's standard base role instead of locking the
  // entire POS.
  const { data: customRole, error: customRoleError } = await client
    .from("custom_staff_roles")
    .select("id,name,description,base_role,is_active")
    .eq("id", baseProfile.custom_role_id)
    .eq("organization_id", baseProfile.organization_id)
    .maybeSingle();

  if (customRoleError) {
    console.warn("Tiny POS custom role could not be loaded:", customRoleError.message);
  }

  return {
    ...baseProfile,
    custom_staff_roles: customRole || null
  };
}

function normalizeThemeMode(value) {
  return value === "dark" || value === "light" || value === "system"
    ? value
    : "system";
}

function applyPreferences(preferences) {
  const root = document.documentElement;
  const theme = normalizeThemeMode(
    preferences?.theme || preferences?.theme_mode || "system"
  );
  const accent = preferences?.accent_color || "#2563eb";

  root.dataset.theme = theme;
  root.dataset.forceTheme = theme === "system" ? "" : theme;
  root.style.setProperty("--accent", accent);
}

export function AuthProvider({ children }) {
  const [supabase, setSupabase] = useState();
  const [session, setSession] = useState();
  const [profile, setProfile] = useState();
  const [preferences, setPreferences] = useState();
  const [shop, setShop] = useState();
  const [access, setAccess] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function clearAccount() {
    setProfile();
    setPreferences();
    setShop();
    setAccess();
    applyPreferences(null);
  }

  async function loadAccount(client, activeSession, recordLogin = false) {
    if (!activeSession) {
      await clearAccount();
      return;
    }

    const userId = activeSession.user.id;

    let profileData;

    try {
      profileData = await loadProfileWithCustomRole(client, userId);
    } catch (profileLoadError) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const cached = loadOfflineAuthSnapshot(userId);
        if (cached?.profile) {
          setProfile({ ...cached.profile, offline_mode: true });
          setPreferences(cached.preferences);
          setShop(cached.shop);
          setAccess(cached.access || fallbackAccessForRole(cached.profile.role));
          applyPreferences(cached.preferences);
          return;
        }
      }
      throw profileLoadError;
    }

    if (!profileData.is_active) {
      await client.auth.signOut();
      throw new Error("This POS account is inactive. Contact the owner.");
    }

    const [
      {
        data: preferenceData,
        error: preferenceError
      },
      {
        data: shopData,
        error: shopError
      },
      accessData
    ] = await Promise.all([
      client
        .from("user_preferences")
        .select("*")
        .eq("user_id", userId)
        .single(),

      client
        .from("app_settings")
        .select("*")
        .eq(
          "organization_id",
          profileData.organization_id
        )
        .single(),

      loadMyAccess(
        client,
        profileData.role
      )
    ]);

    if (preferenceError) throw preferenceError;
    if (shopError) throw shopError;

    setProfile(profileData);
    setPreferences(preferenceData);
    setShop(shopData);
    const nextAccess =
      accessData
      || fallbackAccessForRole(
        profileData.role
      );

    setAccess(nextAccess);
    applyPreferences(preferenceData);
    saveOfflineAuthSnapshot(
      activeSession,
      profileData,
      preferenceData,
      shopData,
      nextAccess
    );

    if (recordLogin) {
      try {
        await client.rpc("record_pos_login");
      } catch {
        // Login tracking must never block the POS from opening.
      }
    }
  }

  useEffect(() => {
    let subscription;
    let mounted = true;

    (async () => {
      try {
        const client = await getSupabase();
        if (!mounted) return;

        setSupabase(client);

        // Telegram Mini App sessions are isolated by Telegram user ID. When a
        // Telegram account is already linked, resolve its matching POS user
        // before loading profile/permissions so two phones or two Telegram
        // accounts never inherit the same browser POS session.
        await resolveTelegramLinkedSession(client);

        const {
          data: { session: currentSession },
          error: sessionError
        } = await client.auth.getSession();

        if (sessionError) throw sessionError;
        if (!mounted) return;

        setSession(currentSession);
        await loadAccount(client, currentSession, Boolean(currentSession));

        const authListener = client.auth.onAuthStateChange(
          async (event, nextSession) => {
            if (!mounted) return;

            setSession(nextSession);

            try {
              await loadAccount(
                client,
                nextSession,
                event === "SIGNED_IN"
              );
              setError("");
            } catch (authError) {
              setError(authError.message);
            }
          }
        );

        subscription = authListener.data.subscription;
      } catch (initializeError) {
        if (mounted) setError(initializeError.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      subscription?.unsubscribe();
    };
  }, []);

  async function refreshAccess() {
    if (!supabase || !profile?.role) {
      return null;
    }

    const nextAccess =
      await loadMyAccess(
        supabase,
        profile.role
      );

    setAccess(nextAccess);
    return nextAccess;
  }

  function can(permissionKey) {
    // The organization owner must never be locked out by a stale access RPC
    // response or an unfinished custom-role migration.
    if (String(profile?.role || "").trim().toLowerCase() === "owner") {
      return true;
    }

    return accessAllows(
      access
      || fallbackAccessForRole(
        profile?.role
      ),
      permissionKey
    );
  }

  function canAny(permissionKeys) {
    if (String(profile?.role || "").trim().toLowerCase() === "owner") {
      return true;
    }

    return accessAllowsAny(
      access
      || fallbackAccessForRole(
        profile?.role
      ),
      permissionKeys
    );
  }

  async function signIn(email, password) {
    if (!supabase) throw new Error("Supabase is still loading.");

    const { data, error: signInError } =
      await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

    if (signInError) throw signInError;

    clearTelegramExplicitLogout();
    setSession(data.session);
    await loadAccount(supabase, data.session, true);
    return data;
  }

  async function signOut() {
    if (!supabase) return;
    markTelegramExplicitLogout();
    clearOfflineAuthSnapshot(session?.user?.id);
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw signOutError;
  }

  async function savePreferences(values) {
    if (!supabase || !session?.user?.id) {
      throw new Error("Your POS session is not ready.");
    }

    const payload = {
      language: values.language || preferences?.language || "en",
      theme: normalizeThemeMode(
        values.theme || values.theme_mode || preferences?.theme || preferences?.theme_mode || "system"
      ),
      accent_color: values.accent_color || preferences?.accent_color || "#2563eb",
      compact_mode: Boolean(values.compact_mode),
      sound_enabled: values.sound_enabled ?? values.scanner_sound ?? preferences?.sound_enabled ?? true,
      scanner_vibration: values.scanner_vibration ?? preferences?.scanner_vibration ?? true,
      new_sale_layout: values.new_sale_layout === "layout2" ? "layout2" : "layout1",
      sale_product_card_scale: 1,
      sale_show_product_code: values.sale_show_product_code !== false,
      sale_stock_display: values.sale_stock_display === "status" ? "status" : "exact"
    };

    const { data, error: updateError } = await supabase
      .from("user_preferences")
      .update(payload)
      .eq("user_id", session.user.id)
      .select()
      .single();

    if (updateError) throw updateError;

    setPreferences(data);
    applyPreferences(data);
    saveOfflineAuthSnapshot(
      session,
      profile,
      data,
      shop,
      access || fallbackAccessForRole(profile?.role)
    );
    return data;
  }

  async function savePreferencePatch(values = {}) {
    if (!supabase || !session?.user?.id) {
      throw new Error("Your POS session is not ready.");
    }

    const payload = {};

    if (Object.prototype.hasOwnProperty.call(values, "language")) {
      payload.language = values.language === "km" ? "km" : "en";
    }

    if (
      Object.prototype.hasOwnProperty.call(values, "theme")
      || Object.prototype.hasOwnProperty.call(values, "theme_mode")
    ) {
      payload.theme = normalizeThemeMode(values.theme || values.theme_mode);
    }

    if (Object.keys(payload).length === 0) return preferences;

    const { data, error: updateError } = await supabase
      .from("user_preferences")
      .update(payload)
      .eq("user_id", session.user.id)
      .select()
      .single();

    if (updateError) throw updateError;

    setPreferences(data);
    applyPreferences(data);
    saveOfflineAuthSnapshot(
      session,
      profile,
      data,
      shop,
      access || fallbackAccessForRole(profile?.role)
    );

    return data;
  }

  async function saveShopSettings(values) {
    if (!supabase || !profile?.organization_id) {
      throw new Error("Shop settings are not ready.");
    }

    const merged = {
      ...shopFormFromSettings(shop),
      ...values
    };

    const data = await persistShopSettings(supabase, merged);
    setShop(data);
    saveOfflineAuthSnapshot(
      session,
      profile,
      preferences,
      data,
      access || fallbackAccessForRole(profile?.role)
    );
    return data;
  }


  const value = useMemo(
    () => ({
      supabase,
      session,
      profile,
      preferences,
      shop,
      access,
      approvalLimits:
        access?.limits || {},
      loading,
      error,
      can,
      canAny,
      refreshAccess,
      signIn,
      signOut,
      savePreferences,
      savePreferencePatch,
      saveShopSettings
    }),
    [
      supabase,
      session,
      profile,
      preferences,
      shop,
      access,
      loading,
      error
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
