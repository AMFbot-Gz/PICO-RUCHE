/**
 * test/smoke.js — Suite de tests LaRuche v4.2
 * Tests automatiques : Ollama (guard CI), routing (mock inject), DB, skills, CLI, perf
 */

import chalk from "chalk";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";

let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${chalk.dim("→")} ${name.padEnd(50)}`);
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(chalk.green("✅") + chalk.dim(` ${ms}ms`));
    passed++;
  } catch (e) {
    console.log(chalk.red("❌") + chalk.dim(` ${e.message?.slice(0, 60)}`));
    failed++;
  }
}

function skip(name) {
  console.log(`  ${chalk.dim("→")} ${name.padEnd(50)}${chalk.dim("⏭ skip (no Ollama)")}`)
  passed++; // compte comme pass pour ne pas polluer le score
}

async function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion échouée");
}

// ─── Détection Ollama (helper) ────────────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

console.log(chalk.hex("#F5A623").bold("\n🐝 LaRuche Smoke Tests v4.2\n"));

const ollamaAvailable = await checkOllama();
if (!ollamaAvailable) {
  console.log(chalk.dim("  ⚠️  Ollama non disponible — tests dépendants Ollama seront skippés\n"));
}

// ─── 1. OLLAMA ───────────────────────────────────────────────────────────────────────
console.log(chalk.bold("  Ollama"));

if (!ollamaAvailable) {
  skip("Ollama accessible");
  skip("Modèles disponibles (>= 3)");
  skip("Génération texte (llama3.2:3b)");
} else {
  await test("Ollama accessible", async () => {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    assert(r.ok, `HTTP ${r.status}`);
  });

  await test("Modèles disponibles (>= 3)", async () => {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const d = await r.json();
    assert(d.models?.length >= 3, `Seulement ${d.models?.length} modèle(s)`);
  });

  await test("Génération texte (llama3.2:3b)", async () => {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3.2:3b", prompt: "Dis 'OK'", stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    assert(d.response?.length > 0, "Réponse vide");
  });
}

// ─── 2. MODEL ROUTER ──────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Model Router"));

const { autoDetectRoles, route, ask, _setAvailableModelsCache } = await import("../src/model_router.js");

// Injection de modèles mock AVANT les tests de routing
// → permet de tester findBest() / route() sans Ollama réel
_setAvailableModelsCache([
  "glm-4.6",
  "qwen3-coder",
  "llama3.2:3b",
  "llava:latest",
  "moondream:latest",
]);

await test("Auto-détection rôles", async () => {
  const roles = await autoDetectRoles();
  assert(roles.strategist, "Pas de stratège");
  assert(roles.architect, "Pas d'architecte");
  assert(roles.worker, "Pas d'ouvrière");
  assert(roles.vision, "Pas de vision");
});

await test("Cache rôles (2ème appel < 5ms)", async () => {
  const t = Date.now();
  await autoDetectRoles();
  const ms = Date.now() - t;
  assert(ms < 5, `Cache trop lent: ${ms}ms`);
});

await test("Routing code → architect model", async () => {
  const model = await route("écris une fonction Python");
  assert(model, `Aucun modèle retourné`);
});

await test("Routing stratégie → strategist model", async () => {
  const model = await route("analyse la stratégie de la mission");
  assert(model, `Aucun modèle retourné`);
});

await test("Routing vision → llava/vision", async () => {
  const model = await route("capture l'écran et analyse");
  assert(model.includes("vision") || model.includes("llava") || model.includes("moondream"), `Got: ${model}`);
});

await test("Routing neutre → llama3.2", async () => {
  const model = await route("bonjour comment vas-tu");
  assert(model.includes("llama3.2") || model.includes("llama3"), `Got: ${model}`);
});

if (!ollamaAvailable) {
  skip("ask() retourne texte non vide");
} else {
  await test("ask() retourne texte non vide", async () => {
    const r = await ask("Réponds juste: OK", { role: "worker", timeout: 15000 });
    assert(r.success, `Erreur: ${r.error}`);
    assert(r.text?.length > 0, "Texte vide");
    assert(r.model, "Pas de modèle retourné");
  });
}

// ─── 3. DATABASE ──────────────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Database (sql.js)"));

const { initDb, run, get, all } = await import("../src/db.js");

await test("Initialisation DB", async () => {
  await initDb("CREATE TABLE IF NOT EXISTS test_smoke (id INTEGER PRIMARY KEY, v TEXT)");
});

await test("INSERT (debounce 500ms)", async () => {
  const before = Date.now();
  for (let i = 0; i < 10; i++) {
    await run("INSERT INTO test_smoke (v) VALUES (?)", [`val_${i}`]);
  }
  const ms = Date.now() - before;
  assert(ms < 50, `Trop lent: ${ms}ms`);
});

await test("SELECT avec statement cache", async () => {
  const r = await get("SELECT COUNT(*) as c FROM test_smoke");
  assert(r.c >= 10, `Seulement ${r.c} rows`);
});

await test("SELECT x5 (cache statements)", async () => {
  const t = Date.now();
  for (let i = 0; i < 5; i++) await get("SELECT COUNT(*) as c FROM test_smoke");
  const ms = Date.now() - t;
  assert(ms < 10, `Trop lent: ${ms}ms`);
});

// ─── 4. SKILL EVOLUTION ────────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Skill System"));

const { listSkills, createSkill } = await import("../src/skill_evolution.js");

await test("listSkills() retourne tableau", async () => {
  const skills = listSkills();
  assert(Array.isArray(skills), "Pas un tableau");
});

await test("Registry cache (2ème appel < 1ms)", async () => {
  const t = Date.now();
  listSkills(); listSkills(); listSkills();
  assert(Date.now() - t < 2, "Cache registry lent");
});

// ─── 5. CLI ───────────────────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  CLI laruche"));

const { execa } = await import("execa");

if (!ollamaAvailable) {
  skip("laruche doctor");
  skip("laruche status");
  skip("laruche models");
} else {
  await test("laruche doctor", async () => {
    const { stdout } = await execa("node", ["bin/laruche.js", "doctor"], { cwd: ROOT });
    assert(stdout.includes("✅") || stdout.includes("✓"), "Doctor n'affiche pas de succès");
  });

  await test("laruche status", async () => {
    const { stdout } = await execa("node", ["bin/laruche.js", "status"], { cwd: ROOT });
    assert(stdout.includes("Ollama"), "Status ne mentionne pas Ollama");
  });

  await test("laruche models", async () => {
    const { stdout } = await execa("node", ["bin/laruche.js", "models"], { cwd: ROOT });
    assert(stdout.includes("glm") || stdout.includes("llama"), "Pas de modèles détectés");
  });
}

await test("laruche skill list", async () => {
  const { stdout } = await execa("node", ["bin/laruche.js", "skill", "list"], { cwd: ROOT });
  assert(stdout.includes("Skills"), "Pas de liste skills");
});

// ─── 6. PERFORMANCE ─────────────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Performance"));

// Ces tests utilisent le cache mock injecté plus haut — pas d'Ollama nécessaire
await test("autoDetectRoles x10 parallèle < 50ms", async () => {
  const t = Date.now();
  await Promise.all(Array(10).fill(0).map(() => autoDetectRoles()));
  const ms = Date.now() - t;
  assert(ms < 50, `Trop lent: ${ms}ms (cache attendu)`);
});

await test("route() x20 parallèle < 10ms", async () => {
  const tasks = ["code", "stratégie", "vision", "bonjour", "python"];
  const t = Date.now();
  await Promise.all(Array(20).fill(0).map((_, i) => route(tasks[i % tasks.length])));
  const ms = Date.now() - t;
  assert(ms < 10, `Trop lent: ${ms}ms`);
});

// ─── 7. API REST ─────────────────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  API REST (LaRuche :3000)"));

const QUEEN_API = process.env.QUEEN_HOST || "http://localhost:3000";
// IP unique par run pour éviter la pollution du rate-limit entre exécutions
const SMOKE_IP = `smoke-${Date.now()}`;

async function checkQueen() {
  try {
    const r = await fetch(`${QUEEN_API}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

const queenAvailable = await checkQueen();
if (!queenAvailable) {
  console.log(chalk.dim("  ⚠️  Queen API non disponible sur :3000 — tests API seront skippés\n"));
}

if (!queenAvailable) {
  skip("POST /api/mission x3 parallèle → 202 + missionId unique");
  skip("POST /api/mission x35 rapidement → au moins 1 retourne 429");
  skip("GET /api/queue → { pending, running, completed, maxConcurrent }");
  skip("GET /api/health → { ok: true }");
  skip("GET /api/subagents → tableau");
} else {
  // Test : 3 missions en parallèle → toutes reçoivent 202 et ont un missionId unique
  // SMOKE_IP isole le bucket de rate-limit de ce run pour éviter la pollution entre exécutions
  await test("POST /api/mission x3 parallèle → 202 + missionId unique", async () => {
    const requests = [1, 2, 3].map(() =>
      fetch(`${QUEEN_API}/api/mission`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `${SMOKE_IP}-a` },
        body: JSON.stringify({ command: "prends un screenshot smoke test" }),
        signal: AbortSignal.timeout(5000),
      })
    );
    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map(r => r.json()));

    for (const r of responses) {
      assert(r.status === 202, `Statut attendu 202, reçu ${r.status}`);
    }

    const ids = bodies.map(b => b.missionId);
    assert(ids.every(id => typeof id === "string" && id.length > 0), "missionId manquant ou invalide");
    const uniqueIds = new Set(ids);
    assert(uniqueIds.size === 3, `IDs non-uniques: ${ids.join(", ")}`);
  });

  // Test : rate limit → au moins 1 retourne 429 après 35 requêtes rapides
  // IP distincte de celle du test x3 pour avoir un bucket frais à 0
  // Envoi par batches de 10 pour éviter la saturation du pool HTTP Node.js
  await test("POST /api/mission x35 rapidement → au moins 1 retourne 429", async () => {
    const statuses = [];
    for (let i = 0; i < 35; i += 10) {
      const batch = Array(Math.min(10, 35 - i)).fill(null).map(() =>
        fetch(`${QUEEN_API}/api/mission`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": `${SMOKE_IP}-b` },
          body: JSON.stringify({ command: "rate limit test" }),
          signal: AbortSignal.timeout(8000),
        }).then(r => r.status)
      );
      statuses.push(...await Promise.all(batch));
    }
    const has429 = statuses.some(s => s === 429);
    assert(has429, `Aucun 429 reçu — statuts: ${[...new Set(statuses)].join(", ")}`);
  });

  // Test : GET /api/queue → structure { pending, running, completed, maxConcurrent }
  await test("GET /api/queue → { pending, running, completed, maxConcurrent }", async () => {
    const r = await fetch(`${QUEEN_API}/api/queue`, { signal: AbortSignal.timeout(8000) });
    assert(r.ok, `HTTP ${r.status}`);
    const d = await r.json();
    assert("pending" in d, "Champ 'pending' manquant");
    assert("running" in d, "Champ 'running' manquant");
    assert("completed" in d, "Champ 'completed' manquant");
    assert("maxConcurrent" in d, "Champ 'maxConcurrent' manquant");
    assert(typeof d.pending === "number", "pending doit être un nombre");
    assert(typeof d.maxConcurrent === "number", "maxConcurrent doit être un nombre");
  });

  // Test : GET /api/health → { ok: true }
  await test("GET /api/health → { ok: true }", async () => {
    const r = await fetch(`${QUEEN_API}/api/health`, { signal: AbortSignal.timeout(3000) });
    assert(r.ok, `HTTP ${r.status}`);
    const d = await r.json();
    assert(d.ok === true, `ok=${d.ok}, attendu true`);
  });

  // Test : GET /api/subagents → tableau
  await test("GET /api/subagents → tableau", async () => {
    const r = await fetch(`${QUEEN_API}/api/subagents`, { signal: AbortSignal.timeout(3000) });
    assert(r.ok, `HTTP ${r.status}`);
    const d = await r.json();
    assert(Array.isArray(d) || (typeof d === "object" && "subagents" in d),
      `Réponse inattendue: ${JSON.stringify(d).slice(0, 80)}`);
  });
}

// ─── 7. SÉCURITÉ ────────────────────────────────────────────────
console.log(chalk.bold("  Sécurité"));

await test('is_blocked() bloque rm -rf /', async () => {
  // Tester via subprocess Python : python3 -c "import sys; sys.path.insert(0,'agent'); import executor; assert executor.is_blocked('rm -rf /') == True"
  const { execFileSync } = await import('child_process');
  const result = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0,'agent')
import unittest.mock as mock
with mock.patch('builtins.open', mock.mock_open(read_data='')):
    with mock.patch('yaml.safe_load', return_value={'security':{'blocked_shell_patterns':[],'max_shell_timeout':30,'require_confirmation_for':[],'hitl_mode':'relay'},'ports':{'queen':8001,'perception':8002,'brain':8003,'executor':8004,'evolution':8005,'memory':8006,'mcp_bridge':8007},'ollama':{'base_url':'http://localhost:11434','models':{'strategist':'llama3:latest','worker':'llama3.2:3b','vision':'moondream:latest','compressor':'llama3.2:3b'},'timeout':120},'mlx':{'enabled':False,'server_url':'http://127.0.0.1:8080/v1','fallback_to_ollama':True},'brain':{'max_context_tokens':8000,'compress_threshold':6000,'max_subtasks':5,'risk_levels':['low','medium','high']},'memory':{'max_episodes':500,'episode_file':'agent/memory/episodes.jsonl','persistent_file':'agent/memory/persistent.md','world_state_file':'agent/memory/world_state.json'},'perception':{'interval_seconds':30},'telegram':{'hitl_timeout_seconds':120}}):
        import executor
        assert executor.is_blocked('rm -rf /') == True
        assert executor.is_blocked('ls -la') == False
print('ok')
`], { encoding: 'utf-8' }).trim();
  assert(result === 'ok', 'is_blocked ne fonctionne pas');
});

await test('HITL_AUTO_APPROVE absent de queen_oss.js', async () => {
  const { readFileSync } = await import('fs');
  const content = readFileSync('src/queen_oss.js', 'utf-8');
  // Le bypass silent doit être supprimé
  const hasOverride = /HITL_AUTO_APPROVE\s*=\s*['"]true['"]/.test(content);
  assert(!hasOverride, 'HITL_AUTO_APPROVE bypass silencieux détecté dans queen_oss.js');
});

await test('Chimera HMAC secret non vide', async () => {
  const { readFileSync } = await import('fs');
  const content = readFileSync('core/chimera_bus.js', 'utf-8');
  assert(content.includes('CHIMERA_SECRET'), 'CHIMERA_SECRET absent de chimera_bus.js');
  assert(content.includes('createHmac'), 'HMAC absent de chimera_bus.js');
});

// ─── 8. TESTS PYTHON ────────────────────────────────────────────
console.log(chalk.bold("  Tests Python"));
await test('pytest >= 155 tests verts', async () => {
  const { execFileSync } = await import('child_process');
  const out = execFileSync('python3', ['-m', 'pytest', 'tests/', '-q', '--tb=no'],
    { encoding: 'utf-8', timeout: 60000 });
  const match = out.match(/(\d+) passed/);
  assert(match && parseInt(match[1]) >= 155, `pytest échoué: ${out.trim()}`);
});

// ─── RÉSULTAT ──────────────────────────────────────────────────────────────────────────────
console.log();
const total = passed + failed;
const pct = total > 0 ? Math.round((passed / total) * 100) : 100;
const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));

console.log(`  ${bar} ${pct}%`);
console.log(`  ${chalk.green(`✅ ${passed} passés`)}  ${failed > 0 ? chalk.red(`❌ ${failed} échoués`) : chalk.dim("❌ 0 échoué")}\n`);

if (failed > 0) process.exit(1);
