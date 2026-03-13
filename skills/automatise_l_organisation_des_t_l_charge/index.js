/**
 * automatise_l_organisation_des_t_l_charge/index.js — Ghost OS v7 Runtime Interface
 * Bridge entre execute(params) et toolRouter + World Model check
 */
import { createHash } from "crypto";
import { run as skillRun } from "./skill.js";

// Cache SHA-256 pour osascript (<100ms sur cache hit)
const _cache = new Map();
const CACHE_TTL_MS = 5000;

function cacheKey(params) {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

async function checkWorldModel() {
  try {
    const r = await fetch("http://localhost:8002/scan", {
      signal: AbortSignal.timeout(500),
    });
    if (r.ok) return { ready: true };
  } catch {
    // Fail-open si la couche perception est indisponible
  }
  return { ready: true };
}

async function reportFailure(skillName, error, params) {
  try {
    await fetch("http://localhost:8006/experience", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skill: skillName,
        outcome: "failure",
        error: error.message || String(error),
        params,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

export async function execute(params = {}) {
  // 1. World Model check — l'état UI/système est-il prêt ?
  const worldState = await checkWorldModel();
  if (!worldState.ready) {
    return { success: false, error: `World Model bloque l'exécution: ${worldState.reason}`, blocked: true };
  }

  // 2. Cache SHA-256 pour les appels répétés (osascript < 100ms)
  const key = cacheKey(params);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.result, cached: true, duration_ms: 0 };
  }

  // 3. Exécution
  const start = Date.now();
  try {
    const result = await skillRun(params);
    const duration_ms = Date.now() - start;
    const final = { ...result, duration_ms };

    // Mise en cache si succès
    if (result.success !== false) {
      _cache.set(key, { result: final, ts: Date.now() });
    }
    return final;
  } catch (err) {
    const duration_ms = Date.now() - start;
    await reportFailure("automatise_l_organisation_des_t_l_charge", err, params);
    return { success: false, error: err.message, duration_ms };
  }
}

// Export run pour compatibilité avec l'ancienne interface Ghost OS v5/v6
export const run = execute;
