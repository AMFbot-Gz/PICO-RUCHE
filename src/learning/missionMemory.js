/**
 * missionMemory.js — Mémoire auto-apprenante LaRuche v2.0
 *
 * Apprend des plans réussis pour transformer toute demande en exécution directe.
 * Plus besoin du LLM pour une commande déjà vue ou similaire.
 *
 * Nouveauté v2.0 : similarité sémantique via embeddings Ollama (nomic-embed-text)
 * avec fallback automatique sur Jaccard si Ollama est indisponible.
 *
 * Stockage:
 *   data/learned_routes.json  — routes apprises + embeddings (persist entre redémarrages)
 *   data/mission_log.jsonl    — journal complet de toutes les missions
 *
 * Pipeline:
 *   1. routeByRules() — règles statiques (instant)
 *   2. recall()       — mémoire apprise (instant, cosine ou Jaccard)
 *   3. LLM planner    — fallback lent (~10-30s)
 *   4. learn()        — enregistre le résultat LLM + calcule l'embedding en arrière-plan
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../');
const DATA_DIR = join(ROOT, 'data');
const ROUTES_FILE = join(DATA_DIR, 'learned_routes.json');
const LOG_FILE = join(DATA_DIR, 'mission_log.jsonl');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Cache en RAM + flag dirty pour éviter écritures inutiles
let _routes = null;
let _dirty = false;

// ─── Cache embeddings en RAM (text → number[]) ────────────────────────────────

const _embeddingCache = new Map();

// Endpoint Ollama (configurable via env)
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// Timeout pour les appels embeddings : 5s max
const EMBED_TIMEOUT_MS = 5000;

// Modèles d'embeddings à essayer dans l'ordre (priorité décroissante)
const EMBED_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'llama3.2:3b'];

// Modèle embedding actuellement fonctionnel (cache pour éviter de re-tester à chaque appel)
let _embedModel = null;
let _embedModelChecked = false;

// ─── Chargement / Sauvegarde ───────────────────────────────────────────────────

function loadRoutes() {
  if (_routes) return _routes;
  try {
    if (existsSync(ROUTES_FILE)) {
      _routes = JSON.parse(readFileSync(ROUTES_FILE, 'utf8'));
      // Pré-remplit le cache en RAM avec les embeddings stockés sur disque
      for (const r of _routes) {
        if (r.embedding && r.normalizedCommand) {
          _embeddingCache.set(r.normalizedCommand, r.embedding);
        }
      }
      return _routes;
    }
  } catch {}
  _routes = [];
  return _routes;
}

function flushRoutes() {
  if (!_dirty) return;
  try {
    writeFileSync(ROUTES_FILE, JSON.stringify(_routes, null, 2), 'utf8');
    _dirty = false;
  } catch (e) {
    console.warn('[Memory] flush error:', e.message);
  }
}

// ─── Embeddings Ollama ────────────────────────────────────────────────────────

/**
 * Détecte quel modèle d'embeddings est disponible dans Ollama.
 * Résultat mis en cache (_embedModel) pour ne tester qu'une fois par session.
 *
 * @returns {Promise<string|null>} — nom du modèle ou null si aucun disponible
 */
async function detectEmbedModel() {
  if (_embedModelChecked) return _embedModel;
  _embedModelChecked = true;

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) { _embedModel = null; return null; }

    const data = await res.json();
    const available = new Set((data.models || []).map(m => m.name));

    // Cherche par nom exact, puis par préfixe (ex: "nomic-embed-text:latest")
    for (const candidate of EMBED_MODELS) {
      if (available.has(candidate)) { _embedModel = candidate; return _embedModel; }
      // Cherche avec tag :latest ou autre tag
      const withTag = [...available].find(m => m.startsWith(candidate + ':'));
      if (withTag) { _embedModel = withTag; return _embedModel; }
    }

    _embedModel = null;
  } catch {
    _embedModel = null;
  }

  return _embedModel;
}

/**
 * Calcule l'embedding d'un texte via Ollama.
 * Utilise un cache en RAM pour éviter les appels redondants.
 * Timeout 5s — retourne null en cas d'échec (le fallback Jaccard prend le relais).
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embedText(text) {
  if (!text) return null;

  // Cache RAM en priorité
  if (_embeddingCache.has(text)) return _embeddingCache.get(text);

  // Détecte le modèle disponible (une seule fois par session)
  const model = await detectEmbedModel();
  if (!model) return null;

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const embedding = data.embedding;

    if (!Array.isArray(embedding) || embedding.length === 0) return null;

    // Stocke dans le cache RAM
    _embeddingCache.set(text, embedding);
    return embedding;

  } catch {
    // Timeout ou Ollama absent — le fallback Jaccard gérera
    return null;
  }
}

// ─── Similarité sémantique ────────────────────────────────────────────────────

/**
 * Cosine similarity entre deux vecteurs d'embeddings.
 * Retourne un score entre 0 et 1 (1 = identique).
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/["`''""[\](){}]/g, '')
    .replace(/[àáâãä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o').replace(/[ùûü]/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stop-words FR/EN à ignorer dans la comparaison Jaccard
const STOP = new Set(['le','la','les','un','une','des','du','de','sur','dans','avec','et','ou','par',
  'pour','the','a','an','is','on','in','at','of','to','do','be','it']);

function tokenize(text) {
  return normalize(text)
    .split(' ')
    .filter(w => w.length > 2 && !STOP.has(w));
}

/**
 * Similarité Jaccard — fallback si embeddings indisponibles.
 * Score entre 0 et 1 basé sur l'intersection de tokens.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function jaccardSim(a, b) {
  const wa = new Set(tokenize(a));
  const wb = new Set(tokenize(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  const intersection = [...wa].filter(w => wb.has(w)).length;
  return intersection / (wa.size + wb.size - intersection);
}

/**
 * Similarité entre deux textes.
 * Utilise cosine sur embeddings si disponibles dans le cache,
 * sinon fallback Jaccard transparent.
 *
 * Cette fonction est SYNCHRONE (utilise uniquement le cache en RAM).
 *
 * @param {string} textA
 * @param {string} textB
 * @param {number[]|null} embA — embedding pré-calculé pour textA (optionnel)
 * @param {number[]|null} embB — embedding pré-calculé pour textB (optionnel)
 * @returns {number}
 */
function similarity(textA, textB, embA = null, embB = null) {
  // Essaie cosine si les deux embeddings sont disponibles
  const vecA = embA || _embeddingCache.get(textA) || null;
  const vecB = embB || _embeddingCache.get(textB) || null;

  if (vecA && vecB) {
    return cosineSim(vecA, vecB);
  }

  // Fallback Jaccard (zéro dépendance externe, toujours disponible)
  return jaccardSim(textA, textB);
}

// ─── API publique ──────────────────────────────────────────────────────────────

/**
 * Enregistre un plan réussi (ou toute mission) dans le journal.
 * Apprend uniquement les succès qui viennent du LLM.
 * Lance le calcul d'embedding en arrière-plan (non-bloquant).
 *
 * @param {string} command         — commande originale
 * @param {Array}  steps           — [{skill, params, description}]
 * @param {boolean} success
 * @param {number}  duration       — ms
 * @param {string}  source         — 'rules' | 'memory' | 'llm'
 */
export function learn(command, steps, success, duration = 0, source = 'llm') {
  // Toujours logger
  try {
    appendFileSync(LOG_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      command: (command || '').slice(0, 200),
      steps: (steps || []).slice(0, 6),
      success,
      duration,
      source,
    }) + '\n', 'utf8');
  } catch {}

  // N'apprend que les plans LLM réussis avec au moins 1 step valide
  if (!success || source !== 'llm' || !Array.isArray(steps) || steps.length === 0) return;

  const routes = loadRoutes();
  const norm = normalize(command);

  // Cherche une route très similaire (≥90%) — utilise Jaccard pour la déduplication
  // (synchrone, les embeddings seront calculés en arrière-plan après)
  const existing = routes.find(r => similarity(r.normalizedCommand, command) >= 0.90);

  if (existing) {
    existing.hits = (existing.hits || 0) + 1;
    existing.totalSuccess = (existing.totalSuccess || 0) + 1;
    existing.lastUsed = new Date().toISOString();
    // Rafraîchit le plan avec la version la plus récente
    existing.steps = steps;

    // Recalcul embedding en arrière-plan si la commande a changé
    _updateEmbeddingAsync(existing, norm);
  } else {
    const newRoute = {
      normalizedCommand: norm,
      originalCommand: command,
      steps,
      hits: 1,
      totalSuccess: 1,
      avgDuration: duration,
      learnedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      embedding: null, // sera rempli en arrière-plan
    };
    routes.push(newRoute);

    // Limite à 1000 routes, garde les plus utilisées
    if (routes.length > 1000) {
      routes.sort((a, b) => (b.hits || 0) - (a.hits || 0));
      routes.splice(1000);
    }

    // Calcul embedding en arrière-plan (non-bloquant)
    _updateEmbeddingAsync(newRoute, norm);
  }

  _dirty = true;
  flushRoutes();
}

/**
 * Calcule et stocke l'embedding d'une route en arrière-plan.
 * Ne bloque jamais — les erreurs sont silencieuses.
 *
 * @param {object} route    — référence à l'objet route dans _routes
 * @param {string} text     — texte à encoder
 */
function _updateEmbeddingAsync(route, text) {
  embedText(text).then(embedding => {
    if (embedding) {
      route.embedding = embedding;
      _dirty = true;
      // Flush différé pour ne pas saturer les I/O
      setImmediate(flushRoutes);
    }
  }).catch(() => {
    // Silence — le fallback Jaccard reste opérationnel
  });
}

/**
 * Cherche une route apprise correspondant à la commande.
 * Utilise cosine similarity sur les embeddings stockés si disponibles,
 * sinon fallback transparent sur Jaccard.
 *
 * Cette fonction est SYNCHRONE — les embeddings de la requête sont cherchés
 * dans le cache RAM. Pour des requêtes jamais vues, Jaccard est utilisé.
 *
 * @param {string} command
 * @param {number} threshold  — score minimum (défaut 0.72, compatible Jaccard et cosine)
 * @returns {{ steps, confidence, source: 'memory', originalCommand } | null}
 */
export function recall(command, threshold = 0.72) {
  const routes = loadRoutes();
  if (routes.length === 0) return null;

  // Embedding de la requête en cours (depuis le cache RAM uniquement — synchrone)
  const norm = normalize(command);
  const queryEmbedding = _embeddingCache.get(norm) || _embeddingCache.get(command) || null;

  // Lance le calcul de l'embedding en arrière-plan pour les prochains appels
  if (!queryEmbedding) {
    embedText(norm).catch(() => {});
  }

  let best = null;
  let bestScore = 0;

  for (const route of routes) {
    // Utilise l'embedding stocké de la route si disponible
    const routeEmbedding = route.embedding || _embeddingCache.get(route.normalizedCommand || '') || null;

    const score = similarity(
      command,
      route.normalizedCommand || route.originalCommand || '',
      queryEmbedding,
      routeEmbedding
    );

    if (score > bestScore) {
      bestScore = score;
      best = route;
    }
  }

  if (!best || bestScore < threshold) return null;

  // Met à jour les hits
  best.hits = (best.hits || 0) + 1;
  best.lastUsed = new Date().toISOString();
  _dirty = true;
  // Flush différé (pas bloquant)
  setImmediate(flushRoutes);

  return {
    steps: best.steps,
    confidence: bestScore,
    source: 'memory',
    originalCommand: best.originalCommand,
  };
}

/**
 * Statistiques de la mémoire — pour /api/memory
 */
export function memoryStats() {
  const routes = loadRoutes();
  const sorted = [...routes].sort((a, b) => (b.hits || 0) - (a.hits || 0));
  return {
    totalRoutes: routes.length,
    topRoutes: sorted.slice(0, 10).map(r => ({
      command: (r.originalCommand || '').slice(0, 60),
      hits: r.hits || 0,
      skills: (r.steps || []).map(s => s.skill).join(' → '),
    })),
  };
}

// ─── Heuristiques Dream Cycle ─────────────────────────────────────────────────

// Chemin vers le fichier heuristiques
const HEURISTICS_FILE = join(ROOT, 'agent/memory/heuristics.jsonl');

// Cache en RAM avec TTL 60s
let _heuristicsCache = null;
let _heuristicsCacheAt = 0;
const HEURISTICS_TTL_MS = 60_000;

/**
 * Charge les heuristiques depuis le fichier JSONL.
 * Cache en RAM avec TTL 60s.
 * @returns {Array<{when: string, then: string, confidence: number}>}
 */
function loadHeuristics() {
  const now = Date.now();
  if (_heuristicsCache && (now - _heuristicsCacheAt) < HEURISTICS_TTL_MS) {
    return _heuristicsCache;
  }

  try {
    if (!existsSync(HEURISTICS_FILE)) {
      _heuristicsCache = [];
      _heuristicsCacheAt = now;
      return _heuristicsCache;
    }

    const lines = readFileSync(HEURISTICS_FILE, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);

    _heuristicsCache = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    _heuristicsCacheAt = now;
  } catch {
    _heuristicsCache = [];
    _heuristicsCacheAt = now;
  }

  return _heuristicsCache;
}

/**
 * Normalise un texte pour le matching heuristique :
 * lowercase + retire accents + retire ponctuation.
 * @param {string} text
 * @returns {string}
 */
function normalizeForHeuristic(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[àáâãä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o').replace(/[ùûü]/g, 'u')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cherche une heuristique correspondant à la commande.
 * Matching simple : mots-clés du champ "when" présents dans command (normalisé).
 * Retourne la meilleure heuristique ou null.
 *
 * @param {string} command
 * @returns {{ when: string, then: string, confidence: number } | null}
 */
export function getHeuristicHint(command) {
  if (!command) return null;

  const heuristics = loadHeuristics();
  if (heuristics.length === 0) return null;

  const normalizedCommand = normalizeForHeuristic(command);

  let bestHeuristic = null;
  let bestScore = 0;

  for (const h of heuristics) {
    if (!h.when || !h.then || typeof h.confidence !== 'number') continue;

    // Extrait les mots-clés du champ "when" (>3 chars)
    const whenNorm = normalizeForHeuristic(h.when);
    const keywords = whenNorm.split(' ').filter(w => w.length > 3);

    if (keywords.length === 0) continue;

    // Compte combien de mots-clés sont présents dans la commande normalisée
    const found = keywords.filter(kw => normalizedCommand.includes(kw)).length;

    // Score = (mots_trouvés / total_mots_when) * confidence
    const score = (found / keywords.length) * h.confidence;

    if (score > bestScore) {
      bestScore = score;
      bestHeuristic = h;
    }
  }

  // Retourne la meilleure si score > 0.5
  if (!bestHeuristic || bestScore <= 0.5) return null;

  return {
    when: bestHeuristic.when,
    then: bestHeuristic.then,
    confidence: bestHeuristic.confidence,
  };
}

/**
 * Supprime une route (pour les corrections manuelles)
 */
export function forget(command) {
  const routes = loadRoutes();
  const idx = routes.findIndex(r => similarity(r.normalizedCommand || '', command) >= 0.90);
  if (idx === -1) return false;
  routes.splice(idx, 1);
  _dirty = true;
  flushRoutes();
  return true;
}
