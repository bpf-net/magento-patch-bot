import { loadConfig, redactConfig } from "./config";
import { type Env, loadState } from "./state";

export { CheckWorkflow } from "./workflow";

/* ---------- Endpointy administracyjne ---------- */

function authorized(req: Request, env: Env) {
  if (!env.ADMIN_TOKEN) return false;
  return req.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export default {
  async scheduled(event: ScheduledController, env: Env) {
    await env.CHECK.create({ id: `check-${new Date(event.scheduledTime).toISOString().replace(/[:.]/g, "-")}` });
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (path === "/health") return json({ ok: true });
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);

    if (path === "/status" && req.method === "GET") {
      const [state, cfg] = await Promise.all([loadState(env), loadConfig(env.STATE, env.TEAMS_WEBHOOK_URL)]);
      return json({
        state,
        config: cfg.ok ? { source: cfg.source, ...(redactConfig(cfg.config) as object) } : { source: cfg.source, errors: cfg.errors },
      });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
