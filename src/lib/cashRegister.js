function startOfDate(value) {
  return new Date(`${value}T00:00:00`).toISOString();
}

function endOfDate(value) {
  return new Date(`${value}T23:59:59.999`).toISOString();
}

export function defaultRegisterDates() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return {
    from: today,
    to: today
  };
}

export async function getOpenCashRegisterSummary(supabase) {
  const { data, error } = await supabase.rpc(
    "get_open_cash_register_summary"
  );

  if (error) throw error;
  return data || { session: null, totals: null };
}

export async function getCashRegisterSessionSummary(
  supabase,
  sessionId
) {
  const { data, error } = await supabase.rpc(
    "get_cash_register_session_summary",
    {
      p_session_id: sessionId
    }
  );

  if (error) throw error;
  return data;
}

export async function openCashRegister(supabase, values) {
  const { data, error } = await supabase.rpc(
    "open_cash_register_v2",
    {
      p_opening_cash_usd: Number(values.opening_cash_usd || 0),
      p_opening_cash_khr: Number(values.opening_cash_khr || 0),
      p_register_name: values.register_name.trim(),
      p_opening_note: values.opening_note.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function closeCashRegister(supabase, values) {
  const { data, error } = await supabase.rpc(
    "close_cash_register_v2",
    {
      p_counted_cash_usd: Number(values.counted_cash_usd || 0),
      p_counted_cash_khr: Number(values.counted_cash_khr || 0),
      p_closing_note: values.closing_note.trim() || null,
      p_session_id: values.session_id || null
    }
  );

  if (error) throw error;
  return data;
}

export async function loadCashRegisterWorkspace(
  supabase,
  profile,
  filters
) {
  const [summaryResult, sessionsResult] = await Promise.all([
    supabase.rpc("get_open_cash_register_summary"),
    supabase
      .from("cash_register_sessions")
      .select("*")
      .eq("organization_id", profile.organization_id)
      .eq("branch_id", profile.branch_id)
      .gte("opened_at", startOfDate(filters.from))
      .lte("opened_at", endOfDate(filters.to))
      .order("opened_at", { ascending: false })
      .limit(150)
  ]);

  if (summaryResult.error) throw summaryResult.error;
  if (sessionsResult.error) throw sessionsResult.error;

  const sessions = sessionsResult.data || [];
  const userIds = [
    ...new Set(
      sessions
        .flatMap((session) => [
          session.opened_by,
          session.closed_by
        ])
        .filter(Boolean)
    )
  ];

  let staff = [];

  if (userIds.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,full_name,email,role")
      .in("id", userIds);

    if (error) throw error;
    staff = data || [];
  }

  const staffById = new Map(
    staff.map((member) => [member.id, member])
  );

  return {
    openSummary:
      summaryResult.data?.session
        ? summaryResult.data
        : null,
    sessions: sessions.map((session) => ({
      ...session,
      opened_by_profile:
        staffById.get(session.opened_by) || null,
      closed_by_profile:
        staffById.get(session.closed_by) || null
    }))
  };
}
