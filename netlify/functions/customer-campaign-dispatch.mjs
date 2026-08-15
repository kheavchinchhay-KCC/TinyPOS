import { dispatchDueCampaigns } from "./_customer-campaigns.mjs";
export const config = { schedule: "*/15 * * * *" };
export default async () => {
  try {
    const results = await dispatchDueCampaigns();
    return new Response(JSON.stringify({ ok: true, results }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Customer campaign dispatch failed", error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};
