import { runScheduledBackups } from "./backup-admin.mjs";

export default async () => {
  try {
    const result = await runScheduledBackups();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  } catch (error) {
    console.error("Scheduled backup failed:", error);
    return new Response(JSON.stringify({ ok: false, error: error.message || "Scheduled backup failed." }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
};
