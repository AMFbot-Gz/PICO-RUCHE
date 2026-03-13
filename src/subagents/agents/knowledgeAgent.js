/**
 * src/subagents/agents/knowledgeAgent.js — Configuration + run() du KnowledgeAgent
 *
 * Spécialisé en gestion de la connaissance.
 * Interroge et enrichit la base de connaissances de LaRuche.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Racine du projet : src/subagents/agents/ → ../../.. = ROOT
const ROOT = resolve(__dirname, "../../..");

const BRAIN_URL = process.env.BRAIN_URL || "http://localhost:8003";

/**
 * Charge les heuristiques depuis agent/memory/heuristics.jsonl.
 * Filtre les lignes dont les mots-clés correspondent au contexte/command.
 * @param {string} query
 * @returns {string} heuristiques pertinentes formatées, ou chaîne vide
 */
function loadRelevantHeuristics(query) {
  const hPath = resolve(ROOT, "agent/memory/heuristics.jsonl");
  try {
    const lines = readFileSync(hPath, "utf8").split("\n").filter(Boolean);
    const queryLower = query.toLowerCase();
    const relevant = lines
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((h) => {
        if (!h) return false;
        // Recherche par mots-clés dans les champs textuels de l'heuristique
        const text = JSON.stringify(h).toLowerCase();
        return queryLower.split(" ").some((word) => word.length > 3 && text.includes(word));
      });
    if (relevant.length === 0) return "";
    return "## Heuristiques pertinentes\n" +
      relevant.slice(0, 5).map((h) => `- ${JSON.stringify(h)}`).join("\n");
  } catch {
    return "";
  }
}

/**
 * Charge le contexte long terme depuis agent/memory/persistent.md.
 * @returns {string} contenu tronqué à 2000 chars, ou chaîne vide
 */
function loadPersistentContext() {
  const pPath = resolve(ROOT, "agent/memory/persistent.md");
  try {
    const content = readFileSync(pPath, "utf8");
    return "## Contexte persistant\n" + content.slice(0, 2000);
  } catch {
    return "";
  }
}

export const knowledgeAgentConfig = {
  id: "knowledge_agent",
  name: "KnowledgeAgent",
  icon: "🧠",
  color: "#8b5cf6",
  description: "Gestion et interrogation de la base de connaissances locale, mémoire, docs",
  model: "llama3:latest",
  allowedSkills: [
    "read_file",
    "http_fetch",
    "summarize_project",
    "accessibility_reader",
  ],
  allowedMCPs: [
    "vault_mcp.js",
    "vision_mcp.js",
    "skill_factory_mcp.js",
  ],
  systemPrompt: `Tu es KnowledgeAgent, spécialisé en gestion de la connaissance.
Tu interroges et enrichis la base de connaissances de LaRuche.
Tu peux lire des fichiers, analyser des documents, résumer des projets.
Tu maintiens la mémoire à jour et indexée.
Réponds en français. Sois exhaustif dans l'analyse.`,
  capabilities: [
    "knowledge_query",
    "memory_update",
    "doc_analysis",
    "skill_catalog",
  ],
  maxConcurrent: 1,
  timeout: 180_000,
};

/**
 * Exécute une tâche de connaissance via Brain :8003/raw.
 * Enrichit automatiquement le contexte avec les heuristiques et la mémoire persistante.
 *
 * @param {{ command: string, context?: string }} task
 * @returns {Promise<{ success: boolean, result: string, model: string, duration_ms: number }>}
 */
export async function run(task) {
  const start = Date.now();
  const { command, context = "" } = task;

  // Charger les heuristiques pertinentes (filtrées par mots-clés)
  const heuristics = loadRelevantHeuristics(command + " " + context);

  // Charger le contexte long terme persistent.md
  const persistentCtx = loadPersistentContext();

  // Construire le prompt utilisateur enrichi
  const enrichedParts = [command];
  if (context) enrichedParts.push(`\n## Contexte fourni\n${context}`);
  if (persistentCtx) enrichedParts.push(`\n${persistentCtx}`);
  if (heuristics) enrichedParts.push(`\n${heuristics}`);
  const userPrompt = enrichedParts.join("\n");

  try {
    const response = await fetch(`${BRAIN_URL}/raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "worker",
        system: knowledgeAgentConfig.systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(knowledgeAgentConfig.timeout - 2000),
    });

    if (!response.ok) {
      throw new Error(`Brain /raw répondu HTTP ${response.status}`);
    }

    const data = await response.json();
    // Brain retourne { response: string, model: string, ... }
    const result = data?.response ?? data?.content ?? JSON.stringify(data);
    const model = data?.model ?? knowledgeAgentConfig.model;

    return {
      success: true,
      result,
      model,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      result: `Erreur KnowledgeAgent : ${err.message}`,
      model: knowledgeAgentConfig.model,
      duration_ms: Date.now() - start,
    };
  }
}
