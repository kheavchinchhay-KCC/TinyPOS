import { APP_RELEASE } from "./release";

let reportingContext = {
  supabase: null,
  profile: null
};

let installed = false;
let sending = false;
const recent = new Map();

function errorValue(value) {
  if (value instanceof Error) return value;
  if (value?.reason instanceof Error) return value.reason;
  return new Error(
    typeof value === "string"
      ? value
      : JSON.stringify(value || "Unknown error")
  );
}

function safeContext(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch {
    return { serialization_error: true };
  }
}

export function setErrorReportingContext(value = {}) {
  reportingContext = {
    ...reportingContext,
    ...value
  };
}

export async function reportClientError(
  value,
  context = {},
  severity = "error"
) {
  const error = errorValue(value);
  const { supabase, profile } = reportingContext;

  if (!supabase || !profile?.organization_id || sending) {
    return null;
  }

  const route = `${window.location.pathname}${window.location.search}`;
  const fingerprint = [
    error.name,
    error.message,
    String(error.stack || "").slice(0, 1000),
    route
  ].join("|");

  const last = recent.get(fingerprint) || 0;
  if (Date.now() - last < 60000) return null;
  recent.set(fingerprint, Date.now());

  try {
    sending = true;
    const { data, error: logError } = await supabase.rpc(
      "log_client_error",
      {
        p_message: String(error.message || error).slice(0, 4000),
        p_stack: String(error.stack || "").slice(0, 12000) || null,
        p_route: route,
        p_release: APP_RELEASE,
        p_user_agent: navigator.userAgent,
        p_context: safeContext({
          ...context,
          online: navigator.onLine,
          visibility: document.visibilityState,
          language: document.documentElement.lang || null
        }),
        p_severity: severity,
        p_source: "frontend"
      }
    );

    if (logError) return null;
    return data;
  } catch {
    return null;
  } finally {
    sending = false;
  }
}

export function installGlobalErrorHandlers() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    reportClientError(
      event.error || event.message,
      {
        event: "window.error",
        filename: event.filename || null,
        line: event.lineno || null,
        column: event.colno || null
      }
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportClientError(
      event.reason,
      { event: "unhandledrejection" }
    );
  });
}
