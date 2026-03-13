/**
 * src/api/missions.js — API REST pour les missions LaRuche
 * Endpoints : POST /api/mission, GET /api/missions, GET /api/missions/:id
 *             GET /api/status, GET /api/agents, POST /api/search
 *
 * Compatible avec le mode Standalone ET le mode Telegram.
 * Les routes sont enregistrées sur une app Hono existante.
 */

import { randomUUID } from "crypto";
import { missionQueue } from "../missionQueue.js";
import { canTransition } from "../types/mission.js";

// ─── Store in-memory des missions en cours ─────────────────────────────────────
// missionId → { id, command, status, result, events, startedAt, timeoutAt }
export const activeMissions = new Map();

// Durée de rétention des missions terminées dans le store in-memory (5 min)
const RETENTION_MS = 5 * 60 * 1000;

// Timeout global par mission — env MISSION_TIMEOUT_MS, défaut 5 min
const MISSION_TIMEOUT_MS = parseInt(process.env.MISSION_TIMEOUT_MS || '300000');

// ─── Rate limiting simple ──────────────────────────────────────────────────────
// Limite : 30 requêtes/minute par IP (protection spam missions)
const _rateLimitMap = new Map(); // ip → { count, resetAt }
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = _rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) return false;
  // Nettoyage des entrées expirées (toutes les 100 calls)
  if (_rateLimitMap.size > 1000) {
    for (const [k, v] of _rateLimitMap) { if (now > v.resetAt) _rateLimitMap.delete(k); }
  }
  return true;
}

// ─── Nettoyage périodique des missions en mémoire (>10 min) + timeout ──────────
// Vérifie toutes les 60 s :
//   1. Passe en 'timeout' les missions running/pending dont timeoutAt est dépassé
//   2. Supprime les missions terminées de plus de 10 min
const CLEANUP_MS = 10 * 60 * 1000;
let _broadcastHUD = null;  // injecté par createMissionsRoutes pour éviter import circulaire

setInterval(() => {
  const now    = Date.now();
  const cutoff = now - CLEANUP_MS;

  for (const [id, m] of activeMissions) {
    // 1. Timeout : mission active dont timeoutAt est dépassé
    if (
      (m.status === 'pending' || m.status === 'running') &&
      m.timeoutAt && new Date(m.timeoutAt).getTime() < now
    ) {
      if (canTransition(m.status, 'timeout')) {
        Object.assign(m, {
          status: 'timeout',
          completedAt: new Date().toISOString(),
          error: `Mission timeout après ${MISSION_TIMEOUT_MS}ms`,
        });
        _broadcastHUD?.({ type: 'mission_timeout', missionId: id });
        // Nettoyage différé après rétention
        setTimeout(() => activeMissions.delete(id), RETENTION_MS);
      }
      continue;
    }

    // 2. Nettoyage des missions terminées trop anciennes
    if (m.startedAt && new Date(m.startedAt).getTime() < cutoff) {
      activeMissions.delete(id);
    }
  }
}, 60_000).unref();

/**
 * Crée une entrée de mission in-memory
 * Inclut timeoutAt pour le cleanup périodique (Wave 1 — timeout global missions)
 */
export function createMissionEntry(command) {
  const id = `m-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const entry = {
    id,
    command,
    status: "pending",
    result: null,
    error: null,
    events: [],
    models: [],
    duration: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    timeoutAt: new Date(Date.now() + MISSION_TIMEOUT_MS).toISOString(),
  };
  activeMissions.set(id, entry);
  return entry;
}

/**
 * Met à jour le statut d'une mission in-memory.
 * Valide la transition de statut via canTransition() si le statut change.
 */
export function updateMission(id, patch) {
  const entry = activeMissions.get(id);
  if (!entry) return;

  // Validation de la transition si le statut change
  if (patch.status && patch.status !== entry.status) {
    if (!canTransition(entry.status, patch.status)) {
      // Transition invalide : log silencieux + ignore le changement de statut
      // (on applique quand même les autres champs du patch)
      const { status: _ignored, ...rest } = patch;
      Object.assign(entry, rest);
      return;
    }
  }

  Object.assign(entry, patch);

  // Nettoyage différé après rétention pour tous les statuts terminaux
  const TERMINAL = ['success', 'error', 'partial', 'failed', 'timeout', 'cancelled'];
  if (patch.status && TERMINAL.includes(patch.status)) {
    setTimeout(() => activeMissions.delete(id), RETENTION_MS);
  }
}

/**
 * Ajoute un événement à la timeline d'une mission
 */
export function appendMissionEvent(id, event) {
  const entry = activeMissions.get(id);
  if (!entry) return;
  entry.events.push({ ...event, ts: new Date().toISOString() });
}

// ─── Enregistrement des routes sur une app Hono ────────────────────────────────

/**
 * @param {import('hono').Hono} app
 * @param {{
 *   loadMissions: () => Object[],
 *   saveMission: (entry: Object) => void,
 *   runMission: (command: string, missionId: string) => Promise<string>,
 *   autoDetectRoles: () => Promise<Object>,
 *   broadcastHUD: (event: Object) => void,
 *   logger: import('winston').Logger,
 * }} deps
 */
export function createMissionsRoutes(app, deps) {
  const { loadMissions, runMission, autoDetectRoles, broadcastHUD, logger, healthMonitor, missionCache, eventBus } = deps;

  // Injecte broadcastHUD dans le scope module pour le cleanup timeout
  _broadcastHUD = broadcastHUD;

  // ─── POST /api/mission ──────────────────────────────────────────────────────
  app.post("/api/mission", async (c) => {
    // Rate limiting
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "local";
    if (!checkRateLimit(ip)) {
      return c.json({ error: "Rate limit dépassé (30 req/min)" }, 429);
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body JSON invalide" }, 400);
    }

    const command = body?.command?.trim();
    if (!command) {
      return c.json({ error: "Champ 'command' requis" }, 400);
    }
    if (command.length > 2000) {
      return c.json({ error: "Commande trop longue (max 2000 caractères)" }, 400);
    }

    // Vérifie si la queue est saturée avant de créer l'entrée
    if (missionQueue.pending >= 100) {
      return c.json({
        error: "Queue saturée : trop de missions en attente (max 100). Réessayez plus tard.",
        queue: missionQueue.stats,
      }, 503);
    }

    const entry = createMissionEntry(command);
    logger.info(`[API] Nouvelle mission ${entry.id}: ${command.substring(0, 60)}`);
    broadcastHUD({ type: "mission_start", command: command.substring(0, 100), missionId: entry.id });

    // Passage par la queue FIFO — la mission s'exécutera dès qu'un slot sera disponible
    missionQueue.enqueue(() => runMission(command, entry.id)).catch((err) => {
      logger.error(`[API] Mission ${entry.id} erreur: ${err.message}`);
    });

    return c.json({ missionId: entry.id, status: "pending", queue: missionQueue.stats }, 202);
  });

  // ─── GET /api/missions ──────────────────────────────────────────────────────
  app.get("/api/missions", (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    const offset = (page - 1) * limit;

    const all = loadMissions();
    const total = all.length;
    const missions = all.slice(offset, offset + limit);

    return c.json({ missions, total, page, limit });
  });

  // ─── GET /api/missions/:id ──────────────────────────────────────────────────
  app.get("/api/missions/:id", (c) => {
    const id = c.req.param("id");

    // D'abord chercher dans le store in-memory (missions en cours)
    const active = activeMissions.get(id);
    if (active) return c.json(active);

    // Sinon chercher dans l'historique persisté
    const missions = loadMissions();
    const mission = missions.find((m) => m.id === id);
    if (!mission) return c.json({ error: "Mission introuvable" }, 404);

    return c.json(mission);
  });

  // ─── GET /api/status ────────────────────────────────────────────────────────
  app.get("/api/status", async (c) => {
    let ollamaOk = false;
    let ollamaLatencyMs = null;
    const ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";

    try {
      const t = Date.now();
      const r = await fetch(`${ollamaHost}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      ollamaOk = r.ok;
      ollamaLatencyMs = Date.now() - t;
    } catch {}

    const missions = loadMissions();
    const successCount = missions.filter((m) => m.status === "success").length;
    const activeMissionCount = activeMissions.size;

    let roles = {};
    try {
      roles = await autoDetectRoles();
    } catch {}

    const { worldModelStats } = await import('../worldmodel/index.js').catch(() => ({ worldModelStats: () => ({}) }));
    const { episodeStats } = await import('../memory/episodic/index.js').catch(() => ({ episodeStats: () => ({}) }));
    const { nodeRegistry } = await import('../swarm/index.js').catch(() => ({ nodeRegistry: { stats: () => ({}) } }));

    return c.json({
      status: "online",
      mode: "standalone",
      version: process.env.npm_package_version || "4.1.0",
      uptime: Math.floor(process.uptime()),
      ollama: {
        ok: ollamaOk,
        latencyMs: ollamaLatencyMs,
        host: ollamaHost,
      },
      missions: {
        total: missions.length,
        success: successCount,
        active: activeMissionCount,
      },
      queue: missionQueue.stats,
      models: roles,
      cognitiveMetrics: {
        worldModel: worldModelStats(),
        episodicMemory: episodeStats(),
        swarm: nodeRegistry.stats(),
      },
      layers_health: healthMonitor?.getStatus() ?? null,
      cache_metrics: missionCache?.getMetrics() ?? null,
      event_bus: eventBus?.getMetrics() ?? null,
      timestamp: new Date().toISOString(),
    });
  });

  // ─── GET /api/agents ────────────────────────────────────────────────────────
  app.get("/api/agents", async (c) => {
    let roles = {};
    try {
      roles = await autoDetectRoles();
    } catch {}

    const AGENT_META = {
      strategist:  { name: "Stratège",      icon: "🧠", color: "#6366f1" },
      architect:   { name: "Architecte",    icon: "⚡", color: "#3b82f6" },
      worker:      { name: "Ouvrière",      icon: "🔧", color: "#f59e0b" },
      vision:      { name: "Vision",        icon: "👁",  color: "#10b981" },
      visionFast:  { name: "Vision Rapide", icon: "📷", color: "#06b6d4" },
      synthesizer: { name: "Synthèse",      icon: "✨", color: "#8b5cf6" },
    };
    const recent = loadMissions().slice(0, 1);
    const lastTask = recent[0]?.command?.substring(0, 50) || "En attente...";
    const isRunning = activeMissions.size > 0;
    const agents = Object.entries(AGENT_META).map(([id, meta]) => ({
      id,
      ...meta,
      model: roles[id] || null,
      status: roles[id] ? (isRunning ? "running" : "idle") : "unavailable",
      tokensPerSec: 0,
      lastTask,
    }));
    return c.json({ agents });
  });

  // ─── POST /api/search ────────────────────────────────────────────────────────
  app.post("/api/search", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body JSON invalide" }, 400);
    }

    const query = body?.query?.trim();
    if (!query) return c.json({ error: "Champ 'query' requis" }, 400);

    // Recherche simple par correspondance textuelle dans l'historique
    const missions = loadMissions();
    const results = missions
      .filter((m) => m.command?.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10)
      .map((m) => ({
        id: m.id,
        command: m.command,
        status: m.status,
        score: 1.0, // Simple match — ChromaDB optionnel
        ts: m.ts || m.startedAt,
      }));

    return c.json({ query, results, count: results.length });
  });

  // ─── GET /api/queue ──────────────────────────────────────────────────────────
  // Retourne les statistiques en temps réel de la queue de missions
  app.get("/api/queue", (c) => {
    return c.json(missionQueue.stats);
  });

  // ─── GET /api/health ─────────────────────────────────────────────────────────
  app.get("/api/health", (c) => {
    return c.json({ ok: true, ts: Date.now() });
  });

  // ─── GET /api/system ─────────────────────────────────────────────────────────
  app.get("/api/system", async (c) => {
    try {
      const si = await import("systeminformation");
      const [cpu, mem, disk, proc] = await Promise.all([
        si.default.currentLoad(),
        si.default.mem(),
        si.default.fsSize(),
        si.default.processes(),
      ]);
      const ollamaProc = proc.list?.filter(p => p.name?.toLowerCase().includes("ollama")) || [];
      return c.json({
        cpu: { load: Math.round(cpu.currentLoad) },
        memory: {
          total: mem.total,
          used: mem.used,
          free: mem.free,
          percent: Math.round((mem.used / mem.total) * 100),
        },
        disk: disk.slice(0, 2).map(d => ({
          fs: d.fs, size: d.size, used: d.used,
          percent: Math.round(d.use),
        })),
        ollama: { running: ollamaProc.length > 0 },
      });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ─── GET /api/logs ───────────────────────────────────────────────────────────
  app.get("/api/logs", async (c) => {
    const lines = parseInt(c.req.query("lines") || "100", 10);
    try {
      const { readFileSync, existsSync } = await import("fs");
      const logFile = "/tmp/queen.log";
      let raw = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
      const allLines = raw.split("\n").filter(Boolean);
      const recent = allLines.slice(-lines);
      return c.json({ lines: recent, total: allLines.length });
    } catch {
      return c.json({ lines: [], total: 0 });
    }
  });

  // ─── GET /api/skills ─────────────────────────────────────────────────────────
  app.get("/api/skills", async (c) => {
    try {
      const { readFileSync, existsSync, readdirSync, statSync } = await import("fs");
      const { join } = await import("path");
      const SKILLS_DIR = join(process.cwd(), "skills");
      if (!existsSync(SKILLS_DIR)) return c.json({ skills: [] });
      const dirs = readdirSync(SKILLS_DIR).filter(d => {
        try { return statSync(join(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
      });
      const skills = dirs.map(d => {
        try {
          const m = JSON.parse(readFileSync(join(SKILLS_DIR, d, "manifest.json"), "utf-8"));
          const hasSkill = existsSync(join(SKILLS_DIR, d, "skill.js"));
          return { ...m, name: d, hasSkill };
        } catch { return { name: d, description: "No manifest" }; }
      });
      return c.json({ skills });
    } catch (e) { return c.json({ skills: [], error: e.message }); }
  });

  // ─── POST /api/skills/:name/run ──────────────────────────────────────────────
  app.post("/api/skills/:name/run", async (c) => {
    const name = c.req.param("name");
    let params = {};
    try { params = await c.req.json(); } catch {}
    try {
      const { runSkill } = await import("../skill_runner.js");
      const result = await runSkill(name, params);
      return c.json({ success: true, result });
    } catch (e) { return c.json({ success: false, error: e.message }, 400); }
  });

  // ─── DELETE /api/skills/:name ─────────────────────────────────────────────────
  app.delete("/api/skills/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const { rmSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const dir = join(process.cwd(), "skills", name);
      if (!existsSync(dir)) return c.json({ error: "Skill introuvable" }, 404);
      rmSync(dir, { recursive: true, force: true });
      return c.json({ success: true });
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
  });

  // ─── GET /api/config ─────────────────────────────────────────────────────────
  app.get("/api/config", async (c) => {
    try {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      // .env (masquer les tokens)
      const envPath = join(process.cwd(), ".env");
      let envVars = {};
      if (existsSync(envPath)) {
        readFileSync(envPath, "utf-8").split("\n").forEach(line => {
          const [k, ...v] = line.split("=");
          if (k?.trim() && !k.startsWith("#")) {
            const val = v.join("=").trim();
            const isSensitive = /token|key|secret|password/i.test(k);
            envVars[k.trim()] = isSensitive && val ? "***" : val;
          }
        });
      }
      // .laruche/config.json
      const cfgPath = join(process.cwd(), ".laruche/config.json");
      const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf-8")) : {};
      return c.json({ env: envVars, config: cfg });
    } catch (e) { return c.json({ error: e.message }, 500); }
  });

  // ─── POST /api/mission/:id/cancel ────────────────────────────────────────────
  app.post("/api/mission/:id/cancel", (c) => {
    const id = c.req.param("id");
    const m = activeMissions.get(id);
    if (!m) return c.json({ error: "Mission introuvable" }, 404);
    if (m.status !== "pending" && m.status !== "running") {
      return c.json({ error: "Mission déjà terminée" }, 400);
    }
    updateMission(id, { status: "cancelled", completedAt: new Date().toISOString() });
    broadcastHUD({ type: "mission_cancelled", missionId: id });
    return c.json({ success: true });
  });

  // ─── POST /api/agent ─────────────────────────────────────────────────────────
  // Lance un agent nommé directement: { agent: "architect", task: "..." }
  app.post("/api/agent", async (c) => {
    let body;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON invalide" }, 400);
    }
    const { agent = "worker", task } = body || {};
    if (!task?.trim()) return c.json({ error: "Champ 'task' requis" }, 400);

    try {
      const { runAgent } = await import("../agents/agentOrchestrator.js");
      const hudEvents = [];
      const result = await runAgent(agent, task.trim(), {
        hudFn: (ev) => {
          hudEvents.push(ev);
          broadcastHUD({ ...ev, agent });
        },
      });
      return c.json({ success: result.status !== "error", agent, task, result, events: hudEvents });
    } catch (e) {
      return c.json({ success: false, error: e.message }, 500);
    }
  });

  // ─── POST /api/orchestrate ───────────────────────────────────────────────────
  // Lance N agents en parallèle: { mission: "...", maxParallel: 4 }
  app.post("/api/orchestrate", async (c) => {
    let body;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON invalide" }, 400);
    }
    const { mission, maxParallel = 4, forceKimi = false, useAgentLoop = false } = body || {};
    if (!mission?.trim()) return c.json({ error: "Champ 'mission' requis" }, 400);

    const entry = createMissionEntry(mission.trim());
    broadcastHUD({ type: "mission_start", command: mission.slice(0, 100), missionId: entry.id });

    // Exécution asynchrone
    import("../agents/agentOrchestrator.js").then(({ orchestrate }) => {
      updateMission(entry.id, { status: "running" });
      return orchestrate(mission.trim(), {
        maxParallel,
        forceKimi,
        useAgentLoop,
        hudFn: (ev) => {
          broadcastHUD({ ...ev, missionId: entry.id });
          appendMissionEvent(entry.id, ev);
        },
      });
    }).then(result => {
      updateMission(entry.id, {
        status: result.success ? "success" : "partial",
        result: result.response,
        duration: result.duration,
        completedAt: new Date().toISOString(),
      });
      broadcastHUD({ type: "mission_complete", duration: result.duration, missionId: entry.id });
    }).catch(err => {
      logger.error(`[API] Orchestrate ${entry.id} erreur: ${err.message}`);
      updateMission(entry.id, { status: "error", error: err.message, completedAt: new Date().toISOString() });
    });

    return c.json({ missionId: entry.id, status: "pending" }, 202);
  });

  // ─── GET /api/agents/:name ────────────────────────────────────────────────────
  // Détails d'une config d'agent YAML
  app.get("/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const configPath = join(process.cwd(), `config/agents/${name}.yaml`);
      if (!existsSync(configPath)) return c.json({ error: "Agent config introuvable" }, 404);
      const raw = readFileSync(configPath, "utf-8");
      return c.json({ name, config: raw });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ─── GET /api/memory ─────────────────────────────────────────────────────────
  // Stats de la mémoire apprise + top routes
  app.get("/api/memory", async (c) => {
    try {
      const { memoryStats } = await import("../learning/missionMemory.js");
      return c.json(memoryStats());
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ─── DELETE /api/memory/forget ───────────────────────────────────────────────
  // Oublie une route apprise : { command: "..." }
  app.delete("/api/memory/forget", async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: "Body JSON invalide" }, 400); }
    if (!body?.command) return c.json({ error: "Champ 'command' requis" }, 400);
    const { forget } = await import("../learning/missionMemory.js");
    const removed = forget(body.command);
    return c.json({ success: removed, message: removed ? `Route oubliée` : `Aucune route trouvée` });
  });

  // ─── POST /api/process/restart ───────────────────────────────────────────────
  app.post("/api/process/restart", async (c) => {
    // On broadcaste l'event puis on schedule un restart dans 1s
    broadcastHUD({ type: "system_restart", message: "Redémarrage planifié dans 1s..." });
    setTimeout(() => {
      process.exit(0); // PM2 / superviseur relancera
    }, 1000);
    return c.json({ success: true, message: "Redémarrage en cours..." });
  });

  // ─── Routes Sous-agents ──────────────────────────────────────────────────────

  // GET /api/subagents — liste tous les sous-agents (config + stats)
  app.get("/api/subagents", async (c) => {
    try {
      const { subagentManager } = await import("../subagents/index.js");
      return c.json({ subagents: subagentManager.list() });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // GET /api/subagents/:id — détails d'un sous-agent
  app.get("/api/subagents/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const { subagentManager } = await import("../subagents/index.js");
      const list = subagentManager.list();
      const agent = list.find((a) => a.id === id);
      if (!agent) return c.json({ error: `Sous-agent inconnu : ${id}` }, 404);
      return c.json(agent);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /api/subagents/:id/dispatch — lance une tâche sur un sous-agent
  // body: { task: "...", context?: {}, skill?: "..." }
  // retourne: { taskId, subagentId, status: "pending" } immédiatement
  app.post("/api/subagents/:id/dispatch", async (c) => {
    const id = c.req.param("id");

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body JSON invalide" }, 400);
    }

    const task = body?.task?.trim();
    if (!task) return c.json({ error: "Champ 'task' requis" }, 400);
    if (task.length > 2000) return c.json({ error: "Tâche trop longue (max 2000 caractères)" }, 400);

    let subagentManagerMod;
    try {
      subagentManagerMod = await import("../subagents/index.js");
    } catch (e) {
      return c.json({ error: `Impossible de charger le sous-agent manager : ${e.message}` }, 500);
    }

    const { subagentManager } = subagentManagerMod;

    // Vérifier que l'agent existe avant de lancer en async
    const list = subagentManager.list();
    if (!list.find((a) => a.id === id)) {
      return c.json({ error: `Sous-agent inconnu : ${id}` }, 404);
    }

    const { randomUUID } = await import("crypto");
    const taskId = `sa-${Date.now()}-${randomUUID().slice(0, 6)}`;

    // Dispatch asynchrone — on retourne immédiatement le taskId
    subagentManager.dispatch(id, task, {
      context: body?.context || undefined,
      skill: body?.skill || undefined,
      taskId,
    }).catch((err) => {
      logger.error(`[API] Sous-agent ${id} dispatch erreur : ${err.message}`);
    });

    return c.json({ taskId, subagentId: id, status: "pending" }, 202);
  });

  // GET /api/subagents/:id/stats — stats d'un sous-agent
  app.get("/api/subagents/:id/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { subagentManager } = await import("../subagents/index.js");
      const stats = subagentManager.stats(id);
      if (!stats) return c.json({ error: `Sous-agent inconnu : ${id}` }, 404);
      return c.json(stats);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ─── PERCEPTION ──────────────────────────────────────────────────────────────
  app.get('/api/perception/stats', async (c) => {
    const { axCache } = await import('../perception/index.js');
    return c.json(axCache.stats);
  });

  // ─── WORLD MODEL ─────────────────────────────────────────────────────────────
  app.get('/api/worldmodel/stats', async (c) => {
    const { worldModelStats } = await import('../worldmodel/index.js');
    return c.json(worldModelStats());
  });
  app.get('/api/worldmodel/:appName', async (c) => {
    const { getAppModel } = await import('../worldmodel/index.js');
    const model = getAppModel(c.req.param('appName'));
    if (!model) return c.json({ error: 'App non trouvée dans le world model' }, 404);
    return c.json(model);
  });
  app.delete('/api/worldmodel/:appName', async (c) => {
    const { forgetApp } = await import('../worldmodel/index.js');
    const ok = forgetApp(c.req.param('appName'));
    return c.json({ success: ok });
  });

  // ─── SWARM ────────────────────────────────────────────────────────────────────
  app.get('/api/swarm/nodes', async (c) => {
    const { nodeRegistry } = await import('../swarm/index.js');
    return c.json({ nodes: nodeRegistry.getAll() });
  });
  app.get('/api/swarm/stats', async (c) => {
    const { nodeRegistry } = await import('../swarm/index.js');
    return c.json(nodeRegistry.stats());
  });

  // ─── EVOLUTION ───────────────────────────────────────────────────────────────
  app.get('/api/evolution/skills', async (c) => {
    const { getAllStats } = await import('../evolution/skillRegistry.js');
    return c.json({ skills: getAllStats() });
  });
  app.post('/api/evolution/trigger', async (c) => {
    let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Body invalide' }, 400); }
    if (!body?.command) return c.json({ error: 'Champ command requis' }, 400);
    const { analyzeFailedMission } = await import('../evolution/failureDetector.js');
    const { triggerSkillGeneration } = await import('../evolution/skillGenerator.js');
    const analysis = analyzeFailedMission({ command: body.command, steps: body.steps || [], status: 'failed' });
    if (!analysis) return c.json({ triggered: false, reason: 'Aucun échec détecté' });
    const result = await triggerSkillGeneration(analysis);
    return c.json({ triggered: !!result, skill: result });
  });

  // ─── EPISODIC MEMORY ─────────────────────────────────────────────────────────
  app.get('/api/memory/episodes', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const { getEpisodes } = await import('../memory/episodic/index.js');
    return c.json(getEpisodes(limit, offset));
  });
  app.post('/api/memory/episodes/search', async (c) => {
    let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Body invalide' }, 400); }
    if (!body?.query) return c.json({ error: 'Champ query requis' }, 400);
    const { retrieveSimilarEpisodes } = await import('../memory/episodic/index.js');
    return c.json({ results: retrieveSimilarEpisodes(body.query, body.limit || 5) });
  });
  app.delete('/api/memory/episodes/:id', async (c) => {
    const { deleteEpisode } = await import('../memory/episodic/index.js');
    const ok = deleteEpisode(c.req.param('id'));
    return c.json({ success: ok });
  });

  // ─── GOALS / TEMPORAL ────────────────────────────────────────────────────────
  // Note: /api/goals/schedule avant /api/goals/:id pour éviter conflit de route
  app.get('/api/goals/schedule', async (c) => {
    const { getSchedule, nextMission } = await import('../temporal/index.js');
    return c.json({ schedule: getSchedule(), next: nextMission() });
  });
  app.get('/api/goals', async (c) => {
    const { getAllGoals } = await import('../temporal/index.js');
    return c.json({ goals: getAllGoals() });
  });
  app.post('/api/goals', async (c) => {
    let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Body invalide' }, 400); }
    if (!body?.description) return c.json({ error: 'Champ description requis' }, 400);
    const { addGoal } = await import('../temporal/index.js');
    return c.json(addGoal(body), 201);
  });
  app.delete('/api/goals/:id', async (c) => {
    const { deleteGoal } = await import('../temporal/index.js');
    const ok = deleteGoal(c.req.param('id'));
    if (!ok) return c.json({ error: 'But introuvable' }, 404);
    return c.json({ success: true });
  });

  // ─── PATCH /api/goals/:id/status ─────────────────────────────────────────────
  app.patch('/api/goals/:id/status', async (c) => {
    let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Body invalide' }, 400); }
    if (!body?.status) return c.json({ error: 'Champ status requis' }, 400);
    const { updateGoalStatus, getGoal } = await import('../temporal/index.js');
    const ok = updateGoalStatus(c.req.param('id'), body.status);
    if (!ok) return c.json({ error: 'But introuvable ou transition invalide' }, 404);
    return c.json({ success: true, goal: getGoal(c.req.param('id')) });
  });

  // ─── SIMULATION ───────────────────────────────────────────────────────────────
  app.post('/api/simulate', async (c) => {
    let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Body invalide' }, 400); }
    if (!body?.skill) return c.json({ error: 'Champ skill requis' }, 400);
    const { simulate } = await import('../simulation/index.js');
    return c.json(simulate({ skill: body.skill, params: body.params || {} }));
  });

  // ─── MARKET ───────────────────────────────────────────────────────────────────
  app.get('/api/market/stats', async (c) => {
    const { marketStats } = await import('../market/agentMarket.js');
    return c.json(marketStats());
  });

  // ─── SELF-DEV ─────────────────────────────────────────────────────────────────
  app.get('/api/selfdev/analyze', async (c) => {
    const SELFDEV_TIMEOUT_MS = parseInt(process.env.SELFDEV_TIMEOUT_MS || '30000');
    try {
      const { runSelfAnalysis } = await import('../selfdev/index.js');
      const result = await Promise.race([
        runSelfAnalysis(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`selfdev timeout après ${SELFDEV_TIMEOUT_MS}ms`)), SELFDEV_TIMEOUT_MS)
        ),
      ]);
      return c.json(result);
    } catch (e) {
      if (e.message?.includes('timeout')) {
        return c.json({ error: e.message, code: 'SELFDEV_TIMEOUT' }, 504);
      }
      return c.json({ error: e.message }, 500);
    }
  });
}
