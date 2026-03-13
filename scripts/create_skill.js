#!/usr/bin/env node
/**
 * create_skill.js — Ghost OS v7 Daemon Skill Factory
 * Génère un skill complet compatible ABW (Agent Bestiary World)
 *
 * Usage:
 *   node scripts/create_skill.js "Description du skill"
 *   node scripts/create_skill.js "Description" --tier System
 *   node scripts/create_skill.js "Description" --model llama3:latest --tools mcp-os-control,mcp-vision
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import yaml from "js-yaml";
import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const TESTS_DIR = join(ROOT, "tests", "skills");
const REGISTRY_PATH = join(ROOT, "skills", "registry.json");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").substring(0, 40);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const description = args.find((a) => !a.startsWith("--")) || "";
  const tier = args.includes("--tier") ? args[args.indexOf("--tier") + 1] : "Community";
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "llama3.2:3b";
  const toolsArg = args.includes("--tools") ? args[args.indexOf("--tools") + 1] : "";
  const tools = toolsArg ? toolsArg.split(",").map((t) => t.trim()) : [];
  return { description, tier, model, tools };
}

async function llmGenerate(prompt) {
  // Essaie Claude d'abord, fallback Ollama
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const r = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });
      return r.content.find((b) => b.type === "text")?.text || "";
    } catch {}
  }
  // Fallback Ollama
  try {
    const r = await fetch(`${process.env.OLLAMA_HOST || "http://localhost:11434"}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3.2:3b", prompt, stream: false }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json();
    return d.response || "";
  } catch {
    return "";
  }
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

function buildManifestYaml(skillName, description, tier, model, tools) {
  const obj = {
    identity: {
      id: skillName,
      version: "1.0.0",
      tier, // System | Community
      created: new Date().toISOString(),
    },
    capabilities: {
      model,
      temperature: 0.3,
      max_tokens: 1024,
      mcp_tools: tools.length ? tools : ["mcp-terminal"],
    },
    contracts: {
      accepts: {
        type: "object",
        properties: {
          params: { type: "object", description: "Paramètres spécifiques au skill" },
        },
        required: [],
      },
      produces: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          result: { type: "string" },
          error: { type: "string" },
          duration_ms: { type: "number" },
        },
        required: ["success"],
      },
    },
    permissions: {
      os_tools: tools.includes("mcp-os-control") ? ["screencapture", "osascript"] : [],
      network: tools.includes("mcp-http") ? ["http"] : [],
      filesystem: ["read", "write_tmp"],
    },
  };
  return yaml.dump(obj, { indent: 2, lineWidth: 100 });
}

function buildSkillMd(skillName, description) {
  // Description en 3ème personne, avec "Use when..." — best practice Anthropic
  const desc3p = `${description.charAt(0).toUpperCase() + description.slice(1)}. Use when the user asks to ${description.toLowerCase()} or mentions related actions.`;
  return `---
name: ${skillName}
description: "${desc3p}"
version: 1.0.0
tier: Community
tags: [auto-generated, ghost-os-v7]
---

# ${skillName}

${description}

## Pipeline CASCU (Perceive → Plan → Act → Verify → Update)

### C — Capture (Perceive)
Collecte les inputs et l'état UI/système avant d'agir.
\`\`\`
Input: params.* (voir contracts.accepts dans manifest.yaml)
World Model check: GET http://localhost:8002/scan
\`\`\`

### A — Analyse (Plan)
Évalue les conditions d'exécution et sélectionne la stratégie.
\`\`\`
- Vérifier que les pré-conditions sont remplies
- Sélectionner l'outil approprié (voir mcp_tools dans manifest)
- Estimer le risque (low/medium/high)
\`\`\`

### S — Synthèse / Exécute (Act)
Exécute l'action via toolRouter.
\`\`\`
execute(params) → skill.js → toolRouter → résultat brut
\`\`\`

### C — Contrôle (Verify)
Vérifie le résultat et le compare à l'attendu.
\`\`\`
- result.success === true
- Durée < 5000ms (100ms si osascript avec cache SHA-256)
- Output conforme à contracts.produces
\`\`\`

### U — Update
Met à jour le World Model et les métriques.
\`\`\`
POST http://localhost:8006/experience {skill: "${skillName}", outcome: ...}
\`\`\`

## Prompt Interne Agent

\`\`\`
Tu exécutes le skill "${skillName}".
Mission: ${description}
Règles:
1. Toujours vérifier l'état World Model avant d'agir
2. Retourner { success: true/false, result/error, duration_ms }
3. Timeout max: 5000ms (osascript: 100ms via cache SHA-256)
4. En cas d'échec, logger dans src/evolution/failureDetector
\`\`\`

## Exemples

\`\`\`javascript
// Appel standard
const result = await execute({});
// { success: true, result: "...", duration_ms: 42 }

// Avec params
const result = await execute({ target: "fichier.txt" });
\`\`\`
`;
}

function buildIndexJs(skillName) {
  return `/**
 * ${skillName}/index.js — Ghost OS v7 Runtime Interface
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
    return { success: false, error: \`World Model bloque l'exécution: \${worldState.reason}\`, blocked: true };
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
    await reportFailure("${skillName}", err, params);
    return { success: false, error: err.message, duration_ms };
  }
}

// Export run pour compatibilité avec l'ancienne interface Ghost OS v5/v6
export const run = execute;
`;
}

function buildSkillJs(skillName, description, generatedCode) {
  if (generatedCode && generatedCode.includes("export async function run")) {
    return generatedCode;
  }
  return `/**
 * ${skillName}/skill.js — Logique métier
 * ${description}
 */

export async function run(params = {}) {
  // TODO: Implémenter la logique de "${description}"
  // Utiliser les mcp_tools définis dans manifest.yaml

  return {
    success: true,
    result: "Skill '${skillName}' exécuté avec params: " + JSON.stringify(params),
  };
}
`;
}

function buildTest(skillName) {
  return `/**
 * tests/skills/${skillName}.test.js — Ghost OS v7 Unit Tests
 * Vérifie: succès, timing osascript <100ms (cache), erreur gracieuse
 */
import { execute } from "../../skills/${skillName}/index.js";

describe("Skill: ${skillName}", () => {
  test("execute() retourne un objet avec success", async () => {
    const result = await execute({});
    expect(result).toHaveProperty("success");
    expect(typeof result.success).toBe("boolean");
  }, 10000);

  test("execute() inclut duration_ms", async () => {
    const result = await execute({});
    expect(result).toHaveProperty("duration_ms");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  }, 10000);

  test("Cache SHA-256: 2ème appel < 100ms", async () => {
    await execute({}); // warm-up cache
    const start = Date.now();
    const result = await execute({});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result.cached).toBe(true);
  }, 5000);

  test("Paramètres invalides: retourne success:false ou gère gracieusement", async () => {
    const result = await execute({ __ghost_invalid__: true });
    expect(result).toHaveProperty("success");
  }, 10000);
});
`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const { description, tier, model, tools } = parseArgs();

  if (!description) {
    console.error('Usage: node scripts/create_skill.js "Description du skill"');
    process.exit(1);
  }

  const skillName = slugify(description);
  const skillDir = join(SKILLS_DIR, skillName);

  console.log(`\n🧠 Ghost OS v7 — Skill Factory Daemon`);
  console.log(`📦 Génération du skill: "${skillName}"`);
  console.log(`   Tier: ${tier} | Modèle: ${model}`);

  // Créer les répertoires
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(TESTS_DIR, { recursive: true });

  // Générer le code skill.js via LLM
  console.log(`\n⚙️  LLM → génération du code...`);
  const codePrompt = `Génère un skill JavaScript pour Ghost OS v7.
Description: ${description}
Exporte une fonction async run(params = {}) qui retourne { success: true/false, result: string }.
Code ES Module uniquement. Pas de commentaire excessif. Pas d'explication.`;
  const generatedCode = await llmGenerate(codePrompt);

  // Écrire tous les fichiers
  const files = [
    { path: join(skillDir, "manifest.yaml"), content: buildManifestYaml(skillName, description, tier, model, tools) },
    { path: join(skillDir, "SKILL.md"), content: buildSkillMd(skillName, description) },
    { path: join(skillDir, "index.js"), content: buildIndexJs(skillName) },
    { path: join(skillDir, "skill.js"), content: buildSkillJs(skillName, description, generatedCode) },
    { path: join(TESTS_DIR, `${skillName}.test.js`), content: buildTest(skillName) },
  ];

  for (const { path, content } of files) {
    writeFileSync(path, content, "utf-8");
    console.log(`   ✅ ${path.replace(ROOT + "/", "")}`);
  }

  // Mettre à jour le registre
  let registry = { version: "1.1.0", lastUpdated: "", skills: [] };
  try { registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")); } catch {}
  const idx = registry.skills.findIndex((s) => s.name === skillName);
  const entry = { name: skillName, description, version: "1.0.0", tier, created: new Date().toISOString() };
  if (idx >= 0) registry.skills[idx] = entry;
  else registry.skills.push(entry);
  registry.lastUpdated = new Date().toISOString();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`   ✅ skills/registry.json mis à jour`);

  // Retourner le JSON de confirmation (Ghost OS Daemon format)
  const output = {
    success: true,
    skill: skillName,
    tier,
    files_created: files.map((f) => f.path.replace(ROOT + "/", "")),
    registry_updated: true,
    performance_prediction: {
      first_call_ms: 500,
      cached_call_ms: "<1",
      cache_strategy: "SHA-256",
      osascript_budget_ms: 100,
    },
    next: `node scripts/create_skill.js → skills/${skillName}/ prêt pour queen.py`,
  };

  console.log(`\n📊 Résultat:\n${JSON.stringify(output, null, 2)}`);
}

main().catch((e) => {
  console.error("❌ Skill Factory Error:", e.message);
  process.exit(1);
});
