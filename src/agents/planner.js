/**
 * planner.js — LaRuche Intent Planner v3
 * Dynamic via skillLoader.js — fini les BUILTIN_SKILLS hardcodés
 */

import { callLLM } from "../llm/callLLM.js";
import { getAllSkills, getRelevantSkills, formatSkillsForPrompt } from "../skills/skillLoader.js";
import { routeByRules } from './intentRouter.js';
import { buildCompactContext } from '../context/agentIdentity.js';
import { recall, learn, getHeuristicHint } from '../learning/missionMemory.js';

// ─── Utilitaire : tronquer un texte à N tokens estimés ────────────────────────
// Estimation simple : 1 token ≈ 4 chars (anglais/code) — conservateur côté sécurité
const CHARS_PER_TOKEN = 4;

function truncateByTokens(text, maxTokens) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[tronqué à ${maxTokens} tokens]`;
}

// Budgets token pour le prompt planner (contexte total llama3.2:3b = 4096 tokens)
const PLANNER_MAX_TOKENS_SKILLS  = 800;   // liste des skills
const PLANNER_MAX_TOKENS_CTX     = 400;   // contexte agent
const PLANNER_MAX_TOKENS_INTENT  = 200;   // intention utilisateur

// ─── Prompt système planner ────────────────────────────────────────────────────────────
function buildPlannerPrompt(intent, skills) {
  const rawSkillList = formatSkillsForPrompt(skills);
  const rawCtx = buildCompactContext("worker");

  // Tronquer chaque bloc pour rester dans le contexte du LLM
  const skillList  = truncateByTokens(rawSkillList, PLANNER_MAX_TOKENS_SKILLS);
  const ctx        = truncateByTokens(rawCtx,       PLANNER_MAX_TOKENS_CTX);
  const intentSafe = truncateByTokens(intent,       PLANNER_MAX_TOKENS_INTENT);

  // Hint heuristique — priorité haute dans le prompt
  const hint = getHeuristicHint(intent);
  const hintLine = hint
    ? `\nHeuristique apprise (confiance ${hint.confidence}): QUAND "${hint.when}" → ALORS "${hint.then}"\n`
    : '';

  return `${ctx}${hintLine}
Skills disponibles: ${skillList}
Règles: JSON seul. Steps atomiques. Skills exacts de la liste. Valeurs par défaut si ambigu.
Pour le GUI: utiliser find_element/smart_click plutôt que des coordonnées.
Format: {"goal":"objectif","confidence":0.9,"steps":[{"skill":"nom","params":{}}]}
Intention: "${intentSafe}"
JSON:`;
}

// ─── Détection d'intention computer-use ──────────────────────────────────────────────
const COMPUTER_USE_PATTERNS = [
  /ouvre?\s+/i, /lance?\s+/i, /démarre?\s+/i, /ferme?\s+/i, /quitte?\s+/i,
  /mets?\s+(de\s+la\s+)?musique/i, /joue?\s+(de\s+la\s+)?musique/i, /play\s+(some\s+)?music/i,
  /mets?\s+(une\s+|la\s+)?playlist/i, /lance?\s+(une\s+|la\s+)?playlist/i,
  /mets?\s+(une\s+|la\s+)?vidéo/i, /mets?\s+(un\s+|le\s+)?son/i,
  /va\s+sur\s+/i, /ouvre?\s+(le\s+|un\s+|la\s+)?navigateur/i,
  /cherche?\s+.*(youtube|google|safari|chrome|web)/i, /recherche?\s+/i, /télécharge?\s+/i,
  /tape?\s+/i, /clique?\s+(sur\s+)?/i, /appuie?\s+(sur\s+)?/i, /glisse?\s+/i,
  /screenshot/i, /capture\s+d'écran/i, /prends?\s+(une\s+)?capture/i,
  /exécute?\s+/i, /lance?\s+(la\s+|le\s+|une\s+|un\s+)?commande/i, /installe?\s+/i,
  /ouvre?\s+(vs\s*code|vscode|terminal|finder|chrome|firefox|safari|spotify|slack|discord)/i,
  /crée?\s+(un\s+|le\s+|la\s+|une\s+)?projet/i, /copie?\s+/i, /déplace?\s+/i,
  /supprime?\s+/i, /renomme?\s+/i,
  /open\s+/i, /start\s+/i, /close\s+/i, /click\s+/i, /type\s+/i,
  /search\s+(on\s+)?(youtube|google)/i, /play\s+/i, /download\s+/i, /install\s+/i,
];

export function isComputerUseIntent(text) {
  return COMPUTER_USE_PATTERNS.some(p => p.test(text));
}

// ─── Fonction principale ───────────────────────────────────────────────────────────
export async function plan(intent, options = {}) {
  const { timeout = 20000 } = options;

  // 1. Routeur déterministe (zéro LLM, zéro erreur, instant)
  const routed = routeByRules(intent);
  if (routed.matched) {
    return { ...routed.plan, model: 'rules-engine' };
  }

  // 2. Mémoire apprise — plan déjà vu, retour immédiat sans LLM
  const memorized = recall(intent);
  if (memorized) {
    console.info(`[planner] Memory hit (${(memorized.confidence * 100).toFixed(0)}%) — "${memorized.originalCommand?.slice(0, 50)}"`);
    return {
      goal: intent,
      steps: memorized.steps,
      confidence: memorized.confidence,
      model: 'memory',
    };
  }

  // 3. Fallback LLM (lent) — 15 skills les plus pertinents
  const skills = getRelevantSkills(intent, 15);
  const prompt = buildPlannerPrompt(intent, skills);
  const role = "worker";  // llama3.2:3b — plus rapide, JSON simple

  let result;
  try {
    result = await callLLM(prompt, { role, temperature: 0.1 });
  } catch (err) {
    return { goal: intent, confidence: 0, steps: [], error: err.message };
  }

  if (!result.text) {
    return { goal: intent, confidence: 0, steps: [], error: 'Réponse LLM vide' };
  }

  try {
    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Pas de JSON trouvé");
    const parsed = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(parsed.steps)) parsed.steps = [];
    if (!parsed.goal) parsed.goal = intent;
    if (typeof parsed.confidence !== "number") parsed.confidence = 0.8;

    // Valider contre le catalogue complet (pas seulement les 15 pertinents)
    const knownNames = new Set(getAllSkills().map(s => s.name));
    parsed.steps = parsed.steps.filter(s => {
      if (!knownNames.has(s.skill)) {
        console.warn(`[planner] Skill inconnu ignoré: ${s.skill}`);
        return false;
      }
      return true;
    });

    // Apprend ce plan pour la prochaine fois (async, non bloquant)
    if (parsed.steps.length > 0) {
      setImmediate(() => learn(intent, parsed.steps, true, 0, 'llm'));
    }

    return { ...parsed, model: result.model };
  } catch (e) {
    return {
      goal: intent, confidence: 0, steps: [],
      error: `Parse error: ${e.message}`,
      raw: result.text.slice(0, 200),
    };
  }
}
