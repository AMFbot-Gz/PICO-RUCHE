/**
 * src/modes/standalone.js — Mode sans Telegram
 * LaRuche v3.2 — Standalone API Server
 *
 * Démarre un serveur HTTP Hono sur API_PORT (défaut 3000).
 * Tous les endpoints sont disponibles via REST.
 * Les mises à jour temps réel passent par le WebSocket HUD (port 9001).
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createMissionsRoutes } from "../api/missions.js";
import { createMcpRoutes } from "../api/mcp_routes.js";
import { createMutationsRoutes } from "../api/mutations.js";
import { registerConfigRoutes } from "../api/config_routes.js";
import { startCoeusLoop } from "../agents/coeus.js";

/**
 * Lance le serveur API standalone
 *
 * @param {{
 *   loadMissions: () => Object[],
 *   saveMission: (entry: Object) => void,
 *   runMission: (command: string, missionId: string) => Promise<string>,
 *   autoDetectRoles: () => Promise<Object>,
 *   broadcastHUD: (event: Object) => void,
 *   logger: import('winston').Logger,
 * }} deps
 * @returns {{ app: Hono, server: import('http').Server }}
 */
export function startStandaloneServer(deps) {
  const { logger } = deps;
  const port = parseInt(process.env.API_PORT || "3000", 10);

  const app = new Hono();

  // ─── CORS ──────────────────────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    c.res.headers.set("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
    c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: c.res.headers });
    }
    await next();
  });

  // ─── Routes missions ────────────────────────────────────────────────────────
  // Passe aussi healthMonitor, missionCache, eventBus pour l'enrichissement de /api/status
  createMissionsRoutes(app, deps);

  // ─── Routes MCP ─────────────────────────────────────────────────────────────
  // Endpoints directs vers les modules MCP Node.js (os-control, terminal, etc.)
  createMcpRoutes(app);
  createMutationsRoutes(app);
  registerConfigRoutes(app);

  // ─── Route racine ───────────────────────────────────────────────────────────
  app.get("/", (c) =>
    c.json({
      name: "LaRuche API",
      version: process.env.npm_package_version || "5.0.0",
      mode: "standalone",
      endpoints: [
        "POST /api/mission",
        "GET  /api/missions",
        "GET  /api/missions/:id",
        "POST /api/mission/:id/cancel",
        "GET  /api/queue",
        "GET  /api/status",
        "GET  /api/health",
        "GET  /api/system",
        "GET  /api/logs",
        "GET  /api/config",
        "GET  /api/agents",
        "GET  /api/agents/:name",
        "POST /api/agent",
        "POST /api/orchestrate",
        "GET  /api/subagents",
        "GET  /api/subagents/:id",
        "POST /api/subagents/:id/dispatch",
        "GET  /api/subagents/:id/stats",
        "GET  /api/skills",
        "POST /api/skills/:name/run",
        "DELETE /api/skills/:name",
        "GET  /api/memory",
        "DELETE /api/memory/forget",
        "GET  /api/memory/episodes",
        "POST /api/memory/episodes/search",
        "DELETE /api/memory/episodes/:id",
        "GET  /api/worldmodel/stats",
        "GET  /api/worldmodel/:appName",
        "DELETE /api/worldmodel/:appName",
        "GET  /api/perception/stats",
        "GET  /api/swarm/nodes",
        "GET  /api/swarm/stats",
        "GET  /api/goals",
        "POST /api/goals",
        "GET  /api/goals/schedule",
        "DELETE /api/goals/:id",
        "POST /api/simulate",
        "GET  /api/evolution/skills",
        "POST /api/evolution/trigger",
        "GET  /api/market/stats",
        "GET  /api/selfdev/analyze",
        "POST /api/search",
        "POST /api/process/restart",
        "GET  /mcp/health",
        "POST /mcp/os-control",
        "POST /mcp/terminal",
        "POST /mcp/vision",
        "POST /mcp/vault",
        "POST /mcp/rollback",
        "POST /mcp/skill-factory",
        "POST /mcp/janitor",
        "GET  /api/mutations/suggested",
        "POST /api/mutations/suggested",
        "GET  /api/mutations/stats",
        "POST /api/mutations/audit",
      ],
    })
  );

  // ─── 404 catch-all ─────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: "Route introuvable" }, 404));

  // ─── Démarrage ──────────────────────────────────────────────────────────────
  const server = serve({ fetch: app.fetch, port }, () => {
    logger.info(`🌐 API Standalone: http://localhost:${port}`);
    logger.info(`📖 Endpoints: http://localhost:${port}/`);
  });

  startCoeusLoop();

  // ─── Voice continue (optionnel — activer avec VOICE_ENABLED=true) ─────────────
  if (process.env.VOICE_ENABLED === 'true') {
    import('../voice_continuous.js')
      .then(({ startVoiceContinuous }) => {
        startVoiceContinuous();
        console.info('[Standalone] 🎤 Voice continue activée');
      })
      .catch(err => console.warn(`[Standalone] Voice désactivée: ${err.message}`));
  }

  return { app, server };
}

/**
 * Vérifie si le mode standalone est activé
 */
export function isStandaloneMode() {
  return process.env.STANDALONE_MODE === "true" || process.env.STANDALONE_MODE === "1";
}
