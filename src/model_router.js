/**
 * model_router.js — Routeur Intelligent de Modèles LaRuche
 * 100% Ollama local — Zéro cloud, zéro coût, vie privée totale
 *
 * Architecture Open Source:
 *   L1 Stratège    → glm-4.6 / gpt-oss:120b (raisonnement profond)
 *   L2 Architecte  → qwen3-coder (code, debug, skill factory)
 *   L3 Ouvrières   → llama3.2:3b ×10 (micro-tâches parallèles)
 *   L4 Vision      → llava / llama3.2-vision (analyse écran)
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

// ─── M2 Detection (PICO extension) ──────────────────────────────────────────
import { totalmem, freemem } from 'os';
import { execSync } from 'child_process';

function detectM2Config() {
  const totalRAM = Math.round(totalmem() / 1024 / 1024 / 1024);
  const freeRAM = Math.round(freemem() / 1024 / 1024 / 1024);
  let mlxAvailable = false;
  try { execSync('python3 -c "import mlx_lm"', { stdio: 'ignore' }); mlxAvailable = true; } catch {}
  const visionModel = totalRAM >= 24 ? 'llava' : 'moondream';
  console.info(`[ModelRouter] RAM: ${totalRAM}GB / ${freeRAM}GB libre | MLX: ${mlxAvailable} | Vision: ${visionModel}`);
  return { totalRAM, freeRAM, mlxAvailable, visionModel };
}

export const M2_CONFIG = detectM2Config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, ".laruche/config.json");

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// Cache des modèles disponibles
let _availableModels = null;
let _lastFetch = 0;

/**
 * Récupère les modèles Ollama disponibles (cache 60s)
 */
export async function getAvailableModels() {
  if (_availableModels && Date.now() - _lastFetch < 60000) {
    return _availableModels;
  }
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    _availableModels = (data.models || []).map((m) => m.name);
    _lastFetch = Date.now();
    return _availableModels;
  } catch {
    return _availableModels || [];
  }
}

/**
 * Charge la config des rôles depuis .laruche/config.json (cache TTL 5min)
 */
let _roleConfigCache = null;
let _roleConfigTs = 0;
function loadRoleConfig() {
  if (_roleConfigCache && Date.now() - _roleConfigTs < 300000) return _roleConfigCache;
  try { _roleConfigCache = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).models || {}; }
  catch { _roleConfigCache = {}; }
  _roleConfigTs = Date.now();
  return _roleConfigCache;
}

/**
 * Détection automatique du meilleur modèle pour chaque rôle
 */
export async function autoDetectRoles() {
  const available = await getAvailableModels();
  const config = loadRoleConfig();

  const roles = {
    strategist: config.strategist || findBest(available, [
      "glm-4.7", "glm-4.6", "glm-4.6:cloud",
      "gpt-oss:120b-cloud", "gpt-oss:120b",
      "qwen3:72b", "llama3.1:70b",
      "llama3:latest", "llama3.2:latest",
    ]),
    architect: config.architect || findBest(available, [
      "qwen3-coder:480b-cloud", "qwen3-coder:32b",
      "qwen3-coder:14b", "qwen3-coder",
      "deepseek-coder:33b", "codellama:34b",
      "llama3.2:3b",
    ]),
    worker: config.worker || findBest(available, [
      "llama3.2:3b", "llama3.2:latest",
      "minimax-m2:cloud", "minimax-m2",
      "phi3:mini", "phi3",
      "llama3:latest",
    ]),
    vision: config.vision || findBest(available, [
      "llama3.2-vision:latest", "llama3.2-vision",
      "qwen3-vl:235b-cloud", "qwen3-vl",
      "llava:latest", "llava:13b", "llava",
      "moondream:latest", "moondream",
    ]),
    visionFast: config.visionFast || findBest(available, [
      "moondream:latest", "moondream",
      "llava:7b", "llava:latest", "llava",
    ]),
    synthesizer: config.synthesizer || findBest(available, [
      "glm-4.6", "glm-4.6:cloud",
      "gpt-oss:20b-cloud", "gpt-oss:20b",
      "llama3.2:latest", "llama3:latest",
    ]),
  };

  // PICO extensions — ajouts sans écraser les rôles existants
  if (!roles.compressor) {
    roles.compressor = 'llama3.2:3b';
  }
  if (!roles.strategistMLX && M2_CONFIG.mlxAvailable) {
    roles.strategistMLX = process.env.MLX_MODEL_PATH || './mlx-models/qwen3-7b';
  }

  return roles;
}

function findBest(available, candidates) {
  const availableSet = new Map(available.map(m => [m, true]));
  const availableNames = new Map(available.map(m => [m.split(":")[0], m]));
  for (const candidate of candidates) {
    if (availableSet.has(candidate)) return candidate;
    const base = candidate.split(":")[0];
    if (availableNames.has(base)) return availableNames.get(base);
  }
  return available[0] || "llama3.2:3b";
}

/**
 * Route une requête vers le modèle optimal
 */
export async function route(task, hint = null) {
  const roles = await autoDetectRoles();

  if (hint) {
    // PICO extensions
    if (hint === 'strategist' && M2_CONFIG.mlxAvailable) {
      return { provider: 'mlx', model: process.env.MLX_MODEL_PATH || './mlx-models/qwen3-7b', endpoint: 'http://127.0.0.1:8080/v1' };
    }
    if (hint === 'vision') {
      const vModel = process.env.VISION_MODEL === 'auto' || !process.env.VISION_MODEL ? M2_CONFIG.visionModel : process.env.VISION_MODEL;
      return { provider: 'ollama', model: vModel };
    }
    if (hint === 'compressor') {
      return { provider: 'ollama', model: 'llama3.2:3b' };
    }
    return roles[hint] || roles.worker;
  }

  const t = task.toLowerCase();

  if (/\bcode\b|script|function|\bfonction\b|debug|refactor|\bprogramme\b|implement|\bclass\b|\bapi\b|fix\s+bug|écris\s+un|génère\s+un\s+script|python|javascript|typescript|bash|sql|algorithme/.test(t)) {
    return roles.architect;
  }
  if (/vision|écran|screen|image|pixel|clic|bouton|interface|ui|screenshot/.test(t)) {
    return roles.vision;
  }
  if (/plan|stratégie|décompose|analyse|architecture|mission|objectif/.test(t)) {
    return roles.strategist;
  }

  return roles.worker;
}

/**
 * Appel cloud Anthropic (fallback si Ollama indisponible)
 * Nécessite ANTHROPIC_API_KEY dans .env
 */
async function askAnthropic(prompt, { model = "claude-haiku-4-5-20251001", temperature = 0.3, timeout = 60000 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquant");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: parseInt(process.env.LLM_NUM_PREDICT || "700"),
      temperature,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  return { text, model: `anthropic/${model}`, success: true };
}

/**
 * Appel Ollama avec routing automatique + fallback cloud
 */
export async function ask(prompt, options = {}) {
  const {
    role = null,
    task = prompt,
    temperature = 0.3,
    timeout = 60000,
    num_predict = null,
    cloudFallback = process.env.CLOUD_FALLBACK === "true",
  } = options;

  const roles = await autoDetectRoles();
  const model = role
    ? roles[role] || roles.worker
    : await route(task);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        keep_alive: -1,
        options: {
          temperature,
          num_predict: num_predict || parseInt(process.env.LLM_NUM_PREDICT || "700"),
          num_ctx: parseInt(process.env.LLM_NUM_CTX || "4096"),
          num_thread: parseInt(process.env.LLM_NUM_THREAD || "0"),
          top_k: 20,
          top_p: 0.9,
          repeat_penalty: 1.1,
          low_vram: false,
          f16_kv: true,
        },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return { text: data.response || "", model, success: true };
  } catch (e) {
    // Fallback cloud Anthropic si Ollama échoue et que la clé est disponible
    if (cloudFallback || process.env.ANTHROPIC_API_KEY) {
      try {
        console.warn(`[model_router] Ollama "${model}" échoué (${e.message.slice(0, 50)}) → fallback Anthropic`);
        return await askAnthropic(prompt, { temperature, timeout });
      } catch (cloudErr) {
        return { text: "", model: `anthropic/fallback`, success: false, error: `Ollama: ${e.message} | Anthropic: ${cloudErr.message}` };
      }
    }
    return { text: "", model, success: false, error: e.message };
  }
}

/**
 * Appel streaming
 */
export async function* stream(prompt, options = {}) {
  const { role = null, task = prompt, temperature = 0.7 } = options;
  const model = role
    ? (await autoDetectRoles())[role]
    : await route(task);

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: true, options: { temperature } }),
  });

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.response) yield { token: j.response, model, done: j.done };
      } catch {}
    }
  }
}

/**
 * Affiche la configuration des rôles détectée
 */
export async function printRoles() {
  const roles = await autoDetectRoles();
  console.log("\n🐝 Configuration Modèles LaRuche (100% Ollama)\n");
  const icons = {
    strategist: "👑 L1 Stratège",
    architect: "🔧 L2 Architecte",
    worker: "⚡ L3 Ouvrière",
    vision: "👁 L4 Vision",
    visionFast: "📷 L4 Vision rapide",
    synthesizer: "🧠 Synthèse",
  };
  for (const [role, model] of Object.entries(roles)) {
    console.log(`  ${(icons[role] || role).padEnd(22)} → ${model}`);
  }
  console.log();
}

/**
 * Pour les tests uniquement — injecte directement dans le cache des modèles disponibles.
 * Permet de tester le routing sans Ollama réel.
 * @param {string[]} models
 */
export function _setAvailableModelsCache(models) {
  _availableModels = models;
  _lastFetch = Date.now();
}
