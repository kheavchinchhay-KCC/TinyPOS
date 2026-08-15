import { createClient } from "@supabase/supabase-js";

export const config = {
  schedule: "0 * * * *"
};

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase server environment variables are missing.");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export default async () => {
  try {
    const supabase = serviceClient();
    const { data, error } = await supabase.rpc("run_due_demand_forecasts");
    if (error) throw error;
    return new Response(JSON.stringify(data || { ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Demand forecast schedule failed", error);
    return new Response(JSON.stringify({
      ok: false,
      error: String(error.message || error)
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
