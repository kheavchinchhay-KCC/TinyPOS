const DRAFT_VERSION = 1;
const INSTALL_DISMISS_KEY = "tiny-pos-install-dismissed";

let initialized = false;
let registration = null;
let deferredInstallPrompt = null;
let reloadForUpdate = false;

const listeners = new Set();

const state = {
  online:
    typeof navigator === "undefined"
      ? true
      : navigator.onLine,
  installed: false,
  installAvailable: false,
  installDismissed: false,
  updateAvailable: false,
  serviceWorkerReady: false
};

function detectInstalled() {
  if (typeof window === "undefined") return false;

  return (
    window.matchMedia?.("(display-mode: standalone)")
      ?.matches ||
    window.navigator.standalone === true
  );
}

function readInstallDismissed() {
  if (typeof sessionStorage === "undefined") {
    return false;
  }

  try {
    return sessionStorage.getItem(INSTALL_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function emitState(patch = {}) {
  Object.assign(state, patch);

  const snapshot = { ...state };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function watchRegistration(nextRegistration) {
  registration = nextRegistration;

  emitState({
    serviceWorkerReady: true,
    updateAvailable: Boolean(
      registration.waiting &&
      navigator.serviceWorker.controller
    )
  });

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;

    worker.addEventListener("statechange", () => {
      if (
        worker.state === "installed" &&
        navigator.serviceWorker.controller
      ) {
        emitState({ updateAvailable: true });
      }
    });
  });
}

async function registerServiceWorker() {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }

  const hostname = window.location.hostname;
  const localDevelopment =
    hostname === "localhost" ||
    hostname === "127.0.0.1";

  if (localDevelopment) return;

  try {
    const nextRegistration =
      await navigator.serviceWorker.register(
        "/service-worker.js",
        { scope: "/" }
      );

    watchRegistration(nextRegistration);

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        if (reloadForUpdate) {
          window.location.reload();
        }
      }
    );
  } catch (error) {
    console.warn(
      "Tiny POS service worker registration failed:",
      error
    );
  }
}

export function initializePwa() {
  if (initialized || typeof window === "undefined") {
    return;
  }

  initialized = true;

  state.installed = detectInstalled();
  state.installDismissed = readInstallDismissed();

  window.addEventListener("online", () => {
    emitState({ online: true });
  });

  window.addEventListener("offline", () => {
    emitState({ online: false });
  });

  window.addEventListener(
    "beforeinstallprompt",
    (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;

      emitState({
        installAvailable:
          !state.installed &&
          !state.installDismissed
      });
    }
  );

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;

    emitState({
      installed: true,
      installAvailable: false,
      installDismissed: false
    });
  });

  registerServiceWorker();
}

export function getPwaState() {
  return { ...state };
}

export function subscribePwaState(listener) {
  listeners.add(listener);
  listener(getPwaState());

  return () => listeners.delete(listener);
}

export async function promptPwaInstall() {
  if (!deferredInstallPrompt) {
    return { outcome: "unavailable" };
  }

  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;

  emitState({
    installAvailable: false,
    installDismissed:
      choice.outcome !== "accepted"
  });

  return choice;
}

export function dismissPwaInstall() {
  try {
    sessionStorage.setItem(
      INSTALL_DISMISS_KEY,
      "1"
    );
  } catch {
    // The prompt is still hidden for the current page state.
  }

  emitState({
    installAvailable: false,
    installDismissed: true
  });
}

export function applyPwaUpdate() {
  if (!registration?.waiting) {
    window.location.reload();
    return;
  }

  reloadForUpdate = true;
  registration.waiting.postMessage({
    type: "SKIP_WAITING"
  });
}

function saleDraftKey(profile) {
  if (
    !profile?.organization_id ||
    !profile?.branch_id ||
    !profile?.id
  ) {
    return null;
  }

  return [
    "tiny-pos-sale-draft",
    profile.organization_id,
    profile.branch_id,
    profile.id
  ].join(":");
}

export function saveLocalSaleDraft(
  profile,
  draft
) {
  const key = saleDraftKey(profile);
  if (!key || typeof localStorage === "undefined") {
    return false;
  }

  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: DRAFT_VERSION,
        saved_at: new Date().toISOString(),
        ...draft
      })
    );
    return true;
  } catch (error) {
    console.warn(
      "Unable to save the local Tiny POS sale draft:",
      error
    );
    return false;
  }
}

export function loadLocalSaleDraft(profile) {
  const key = saleDraftKey(profile);
  if (!key || typeof localStorage === "undefined") {
    return null;
  }

  try {
    const value = localStorage.getItem(key);
    if (!value) return null;

    const parsed = JSON.parse(value);
    if (parsed?.version !== DRAFT_VERSION) {
      localStorage.removeItem(key);
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn(
      "Unable to restore the local Tiny POS sale draft:",
      error
    );
    return null;
  }
}

export function clearLocalSaleDraft(profile) {
  const key = saleDraftKey(profile);
  if (!key || typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing else is required.
  }
}

export function detachQuoteFromLocalSaleDraft(profile, quoteId) {
  const key = saleDraftKey(profile);
  if (
    !key
    || !quoteId
    || typeof localStorage === "undefined"
  ) {
    return false;
  }

  try {
    const value = localStorage.getItem(key);
    if (!value) return false;

    const parsed = JSON.parse(value);
    if (
      parsed?.version !== DRAFT_VERSION
      || String(parsed?.active_quote_id || "") !== String(quoteId)
    ) {
      return false;
    }

    const next = {
      ...parsed,
      saved_at: new Date().toISOString(),
      active_quote_id: null,
      active_quote_number: null,
      active_quote_status: null,
      active_quote_valid_until: null,
      active_quote_terms: null
    };

    localStorage.setItem(key, JSON.stringify(next));

    try {
      window.dispatchEvent(
        new CustomEvent("tiny-pos-quote-detached", {
          detail: { quoteId: String(quoteId) }
        })
      );
    } catch {
      // The saved draft is already repaired even if events are unavailable.
    }

    return true;
  } catch (error) {
    console.warn(
      "Unable to detach quotation from the local Tiny POS sale draft:",
      error
    );
    return false;
  }
}
