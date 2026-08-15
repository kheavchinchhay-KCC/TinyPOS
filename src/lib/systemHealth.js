import {
  APP_RELEASE,
  APP_RELEASE_LABEL,
  APP_SCHEMA_STEP
} from "./release";

export async function loadSystemHealthWorkspace(
  supabase,
  profile
) {
  const [runsResult, errorsResult] = await Promise.all([
    supabase
      .from("system_health_runs")
      .select("*")
      .eq("organization_id", profile.organization_id)
      .order("generated_at", { ascending: false })
      .limit(30),

    supabase
      .from("system_error_logs")
      .select(`
        *,
        profiles:user_id (
          id,
          full_name,
          email
        ),
        branches (
          id,
          name,
          code
        )
      `)
      .eq("organization_id", profile.organization_id)
      .order("last_seen_at", { ascending: false })
      .limit(120)
  ]);

  if (runsResult.error) throw runsResult.error;
  if (errorsResult.error) throw errorsResult.error;

  return {
    runs: runsResult.data || [],
    errors: errorsResult.data || []
  };
}

export async function runDataHealthCheck(
  supabase,
  allBranches
) {
  const { data, error } = await supabase.rpc(
    "run_system_health_check",
    {
      p_all_branches: Boolean(allBranches),
      p_release: APP_RELEASE
    }
  );

  if (error) throw error;
  return data;
}

export async function loadEnvironmentHealth(session) {
  const response = await fetch("/api/system-health", {
    headers: {
      Authorization: `Bearer ${session.access_token}`
    }
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.error
      || `Environment check failed with HTTP ${response.status}.`
    );
  }

  return result;
}

export async function resolveSystemError(
  supabase,
  errorId,
  note = "Reviewed in System Health"
) {
  const { data, error } = await supabase.rpc(
    "resolve_system_error",
    {
      p_error_id: errorId,
      p_note: note
    }
  );

  if (error) throw error;
  return data;
}

export async function runSafeMaintenance(supabase) {
  const { data, error } = await supabase.rpc(
    "run_safe_system_maintenance"
  );

  if (error) throw error;
  return data;
}

export function downloadDiagnostics(document) {
  const payload = {
    release: APP_RELEASE,
    release_label: APP_RELEASE_LABEL,
    schema_step: APP_SCHEMA_STEP,
    exported_at: new Date().toISOString(),
    ...document
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    { type: "application/json;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `tiny-pos-diagnostics-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function healthDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
