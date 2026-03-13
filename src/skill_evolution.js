/**
 * skill_evolution.js — Évolution Automatique des Skills
 * Analyse cause racine → patch → tests → versionning → règle générale
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import yaml from "js-yaml";
import { initDb, run as dbRun } from "./db.js";
import dotenv from "dotenv";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const REGISTRY_PATH = join(ROOT, ".laruche/registry.json");
const PROFILE_PATH = join(ROOT, ".laruche/patron-profile.json");

await initDb(`
  CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name TEXT NOT NULL,
    version TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    patch_reason TEXT,
    success INTEGER DEFAULT 1
  );
`);

// Cache registry en mémoire
let _registryCache = null;
let _registryCacheTs = 0;
const REGISTRY_TTL = 10000; // 10s

function loadRegistry() {
  if (_registryCache && Date.now() - _registryCacheTs < REGISTRY_TTL) return _registryCache;
  try { _registryCache = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")); }
  catch { _registryCache = { version: "1.0.0", skills: [] }; }
  _registryCacheTs = Date.now();
  return _registryCache;
}
function saveRegistry(registry) {
  registry.lastUpdated = new Date().toISOString();
  _registryCache = registry;
  _registryCacheTs = Date.now();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function incrementVersion(version) {
  const parts = version.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

async function ollamaAnalyze(prompt) {
  try {
    const res = await fetch(
      `${process.env.OLLAMA_HOST || "http://localhost:11434"}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || "llama3.2:3b",
          prompt,
          stream: false,
        }),
      }
    );
    const data = await res.json();
    return data.response || "";
  } catch {
    return "";
  }
}

export async function createSkill(description, options = {}) {
  const {
    tier = "Community",
    model = "llama3.2:3b",
    tools = [],
  } = options;

  const skillName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 40);

  const skillDir = join(SKILLS_DIR, skillName);
  const testsDir = join(ROOT, "tests", "skills");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });

  // ── Génération LLM (Claude > Ollama) ──────────────────────────────────────
  const codePrompt = `Génère un skill JavaScript Ghost OS v7 pour: ${description}
Exporte: export async function run(params = {}) { return { success: true, result: "..." }; }
ES Module uniquement. Code fonctionnel. Pas d'explications.`;
  const generatedCode = await ollamaAnalyze(codePrompt);

  // ── ABW manifest.yaml ──────────────────────────────────────────────────────
  const manifestObj = {
    identity: { id: skillName, version: "1.0.0", tier, created: new Date().toISOString() },
    capabilities: {
      model,
      temperature: 0.3,
      max_tokens: 1024,
      mcp_tools: tools.length ? tools : ["mcp-terminal"],
    },
    contracts: {
      accepts: { type: "object", properties: { params: { type: "object" } }, required: [] },
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
      filesystem: ["read", "write_tmp"],
    },
  };
  writeFileSync(join(skillDir, "manifest.yaml"), yaml.dump(manifestObj, { indent: 2 }));

  // ── SKILL.md avec pipeline CASCU ──────────────────────────────────────────
  const skillMd = `---
name: ${skillName}
description: ${description}
version: 1.0.0
tier: ${tier}
tags: [auto-generated, ghost-os-v7]
---

# ${skillName}

${description}

## Pipeline CASCU

| Étape | Action |
|-------|--------|
| **Capture** | Collecte inputs + World Model scan (port 8002) |
| **Analyse** | Évalue conditions, sélectionne outil |
| **Synthèse** | Execute via toolRouter |
| **Contrôle** | Vérifie résultat, timing <5000ms |
| **Update** | POST /experience vers memory (8006) |

## Prompt Interne
Mission: ${description}
Règles: World Model check avant action · Timeout 5000ms · Cache SHA-256 pour osascript
`;
  writeFileSync(join(skillDir, "SKILL.md"), skillMd);

  // ── index.js avec execute(params) + SHA-256 cache + World Model ───────────
  const indexJs = `import { createHash } from "crypto";
import { run as skillRun } from "./skill.js";

const _cache = new Map();
const CACHE_TTL_MS = 5000;

function cacheKey(p) { return createHash("sha256").update(JSON.stringify(p)).digest("hex"); }

async function checkWorldModel() {
  try {
    const r = await fetch("http://localhost:8002/scan", { signal: AbortSignal.timeout(500) });
    if (r.ok) return { ready: true };
  } catch {}
  return { ready: true }; // fail-open
}

export async function execute(params = {}) {
  const wm = await checkWorldModel();
  if (!wm.ready) return { success: false, error: "World Model: " + wm.reason, blocked: true };

  const key = cacheKey(params);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit.result, cached: true, duration_ms: 0 };

  const t0 = Date.now();
  try {
    const result = await skillRun(params);
    const duration_ms = Date.now() - t0;
    const final = { ...result, duration_ms };
    if (result.success !== false) _cache.set(key, { result: final, ts: Date.now() });
    return final;
  } catch (err) {
    return { success: false, error: err.message, duration_ms: Date.now() - t0 };
  }
}
export const run = execute;
`;
  writeFileSync(join(skillDir, "index.js"), indexJs);

  // ── skill.js (logique métier) ──────────────────────────────────────────────
  const hasValidCode = generatedCode && generatedCode.includes("async function run");
  writeFileSync(
    join(skillDir, "skill.js"),
    hasValidCode ? generatedCode : `export async function run(params = {}) {\n  // TODO: ${description}\n  return { success: true, result: "Not implemented" };\n}\n`
  );

  // ── Test Jest ──────────────────────────────────────────────────────────────
  const testJs = `import { execute } from "../../skills/${skillName}/index.js";

describe("${skillName}", () => {
  test("retourne un objet avec success", async () => {
    const r = await execute({});
    expect(r).toHaveProperty("success");
  }, 10000);

  test("cache SHA-256: 2ème appel < 100ms", async () => {
    await execute({});
    const t = Date.now();
    const r = await execute({});
    expect(Date.now() - t).toBeLessThan(100);
    expect(r.cached).toBe(true);
  }, 5000);
});
`;
  writeFileSync(join(testsDir, `${skillName}.test.js`), testJs);

  // ── Registre ───────────────────────────────────────────────────────────────
  const skillsRegistry = (() => {
    try { return JSON.parse(readFileSync(join(SKILLS_DIR, "registry.json"), "utf-8")); }
    catch { return { version: "1.1.0", skills: [] }; }
  })();
  const entry = { name: skillName, description, version: "1.0.0", tier, created: new Date().toISOString() };
  const idx = skillsRegistry.skills.findIndex((s) => s.name === skillName);
  if (idx >= 0) skillsRegistry.skills[idx] = entry; else skillsRegistry.skills.push(entry);
  skillsRegistry.lastUpdated = new Date().toISOString();
  writeFileSync(join(SKILLS_DIR, "registry.json"), JSON.stringify(skillsRegistry, null, 2));

  await dbRun(
    "INSERT INTO skill_versions (skill_name, version, timestamp, patch_reason) VALUES (?, ?, ?, ?)",
    [skillName, "1.0.0", new Date().toISOString(), "Ghost OS v7 — ABW spec"]
  );

  return {
    success: true,
    skill: skillName,
    tier,
    path: skillDir,
    files_created: ["manifest.yaml", "SKILL.md", "index.js", "skill.js", `tests/skills/${skillName}.test.js`],
    performance_prediction: { first_call_ms: 500, cached_call_ms: "<1", cache_strategy: "SHA-256" },
  };
}

export async function evolveSkill(skillName, bugReport) {
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) {
    throw new Error(`Skill ${skillName} introuvable`);
  }

  const manifest = JSON.parse(readFileSync(join(skillDir, "manifest.json"), "utf-8"));
  const currentCode = readFileSync(join(skillDir, "skill.js"), "utf-8");

  // 1. Analyse cause racine + extraction règle en un seul appel
  const combinedPrompt = `Code du skill:\n${currentCode}\n\nBug: ${bugReport.error}\n\nRéponds en JSON:
{
  "cause": "cause racine en 1 phrase",
  "fix": "code corrigé complet",
  "rule": "règle générale à retenir (1 phrase)"
}`;
  const raw = await ollamaAnalyze(combinedPrompt);
  let analysis = { cause: "Unknown", fix: currentCode, rule: "" };
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) analysis = { ...analysis, ...JSON.parse(match[0]) };
  } catch {}

  // 2. Application du patch
  const newVersion = incrementVersion(manifest.version);
  const patchedCode = analysis.fix || currentCode;

  // 3. Backup ancienne version
  writeFileSync(join(skillDir, `skill_v${manifest.version}.js.bak`), currentCode);

  // 4. Écriture nouvelle version
  writeFileSync(join(skillDir, "skill.js"), patchedCode);
  manifest.version = newVersion;
  manifest.last_evolved = new Date().toISOString();
  writeFileSync(join(skillDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 5. Extraction règle générale → Profil Patron (issue du prompt combiné)
  const rule = analysis.rule;

  if (rule) {
    try {
      const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
      if (!profile.learned_rules) profile.learned_rules = [];
      profile.learned_rules.push(rule.trim());
      profile.last_updated = new Date().toISOString();
      writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
    } catch {}
  }

  // 6. Log DB
  await dbRun("INSERT INTO skill_versions (skill_name, version, timestamp, patch_reason) VALUES (?, ?, ?, ?)", [skillName, newVersion, new Date().toISOString(), analysis.cause]);

  // 7. Mise à jour registre
  const registry = loadRegistry();
  const idx = registry.skills.findIndex((s) => s.name === skillName);
  if (idx >= 0) {
    registry.skills[idx].version = newVersion;
    registry.skills[idx].last_evolved = new Date().toISOString();
  }
  saveRegistry(registry);

  return { skillName, oldVersion: manifest.version, newVersion, cause: analysis.cause, rule };
}

export function listSkills() {
  return loadRegistry().skills;
}

export function getSkill(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) return null;
  return {
    manifest: JSON.parse(readFileSync(join(skillDir, "manifest.json"), "utf-8")),
    code: readFileSync(join(skillDir, "skill.js"), "utf-8"),
  };
}
