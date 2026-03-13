/**
 * queen_oss.js — LaRuche Queen Open Source Edition v4.1
 * Intègre: callLLM (retry), Mission struct, logger centralisé, HUD token auth
 *
 * Modes:
 *   - Normal     : Telegram bot (TELEGRAM_BOT_TOKEN requis)
 *   - Standalone : API REST HTTP sur API_PORT (STANDALONE_MODE=true)
 */

import { Telegraf } from "telegraf";
import { WebSocketServer } from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { readdir, stat, unlink } from "fs/promises";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { ask, autoDetectRoles, printRoles } from "./model_router.js";
import { callLLM } from "./llm/callLLM.js";
import { createMission, updateMissionState, addMissionStep, addModelUsed, finalizeMission, missionSummary } from "./types/mission.js";
import { logger } from "./utils/logger.js";
import { startCronRunner } from "./cron_runner.js";
import { isStandaloneMode, startStandaloneServer } from "./modes/standalone.js";
import { updateMission, appendMissionEvent } from "./api/missions.js";
import { runIntentPipeline, isComputerUseIntent } from "./agents/intentPipeline.js";
import { learn } from "./learning/missionMemory.js";
import { missionQueue } from "./missionQueue.js";
import { subagentManager } from "./subagents/index.js";
import eventBus from '../core/events/event_bus.js';
import { DistributedHealthMonitor } from '../core/monitoring/distributed_health.js';
import MultilevelCache from '../core/cache/multilevel_cache.js';

dotenv.config();

// ─── MemoryManager interne avec TTL — évite les fuites mémoire dans les boucles ──────────────
// Utilisé pour cacher les plans de la butterfly loop (évite appels LLM redondants pour
// commandes répétées) et tout résultat intermédiaire éphémère.
const _memManager = {
  _store: new Map(),
  set(key, value, ttlMs = 300_000) {
    const expiresAt = Date.now() + ttlMs;
    this._store.set(key, { value, expiresAt });
    // Cleanup différé — libère l'entrée exactement à expiration
    setTimeout(() => this._store.delete(key), ttlMs).unref?.();
  },
  get(key) {
    const e = this._store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { this._store.delete(key); return undefined; }
    return e.value;
  },
  has(key) { return this.get(key) !== undefined; },
  size() { return this._store.size; },
  purge() {
    const now = Date.now();
    for (const [k, v] of this._store) if (now > v.expiresAt) this._store.delete(k);
  },
};

// Purge périodique — toutes les 5 minutes (évite accumulation en cas de miss sur setTimeout)
setInterval(() => _memManager.purge(), 5 * 60 * 1000).unref?.();

// Init swarm au démarrage (non-bloquant)
try {
  import('../swarm/index.js').then(({ initSwarm }) => initSwarm())
    // FIX 1 — Log silencieux conditionnel (swarm optionnel)
    .catch((err) => {
      if (process.env.LOG_LEVEL === 'debug') {
        console.warn('[Queen] silent error:', err.message);
      }
    });
} catch {
  // swarm optionnel — ignoré silencieusement si indisponible
}

// ─── Chemins et Constantes ─────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MISSIONS_FILE = join(ROOT, ".laruche/missions.json");
const STANDALONE = isStandaloneMode();

// ─── Validation de la Config ───────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ADMIN_ID: process.env.ADMIN_TELEGRAM_ID,
  HUD_PORT: parseInt(process.env.HUD_PORT || "9001", 10),
  HUD_TOKEN: process.env.HUD_TOKEN || null,  // token optionnel pour sécuriser le WebSocket HUD
};

if (!STANDALONE) {
  if (!CONFIG.TELEGRAM_TOKEN) {
    logger.error("TELEGRAM_BOT_TOKEN manquant (requis hors mode standalone)");
    process.exit(1);
  }
  if (!CONFIG.ADMIN_ID) {
    logger.error("ADMIN_TELEGRAM_ID manquant (requis hors mode standalone)");
    process.exit(1);
  }
}

// ─── Missions (Cache + Persistance) ────────────────────────────────────────────────────────
let _missionsCache = null;
let _missionsCacheTs = 0;
const MISSIONS_CACHE_TTL_MS = 30_000;

// Cache L1 accélérateur pour les missions récentes (TTL 10 min, 200 entrées max)
const _missionCache = new MultilevelCache({ l1MaxSize: 200, defaultTtl: 600_000 });

export function loadMissions() {
  if (_missionsCache && Date.now() - _missionsCacheTs < MISSIONS_CACHE_TTL_MS) return _missionsCache;
  try {
    const dir = join(ROOT, ".laruche");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _missionsCache = existsSync(MISSIONS_FILE)
      ? JSON.parse(readFileSync(MISSIONS_FILE, "utf-8"))
      : [];
    _missionsCacheTs = Date.now();
  } catch (err) {
    logger.error(`Erreur chargement missions: ${err.message}`);
    _missionsCache = [];
    _missionsCacheTs = Date.now();
  }
  return _missionsCache;
}

export function saveMission(entry) {
  // FIX 2 — Mise à jour directe du cache mémoire sans relecture disque (évite race condition)
  _missionsCache = [entry, ...(_missionsCache || [])].slice(0, 200);
  _missionsCacheTs = Date.now(); // Réinitialise le TTL après écriture
  // Cache L1 accélérateur : indexe par id pour accès O(1)
  if (entry.id) _missionCache.set(entry.id, entry);
  try {
    writeFileSync(MISSIONS_FILE, JSON.stringify(_missionsCache, null, 2));
  } catch (err) {
    logger.error(`Erreur sauvegarde mission: ${err.message}`);
  }
}

// ─── Utilitaires ────────────────────────────────────────────────────────────────────────────
export const splitMsg = (text, max = 3900) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks.length ? chunks : [text];
};

export const safeParseJSON = (text, fallback) => {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : fallback;
  } catch {
    return fallback;
  }
};

// ─── FIX 4 — Cleanup automatique des screenshots (> 24h) ─────────────────────
const SCREENSHOTS_DIR = join(ROOT, ".laruche/temp/screenshots");

async function cleanupOldScreenshots(dir, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const files = await readdir(dir).catch(() => []);
    const now = Date.now();
    for (const f of files) {
      const fp = join(dir, f);
      const s = await stat(fp).catch(() => null);
      if (s && (now - s.mtimeMs) > maxAgeMs) {
        await unlink(fp).catch(() => {});
      }
    }
  } catch {}
}

// ─── HUD Service (WebSocket) ──────────────────────────────────────────────────────────────────
// IMPORTANT: Le serveur WS est créé dans startHUDServer() (appelé en bas du fichier,
// après la validation config) pour éviter un EADDRINUSE silencieux au démarrage.
const hudClients = new Set();
let wss = null;

function startHUDServer() {
  const server = new WebSocketServer({ port: CONFIG.HUD_PORT });

  // Gestion explicite EADDRINUSE — évite un crash non catchable (event "error" non bindé)
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.warn(`HUD: Port ${CONFIG.HUD_PORT} déjà utilisé — WebSocket HUD désactivé (HUD Electron déjà actif?)`);
    } else {
      logger.error(`HUD: Erreur WebSocketServer: ${err.message}`);
    }
  });

  server.on("connection", (ws, req) => {
    // Auth optionnelle via ?token=... si HUD_TOKEN est défini
    if (CONFIG.HUD_TOKEN) {
      try {
        const url = new URL(req.url, `http://localhost:${CONFIG.HUD_PORT}`);
        const token = url.searchParams.get("token");
        if (token !== CONFIG.HUD_TOKEN) {
          ws.close(4001, "Unauthorized");
          return;
        }
      } catch {
        ws.close(4001, "Unauthorized");
        return;
      }
    }
    hudClients.add(ws);
    logger.info(`HUD: Client connecté (${hudClients.size})`);
    ws.on("close", () => hudClients.delete(ws));
  });

  return server;
}

// ─── WebSocket broadcast avec batching 50ms ───────────────────────────────────
// Évite les centaines de send() individuels pour les missions rapides
let _hudBatch = [];
let _hudFlushTimer = null;

export function broadcastHUD(event) {
  _hudBatch.push({ ...event, ts: Date.now() });
  if (!_hudFlushTimer) {
    _hudFlushTimer = setTimeout(() => {
      _hudFlushTimer = null;
      if (_hudBatch.length === 0) return;
      const batch = _hudBatch.splice(0);
      // Envoie batch OU single selon taille
      const payload = batch.length === 1
        ? JSON.stringify(batch[0])
        : JSON.stringify({ type: 'batch', events: batch });
      hudClients.forEach((ws) => {
        if (ws.readyState === 1) {
          // FIX 3 — Gestion d'erreur WebSocket send avec suppression du client mort
          try {
            ws.send(payload);
          } catch (err) {
            console.warn('[HUD] WebSocket send failed, removing client:', err.message);
            hudClients.delete(ws);
          }
        }
      });
    }, 50);
  }
}

// ─── Queue : broadcast HUD à chaque changement pending/running ────────────────
// Enregistré ici (après broadcastHUD) pour que le callback soit disponible dès le démarrage.
missionQueue.onUpdate((stats) => {
  broadcastHUD({ type: "queue_update", ...stats });
});

// ─── Butterfly Loop (Cœur IA) v4.1 ────────────────────────────────────────────────────────────
/**
 * @param {string} command
 * @param {Function} replyFn
 * @param {string|null} missionId
 */
export async function butterflyLoop(command, replyFn = async () => {}, missionId = null) {
  // Mission struct immuable
  let mission = createMission({
    id: missionId || undefined,
    command,
    source: missionId ? 'standalone' : 'telegram',
  });
  mission = updateMissionState(mission, { status: 'running' });

  logger.info(`🧸 Mission: ${command.substring(0, 80)}`, { mission_id: mission.id });
  broadcastHUD({ type: "mission_start", command: command.substring(0, 100), missionId: mission.id });

  if (missionId) updateMission(missionId, { status: "running" });

  const roles = await autoDetectRoles();

  try {
    // Fast path : commande simple → 1 seule tâche worker, sans planification
    const isSimple = command.length < 80 && !/plan|stratégi|analys|architec|décompos/i.test(command);
    if (isSimple) {
      broadcastHUD({ type: "plan_ready", tasks: 1, missionId: mission.id });
      if (missionId) appendMissionEvent(missionId, { type: "plan_ready", tasks: [{ description: command }] });
      const fastResult = await callLLM(command, { role: "worker", temperature: 0.3, mission_id: mission.id, step_id: "fast" });
      mission = addModelUsed(mission, fastResult.model);
      const finalText = fastResult.text;
      mission = finalizeMission(mission, { status: 'success', result: finalText });
      saveMission({ id: mission.id, command, status: "success", duration: mission.duration_ms, models: mission.models_used, result: finalText, ts: mission.completed_at });
      broadcastHUD({ type: "mission_complete", duration: mission.duration_ms, missionId: mission.id });
      if (missionId) updateMission(missionId, { status: "success", result: finalText, duration: mission.duration_ms, models: mission.models_used, completedAt: mission.completed_at });
      return finalText;
    }

    // 1. Stratégie — cache plan TTL 5min pour éviter appel LLM redondant sur commande répétée
    const _planCacheKey = `plan:${command.substring(0, 200)}`;
    let plan = _memManager.get(_planCacheKey);

    if (!plan) {
      await replyFn(`🧠 Analyse stratégique avec **${roles.strategist}**...`, { parse_mode: "Markdown" });
      broadcastHUD({ type: "thinking", agent: "Stratège", thought: "Planification...", missionId: mission.id });
      if (missionId) appendMissionEvent(missionId, { type: "thinking", agent: "strategist" });

      const planPrompt = `Stratège LaRuche. Mission: "${command.substring(0, 200)}"
JSON uniquement:{"mission":"résumé","tasks":[{"id":1,"description":"tâche","role":"worker"}]}
2-3 tâches max. Rôles: worker|architect|vision`;

      const planResult = await callLLM(planPrompt, {
        role: "strategist",
        temperature: 0.2,
        mission_id: mission.id,
        step_id: "plan",
      });
      plan = safeParseJSON(planResult.text, {
        mission: command,
        tasks: [{ id: 1, description: command, role: "worker" }],
      });

      // Cache le plan 5 minutes (TTL plans)
      _memManager.set(_planCacheKey, plan, 5 * 60 * 1000);

      mission = addModelUsed(mission, planResult.model);
    } else {
      // Plan récupéré du cache — pas d'appel LLM stratège
      broadcastHUD({ type: "thinking", agent: "Stratège", thought: "Plan (cache)...", missionId: mission.id });
    }

    mission = addMissionStep(mission, { id: 'plan', skill: 'strategist', description: 'Planification', status: 'done', result: plan.mission });

    await replyFn(
      `📋 **${plan.mission || "Plan d'exécution"}**\n${plan.tasks.map((t) => ` • ${t.description}`).join("\n")}`,
      { parse_mode: "Markdown" }
    );
    broadcastHUD({ type: "plan_ready", tasks: plan.tasks.length, missionId: mission.id });
    if (missionId) appendMissionEvent(missionId, { type: "plan_ready", tasks: plan.tasks });

    // 2. Exécution parallèle
    const results = await Promise.all(
      plan.tasks.map(async (task) => {
        broadcastHUD({ type: "task_start", task: task.description.substring(0, 60), missionId: mission.id });
        if (missionId) appendMissionEvent(missionId, { type: "task_start", task: task.description });

        const role = task.role || "worker";
        const res = await callLLM(task.description, {
          role,
          temperature: 0.3,
          mission_id: mission.id,
          step_id: `task_${task.id}`,
        });
        logger.info(`⚡ [${res.model}] Tâche ${task.id} terminée`, { mission_id: mission.id });
        broadcastHUD({ type: "task_done", task: task.description.substring(0, 60), missionId: mission.id });
        if (missionId) appendMissionEvent(missionId, { type: "task_done", model: res.model });

        return { ...task, result: res.text, model: res.model };
      })
    );

    results.forEach((r) => { mission = addModelUsed(mission, r.model); });

    // 3. Synthèse
    broadcastHUD({ type: "thinking", agent: "Synthèse", thought: "Finalisation...", missionId: mission.id });
    const synthPrompt = `Synthèse directe pour: ${plan.mission}
${results.map((r, i) => `[${i+1}] ${r.result.substring(0, 250)}`).join("\n")}
Réponse courte et directe.`;

    const synthesis = await callLLM(synthPrompt, {
      role: "synthesizer",
      temperature: 0.3,
      mission_id: mission.id,
      step_id: "synthesis",
    });
    mission = addModelUsed(mission, synthesis.model);

    // Finalisation
    mission = finalizeMission(mission, { status: 'success', result: synthesis.text });
    logger.info(missionSummary(mission));

    saveMission({
      id: mission.id,
      command,
      status: "success",
      duration: mission.duration_ms,
      models: mission.models_used,
      result: synthesis.text,
      ts: mission.completed_at,
    });
    broadcastHUD({ type: "mission_complete", duration: mission.duration_ms, missionId: mission.id });

    if (missionId) {
      updateMission(missionId, {
        status: "success",
        result: synthesis.text,
        duration: mission.duration_ms,
        models: mission.models_used,
        completedAt: mission.completed_at,
      });
    }

    // Sync épisode vers la couche mémoire Python (non-bloquant)
    fetch('http://localhost:8006/episode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mission: command,
        result: synthesis.text.slice(0, 500),
        success: true,
        duration_ms: mission.duration_ms,
        model_used: mission.models_used.join(','),
        skills_used: [],
      }),
    // FIX 1 — Loggue toujours les erreurs de sauvegarde d'épisode (appel mémoire critique)
    }).catch((err) => console.warn('[Queen] ⚠️  Episode non sauvegardé:', err.message));

    return `${synthesis.text}\n\n_⏱ ${(mission.duration_ms / 1000).toFixed(1)}s — Modèles: ${mission.models_used.join(", ")}_`;
  } catch (err) {
    mission = finalizeMission(mission, { status: 'error', error: err.message });
    logger.error(`Butterfly Loop: ${err.message}`, { mission_id: mission.id });
    saveMission({ id: mission.id, command, status: "error", error: err.message, ts: mission.completed_at });
    broadcastHUD({ type: "mission_error", error: err.message, missionId: mission.id });
    if (missionId) updateMission(missionId, { status: "error", error: err.message, completedAt: mission.completed_at });
    throw err;
  }
}

export async function runMission(command, missionId) {
  // Mode Exécution Directe Totale :
  // 1. Toujours tenter la pipeline directe (rules → memory → LLM skills)
  // 2. Fallback butterfly uniquement si aucun step valide généré (question textuelle pure)
  return runComputerUseMission(command, missionId);
}

/**
 * Exécute une mission computer-use via runIntentPipeline (MCP + skills réels).
 * Met à jour la mission en temps réel (events, status, result).
 */
async function runComputerUseMission(command, missionId) {
  logger.info(`🖥️ Computer-use détecté → IntentPipeline`, { mission_id: missionId });
  // Passer immédiatement en "running" pour le dashboard
  if (missionId) updateMission(missionId, { status: "running" });

  // hudFn : broadcast HUD + append event dans le store API
  const hudFn = (event) => {
    broadcastHUD({ ...event, missionId });
    if (missionId) appendMissionEvent(missionId, event);
  };

  const onPlanReady = (planResult) => {
    if (missionId) updateMission(missionId, {
      status: "running",
      events: [],  // réinitialisé par appendMissionEvent ensuite
    });
    hudFn({ type: "plan_ready", tasks: planResult.steps, goal: planResult.goal });
  };

  const onStepDone = (stepIdx, total, step, result) => {
    hudFn({
      type: "step_done",
      step: stepIdx,
      total,
      skill: step.skill,
      success: result?.success !== false,
    });
  };

  try {
    const result = await runIntentPipeline(command, {
      hudFn,
      onPlanReady,
      onStepDone,
      useVision: process.env.LARUCHE_MODE !== "low",
      usePlaywright: false,  // désactivé par défaut — évite crash si Playwright absent
    });

    // Extrait le contenu textuel d'un résultat de skill
    const extractContent = (s) => {
      const r = s.result;
      if (!r?.success) return null;
      // http_fetch retourne r.result
      if (r.result && typeof r.result === 'string') return r.result.slice(0, 600);
      // run_command / run_shell retournent r.output ou r.stdout
      if (r.output && typeof r.output === 'string') return r.output.slice(0, 600);
      if (r.stdout && typeof r.stdout === 'string') return r.stdout.slice(0, 600);
      // message de skill (smart_click, find_element…) ou llm_answer
      if (r.message && typeof r.message === 'string') return r.message;
      return null;
    };

    // Réponse textuelle LLM directe (fallback pipeline)
    if (result._textResponse) {
      const summary = `💬 ${result._textResponse.slice(0, 800)}`;
      saveMission({ id: missionId, command, status: "success", duration: result.duration, result: summary, ts: new Date().toISOString() });
      if (missionId) updateMission(missionId, { status: "success", result: summary, duration: result.duration, completedAt: new Date().toISOString() });
      broadcastHUD({ type: "mission_complete", duration: result.duration, missionId });
      // Mémoire épisodique — enregistre l'expérience de la mission
      import('../memory/episodic/index.js').then(({ storeEpisode }) => {
        storeEpisode({ mission: command, actions: [], outcome: 'success', rewardScore: 1.0, lessons: [] });
      // FIX 1 — Log silencieux conditionnel (module optionnel)
      }).catch((err) => {
        if (process.env.LOG_LEVEL === 'debug') {
          console.warn('[Queen] silent error:', err.message);
        }
      });
      return summary;
    }

    const summary = result.success
      ? `✅ Mission accomplie en ${(result.duration / 1000).toFixed(1)}s\n\n` +
        result.steps.map((s, i) => {
          const ok = s.result?.success ? '✓' : '✗';
          const content = extractContent(s);
          return `${i + 1}. ${s.step.skill}: ${ok}${content ? '\n' + content : ''}`;
        }).join('\n\n')
      : `⚠️ Partiellement complété (${result.steps.filter(s => s.result?.success !== false).length}/${result.steps.length} étapes)\n\n` +
        (result.error || 'Certaines étapes ont échoué');

    // Apprend le plan si succès via LLM (pour accélérer les prochaines fois)
    if (result.success && result.model && result.model !== 'rules-engine' && result.model !== 'memory') {
      const learnedSteps = result.steps?.map(s => s.step).filter(Boolean) || [];
      if (learnedSteps.length > 0) {
        setImmediate(() => learn(command, learnedSteps, true, result.duration, 'llm'));
      }
    }

    const finalStatus = result.success ? "success" : "partial";
    saveMission({
      id: missionId,
      command,
      status: finalStatus,
      duration: result.duration,
      result: summary,
      ts: new Date().toISOString(),
    });

    if (missionId) updateMission(missionId, {
      status: finalStatus,
      result: summary,
      duration: result.duration,
      completedAt: new Date().toISOString(),
    });

    broadcastHUD({ type: "mission_complete", duration: result.duration, missionId });

    // Mémoire épisodique — enregistre l'expérience de la mission
    import('../memory/episodic/index.js').then(({ storeEpisode }) => {
      storeEpisode({
        mission: command,
        actions: result.steps?.map(s => s.step).filter(Boolean) || [],
        outcome: finalStatus,
        rewardScore: result.success ? 1.0 : 0.5,
        lessons: [],
      });
    // FIX 1 — Log silencieux conditionnel (module optionnel)
    }).catch((err) => {
      if (process.env.LOG_LEVEL === 'debug') {
        console.warn('[Queen] silent error:', err.message);
      }
    });

    return summary;

  } catch (err) {
    logger.error(`Computer-use pipeline erreur: ${err.message}`, { mission_id: missionId });
    saveMission({ id: missionId, command, status: "error", error: err.message, ts: new Date().toISOString() });
    if (missionId) updateMission(missionId, {
      status: "error",
      error: err.message,
      completedAt: new Date().toISOString(),
    });
    broadcastHUD({ type: "mission_error", error: err.message, missionId });

    // Mémoire épisodique — enregistre l'échec
    import('../memory/episodic/index.js').then(({ storeEpisode }) => {
      storeEpisode({ mission: command, actions: [], outcome: 'error', rewardScore: 0.0, lessons: [] });
    // FIX 1 — Log silencieux conditionnel (module optionnel)
    }).catch((err) => {
      if (process.env.LOG_LEVEL === 'debug') {
        console.warn('[Queen] silent error:', err.message);
      }
    });

    throw err;
  }
}

// ─── Initialisation SubagentManager ──────────────────────────────────────────
// Injecte les dépendances (logger, broadcastHUD, runMission) maintenant que tout est défini.
subagentManager.setDeps({ logger, broadcastHUD, runMission });
logger.info("🐝 SubagentManager initialisé — sous-agents: " +
  subagentManager.list().map(a => `${a.icon} ${a.name}`).join(", "));

// ─── Health check Ollama au démarrage ─────────────────────────────────────────
/**
 * Vérifie la disponibilité d'Ollama et la présence des modèles requis.
 * Stocke le résultat dans process.env.OLLAMA_AVAILABLE ('true'|'false').
 * @returns {Promise<boolean>}
 */
async function checkOllamaHealth() {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { models } = await r.json();
    const names = models.map(m => m.name);
    const required = ['llama3.2:3b', 'llama3:latest'];
    const missing = required.filter(m => !names.some(n => n.startsWith(m.split(':')[0])));
    if (missing.length) {
      logger.warn(`[Init] Modèles Ollama manquants: ${missing.join(', ')} — certaines fonctions limitées`);
    } else {
      logger.info(`[Init] Ollama OK — ${names.length} modèles disponibles`);
    }
    process.env.OLLAMA_AVAILABLE = 'true';
    return true;
  } catch (e) {
    logger.error(`[Init] Ollama inaccessible: ${e.message} — mode dégradé activé`);
    process.env.OLLAMA_AVAILABLE = 'false';
    return false;
  }
}

// ─── Démarrage ───────────────────────────────────────────────────────────────────────────────
logger.info("╔══════════════════════════════════════════╗");
logger.info(`║ 🐝 LaRuche OSS v4.1 — ${STANDALONE ? "Standalone    " : "Telegram mode"} ║`);
logger.info("╚══════════════════════════════════════════╝");

// Vérifie Ollama avant de démarrer l'API (Wave 2 — abstraction LLM)
await checkOllamaHealth();

// FIX 4 — Cleanup screenshots au démarrage + toutes les heures
cleanupOldScreenshots(SCREENSHOTS_DIR);
setInterval(() => cleanupOldScreenshots(SCREENSHOTS_DIR), 60 * 60 * 1000).unref();

// Démarrage du serveur HUD WebSocket (après validation config, avec gestion EADDRINUSE)
wss = startHUDServer();
logger.info(`📡 HUD WebSocket en écoute sur port ${CONFIG.HUD_PORT}`);

// Démarrage du health monitor distribué (7 couches Python)
const healthMonitor = new DistributedHealthMonitor(eventBus);
healthMonitor.start();

// Réaction aux couches Python down (alerte après 3 échecs consécutifs)
eventBus.on('layer.down', ({ name, failures }) => {
  if (failures >= 3) {
    console.error(`[Queen] ⚠️  ${name} DOWN depuis ${failures} checks — intervention requise`);
  }
});

await printRoles();

autoDetectRoles()
  .then((roles) => logger.info(`✅ Rôles préchaufés: ${Object.values(roles).join(", ")}`))
  // FIX 1 — Log silencieux conditionnel (préchauffage optionnel)
  .catch((err) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.warn('[Queen] silent error:', err.message);
    }
  });

try {
  startCronRunner();
  logger.info("⏰ Cron runner démarré");
} catch (err) {
  logger.warn(`Cron runner: ${err.message}`);
}

// ─── MODE STANDALONE ───────────────────────────────────────────────────────────────────────
if (STANDALONE) {
  logger.info("🌐 Mode Standalone activé — Telegram désactivé");
  startStandaloneServer({ loadMissions, saveMission, runMission, autoDetectRoles, broadcastHUD, logger, subagentManager, healthMonitor, missionCache: _missionCache, eventBus });
  const shutdown = () => { logger.info("🛑 Arrêt en cours..."); wss.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// ─── MODE TELEGRAM ───────────────────────────────────────────────────────────────────────────
else {
  const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);

  bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== CONFIG.ADMIN_ID) { await ctx.reply("⛔ Accès refusé."); return; }
    return next();
  });

  bot.command("start", async (ctx) => {
    const roles = await autoDetectRoles();
    await ctx.reply(
      `🐝 *LaRuche OSS v4.1 — 100% Local*\n\n` +
      `*Modèles actifs:*\n` +
      ` 👑 Stratège: \`${roles.strategist}\`\n` +
      ` 🔧 Code: \`${roles.architect}\`\n` +
      ` ⚡ Worker: \`${roles.worker}\`\n` +
      ` 👁 Vision: \`${roles.vision}\`\n\n` +
      `*Commandes:*\n` +
      `/status — État\n/models — Modèles actifs\n/mission <tâche> — Mission\n/skill <desc> — Créer skill\n\n` +
      `_Message libre → Mission directe_`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("models", async (ctx) => {
    const roles = await autoDetectRoles();
    const lines = Object.entries(roles).map(([role, model]) => ` \`${role}\`: ${model}`);
    await ctx.reply(`*Configuration Modèles (Ollama local):*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("status", async (ctx) => {
    const roles = await autoDetectRoles();
    const missions = loadMissions();
    const success = missions.filter((m) => m.status === "success").length;
    await ctx.reply(
      `*ÉTAT LARUCHE OSS v4.1*\n\n` +
      `Stratège: \`${roles.strategist}\`\nMissions: ${missions.length} (${success} réussies)\n` +
      `HUD: ✅ ${hudClients.size} client(s)\nUptime: ${Math.floor(process.uptime() / 60)}min\n` +
      `Mode: 🔓 100% Open Source Local`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("mission", async (ctx) => {
    const text = ctx.message.text.replace("/mission", "").trim();
    if (!text) { await ctx.reply("Usage: /mission <tâche>"); return; }
    try {
      const result = await butterflyLoop(text, (msg, opts) => ctx.reply(msg, opts));
      for (const chunk of splitMsg(result)) await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.command("skill", async (ctx) => {
    const desc = ctx.message.text.replace("/skill", "").trim();
    if (!desc) { await ctx.reply("Usage: /skill <description>"); return; }
    const roles = await autoDetectRoles();
    const msg = await ctx.reply(`🔧 Génération skill avec \`${roles.architect}\`...`, { parse_mode: "Markdown" });
    const codePrompt = `Génère un skill JavaScript pour LaRuche:
Description: ${desc}
Format EXACT:
\`\`\`js
export async function run(params) {
  return { success: true, result: "..." };
}
\`\`\``;
    const result = await callLLM(codePrompt, { role: "architect", temperature: 0.1 });
    const skillName = desc.toLowerCase().replace(/[^a-z0-9]+/g, "_").substring(0, 25);
    const skillDir = join(ROOT, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.js"), result.text);
    writeFileSync(join(skillDir, "manifest.json"), JSON.stringify(
      { name: skillName, description: desc, version: "1.0.0", model: result.model, created: new Date().toISOString() }, null, 2
    ));
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `✅ Skill créé: \`${skillName}\`\n\n${result.text.substring(0, 500)}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.on("text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const text = ctx.message.text.trim();
    try {
      const { isComputerUseIntent, runIntentPipeline } = await import("./agents/intentPipeline.js");
      if (isComputerUseIntent(text)) {
        const statusMsg = await ctx.reply(`🧠 Planification: _"${text.slice(0, 60)}"_`, { parse_mode: "Markdown" });
        const pipelineResult = await runIntentPipeline(text, {
          hudFn: broadcastHUD,
          onPlanReady: async (planResult) => {
            const stepList = planResult.steps.map((s, i) => ` ${i + 1}. \`${s.skill}\``).join("\n");
            await ctx.telegram.editMessageText(
              ctx.chat.id, statusMsg.message_id, undefined,
              `📋 *${planResult.goal}*\n\n${stepList}`, { parse_mode: "Markdown" }
            ).catch(() => {});
          },
          onStepDone: (current, total, step, result) => {
            const icon = result?.success !== false ? "✅" : "❌";
            logger.info(`[intent] Step ${current}/${total}: ${icon} ${step.skill}`);
          },
        });
        const duration = (pipelineResult.duration / 1000).toFixed(1);
        const icon = pipelineResult.success ? "✅" : "⚠️";
        await ctx.reply(
          pipelineResult.success
            ? `${icon} *${pipelineResult.goal}*\n_${pipelineResult.steps.length} étapes — ${duration}s_`
            : `${icon} *Partiel:* ${pipelineResult.goal}\n_${pipelineResult.error || "Certaines étapes ont échoué"}_`,
          { parse_mode: "Markdown" }
        );
        saveMission({ command: text, status: pipelineResult.success ? "success" : "partial", duration: pipelineResult.duration, ts: new Date().toISOString() });
        import("./memory_store.js")
          .then(({ storeMissionMemory }) => {
            storeMissionMemory(pipelineResult)
              // FIX 1 — Log silencieux conditionnel (mémoire non bloquante)
              .catch((err) => {
                if (process.env.LOG_LEVEL === 'debug') {
                  console.warn('[Queen] silent error:', err.message);
                }
              });
          })
          // FIX 1 — Log silencieux conditionnel (module optionnel)
          .catch((err) => {
            if (process.env.LOG_LEVEL === 'debug') {
              console.warn('[Queen] silent error:', err.message);
            }
          });
      } else {
        const result = await butterflyLoop(text, (msg, opts) => ctx.reply(msg, opts));
        for (const chunk of splitMsg(result)) await ctx.reply(chunk, { parse_mode: "Markdown" });
      }
    } catch (err) {
      logger.error(`Text handler: ${err.message}`);
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/getUpdates?timeout=0&offset=-1`);
    await new Promise((r) => setTimeout(r, 1500));
    logger.info("🔑 Session Telegram libérée");
  } catch {
    logger.warn("Libération session Telegram impossible");
  }

  bot.launch({ dropPendingUpdates: true })
    .then(() => logger.info("🤖 Bot Telegram actif ✅"))
    .catch((err) => {
      if (err.response?.error_code === 409) {
        logger.error("409 Conflict — un autre bot utilise ce token.");
      } else {
        logger.error(`Erreur bot: ${err.message}`);
      }
      process.exit(1);
    });

  const shutdown = () => { logger.info("🛑 Arrêt en cours..."); bot.stop(); wss.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
