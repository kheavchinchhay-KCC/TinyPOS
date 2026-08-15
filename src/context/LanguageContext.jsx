import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useAuth } from "./AuthContext";
import {
  createTranslator,
  normalizeLanguage
} from "../i18n/translations";

const LanguageContext = createContext(null);
const GUEST_LANGUAGE_KEY = "tiny-pos-language";
const SWITCH_OUT_MS = 90;
const SWITCH_IN_MS = 260;

function readStoredLanguage(key) {
  if (typeof window === "undefined") return "";

  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function browserLanguage() {
  if (typeof window === "undefined") return "en";

  return normalizeLanguage(
    readStoredLanguage(GUEST_LANGUAGE_KEY)
    || window.navigator.language
  );
}

function accountLanguageKey(userId) {
  return userId
    ? `${GUEST_LANGUAGE_KEY}:${userId}`
    : GUEST_LANGUAGE_KEY;
}

export function LanguageProvider({ children }) {
  const {
    supabase,
    session,
    preferences,
    shop,
    savePreferencePatch
  } = useAuth();

  const accountKey = session?.user?.id || "guest";
  const storageKey = accountLanguageKey(session?.user?.id);
  const storedLanguage = readStoredLanguage(storageKey);
  const preferred = normalizeLanguage(
    storedLanguage
    || preferences?.language
    || shop?.default_language
    || browserLanguage()
  );

  const [language, setLanguageState] = useState(preferred);
  const [pendingLanguage, setPendingLanguage] = useState("");
  const previousAccount = useRef(accountKey);
  const userSelectedLanguage = useRef(Boolean(storedLanguage));
  const commitTimer = useRef(0);
  const finishTimer = useRef(0);
  const switchToken = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    const accountChanged = previousAccount.current !== accountKey;

    if (accountChanged) {
      previousAccount.current = accountKey;
      userSelectedLanguage.current = Boolean(storedLanguage);
      setPendingLanguage("");
      setLanguageState(preferred);
      return;
    }

    // Account preferences can arrive after authentication. Accept them only
    // until this device has made an explicit EN/KH choice, so a stale profile
    // response cannot switch the current page back to the previous language.
    if (!userSelectedLanguage.current) {
      setLanguageState((current) => (
        current === preferred ? current : preferred
      ));
    }
  }, [accountKey, preferred, storedLanguage]);

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.documentElement;
    root.lang = language === "km" ? "km" : "en";
    root.dir = "ltr";
    root.dataset.language = language;

    try {
      window.localStorage.setItem(storageKey, language);
      if (!session?.user?.id) {
        window.localStorage.setItem(GUEST_LANGUAGE_KEY, language);
      }
    } catch {
      // Local persistence is helpful but must never block language switching.
    }

    window.dispatchEvent(new CustomEvent("tiny-pos-language-change", {
      detail: { language }
    }));

    if (!mounted.current) {
      mounted.current = true;
      root.classList.remove("language-switching", "language-switch-complete");
      return;
    }

    const token = switchToken.current;

    // Wait for React, portals and the DOM translation bridge to commit the
    // same current route, then fade the updated language back in.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (token !== switchToken.current) return;

        root.classList.remove("language-switching");
        root.classList.add("language-switch-complete");
        setPendingLanguage("");

        window.clearTimeout(finishTimer.current);
        finishTimer.current = window.setTimeout(() => {
          root.classList.remove("language-switch-complete");
        }, SWITCH_IN_MS);
      });
    });
  }, [language, session?.user?.id, storageKey]);

  useEffect(() => () => {
    window.clearTimeout(commitTimer.current);
    window.clearTimeout(finishTimer.current);
  }, []);

  const persistLanguage = useCallback(
    async (nextLanguage) => {
      if (!supabase || !session?.user?.id) return;

      try {
        // Use the shared preference updater so the header toggle and
        // Settings > My Preferences always read the same live value.
        if (savePreferencePatch) {
          await savePreferencePatch({ language: nextLanguage });
          return;
        }

        const { error } = await supabase
          .from("user_preferences")
          .update({ language: nextLanguage })
          .eq("user_id", session.user.id);

        if (error) throw error;
      } catch (error) {
        console.warn(
          "Tiny POS language preference could not be saved:",
          error?.message || error
        );
      }
    },
    [savePreferencePatch, session?.user?.id, supabase]
  );

  const setLanguage = useCallback(
    (nextLanguage) => {
      const normalized = normalizeLanguage(nextLanguage);
      const currentTarget = pendingLanguage || language;

      if (normalized === currentTarget) return;

      // A quick second tap may choose the already-rendered language before the
      // first transition commits. Cancel cleanly instead of leaving the UI in
      // a permanent switching state.
      if (pendingLanguage && normalized === language) {
        switchToken.current += 1;
        window.clearTimeout(commitTimer.current);
        window.clearTimeout(finishTimer.current);
        document.documentElement.classList.remove(
          "language-switching",
          "language-switch-complete"
        );
        setPendingLanguage("");
        return;
      }

      userSelectedLanguage.current = true;
      switchToken.current += 1;
      const token = switchToken.current;
      setPendingLanguage(normalized);

      try {
        window.localStorage.setItem(storageKey, normalized);
      } catch {
        // Continue with the in-memory language when storage is unavailable.
      }

      const root = document.documentElement;
      window.clearTimeout(commitTimer.current);
      window.clearTimeout(finishTimer.current);
      root.classList.remove("language-switch-complete");
      root.classList.add("language-switching");

      // Give the fade-out one short paint, then change the language without
      // navigating or reloading the current page.
      commitTimer.current = window.setTimeout(() => {
        if (token !== switchToken.current) return;
        setLanguageState(normalized);
        void persistLanguage(normalized);
      }, SWITCH_OUT_MS);
    },
    [language, pendingLanguage, persistLanguage, storageKey]
  );

  const t = useMemo(
    () => createTranslator(language),
    [language]
  );

  const value = useMemo(
    () => ({
      language,
      displayLanguage: pendingLanguage || language,
      isSwitching: Boolean(pendingLanguage),
      setLanguage,
      t,
      authenticated: Boolean(session)
    }),
    [language, pendingLanguage, setLanguage, t, session]
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const value = useContext(LanguageContext);

  if (!value) {
    throw new Error(
      "useLanguage must be used inside LanguageProvider."
    );
  }

  return value;
}
