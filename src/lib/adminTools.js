import { downloadBackupArchive, readBusinessBackupArchive } from "./backupArchive";

function authHeaders(session) {
  if (!session?.access_token) {
    throw new Error("Your login session is missing.");
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`
  };
}

async function backupRequest(session, body) {
  const response = await fetch("/api/backup-admin", {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify(body)
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { ok: false, error: await response.text() };

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || "Backup request failed.");
  }

  return { response, data };
}

export function defaultAuditDates() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return {
    from: today,
    to: today
  };
}

function startOfDate(value) {
  return new Date(`${value}T00:00:00`).toISOString();
}

function endOfDate(value) {
  return new Date(`${value}T23:59:59.999`).toISOString();
}

export async function loadAdminToolsWorkspace(
  supabase,
  profile,
  filters
) {
  let auditQuery = supabase
    .from("audit_logs")
    .select(`
      id,
      organization_id,
      branch_id,
      user_id,
      action,
      entity_type,
      entity_id,
      old_data,
      new_data,
      ip_address,
      user_agent,
      created_at,
      branches (
        id,
        name,
        code
      )
    `)
    .eq("organization_id", profile.organization_id)
    .gte("created_at", startOfDate(filters.from))
    .lte("created_at", endOfDate(filters.to))
    .order("created_at", { ascending: false })
    .limit(500);

  if (filters.branch_id) {
    auditQuery = auditQuery.eq("branch_id", filters.branch_id);
  }

  if (filters.user_id) {
    auditQuery = auditQuery.eq("user_id", filters.user_id);
  }

  if (filters.action) {
    auditQuery = auditQuery.eq("action", filters.action);
  }

  if (filters.entity_type) {
    auditQuery = auditQuery.eq(
      "entity_type",
      filters.entity_type
    );
  }

  const [auditResult, branchesResult, profilesResult, logsResult] =
    await Promise.all([
      auditQuery,
      supabase
        .from("branches")
        .select("id,name,code,is_active")
        .eq("organization_id", profile.organization_id)
        .order("name"),
      supabase
        .from("profiles")
        .select("id,full_name,email,role,is_active")
        .eq("organization_id", profile.organization_id)
        .order("full_name"),
      supabase
        .from("data_backup_logs")
        .select(`
          id,
          branch_id,
          requested_by,
          action,
          status,
          filename,
          backup_version,
          source_organization_name,
          row_counts,
          details,
          created_at
        `)
        .eq("organization_id", profile.organization_id)
        .order("created_at", { ascending: false })
        .limit(50)
    ]);

  for (const result of [
    auditResult,
    branchesResult,
    profilesResult,
    logsResult
  ]) {
    if (result.error) throw result.error;
  }

  const profiles = profilesResult.data || [];
  const profileById = new Map(
    profiles.map((member) => [member.id, member])
  );

  return {
    auditLogs: (auditResult.data || []).map((entry) => ({
      ...entry,
      profiles: entry.user_id
        ? profileById.get(entry.user_id) || null
        : null
    })),
    branches: branchesResult.data || [],
    profiles,
    backupLogs: (logsResult.data || []).map((entry) => ({
      ...entry,
      profiles: entry.requested_by
        ? profileById.get(entry.requested_by) || null
        : null
    }))
  };
}

export async function downloadBusinessBackup(session) {
  const { response, data } = await backupRequest(session, {
    action: "export"
  });

  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/i);
  const serverFilename = match?.[1] || `tiny-pos-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const filename = serverFilename.replace(/\.json$/i, ".zip");
  const { size } = downloadBackupArchive(data, filename);

  return {
    filename,
    size,
    backup: data
  };
}

export async function createStoredBackup(session) {
  const { data } = await backupRequest(session, { action: "storage_backup" });
  return data;
}

export async function downloadStoredBackup(session, fileId) {
  const response = await fetch("/api/backup-admin", {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ action: "storage_download", file_id: fileId })
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text)?.error || text; } catch { /* response body was not JSON — use the raw text as-is */ }
    throw new Error(message || "Backup download failed.");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/i);
  const filename = match?.[1] || `tiny-pos-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { filename, size: blob.size };
}

export async function loadBackupCenterSettings(session) {
  const { data } = await backupRequest(session, {
    action: "settings_get"
  });
  return data;
}

export async function saveBackupCenterSettings(session, settings) {
  const { data } = await backupRequest(session, {
    action: "settings_save",
    settings
  });
  return data;
}

export async function validateBusinessBackup(
  session,
  backup
) {
  const { data } = await backupRequest(session, {
    action: "validate",
    backup
  });

  return data.validation;
}

export async function restoreBusinessBackup(
  session,
  backup,
  confirmation,
  currentBackupDownloaded
) {
  const { data } = await backupRequest(session, {
    action: "restore",
    backup,
    confirmation,
    current_backup_downloaded: currentBackupDownloaded
  });

  return data;
}

export async function readBackupFile(file) {
  return readBusinessBackupArchive(file);
}
