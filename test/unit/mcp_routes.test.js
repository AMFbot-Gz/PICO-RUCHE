/**
 * test/unit/mcp_routes.test.js — Tests unitaires routes MCP
 * Vérifie que chaque handler MCP répond correctement sans serveur HTTP réel.
 * Les imports dynamiques (robotjs, vision.py, chromadb) sont mockés via erreur gracieuse.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${chalk.dim("→")} ${name.padEnd(60)}`);
  try {
    await fn();
    console.log(chalk.green("✅"));
    passed++;
  } catch (e) {
    console.log(chalk.red("❌") + chalk.dim(` ${e.message?.slice(0, 80)}`));
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion échouée");
}

console.log(chalk.hex("#F5A623").bold("\n🐝 LaRuche — Tests MCP Routes\n"));

// ─── Import direct des handlers internes ─────────────────────────────────────
// On teste via un Hono app minimal (pas de server HTTP — juste app.fetch())
import { Hono } from "hono";
import { createMcpRoutes } from "../../src/api/mcp_routes.js";

const app = new Hono();
createMcpRoutes(app);

/** Simule un appel HTTP POST vers l'app Hono en mémoire */
async function postMcp(path, body) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  return { status: res.status, body: await res.json() };
}

async function getMcp(path) {
  const req = new Request(`http://localhost${path}`, { method: "GET" });
  const res = await app.fetch(req);
  return { status: res.status, body: await res.json() };
}

// ─── 1. GET /mcp/health ───────────────────────────────────────────────────────
console.log(chalk.bold("  Health"));

await test("GET /mcp/health → { ok: true, endpoints: [...] }", async () => {
  const { status, body } = await getMcp("/mcp/health");
  assert(status === 200, `HTTP ${status}`);
  assert(body.ok === true, `ok=${body.ok}`);
  assert(Array.isArray(body.endpoints), "endpoints doit être un tableau");
  assert(body.endpoints.length === 7, `Attendu 7 endpoints, reçu ${body.endpoints.length}`);
});

// ─── 2. Validation body ───────────────────────────────────────────────────────
console.log(chalk.bold("\n  Validation body"));

await test("POST /mcp/terminal sans body → 400", async () => {
  const req = new Request("http://localhost/mcp/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "invalide{",
  });
  const res = await app.fetch(req);
  assert(res.status === 400, `Attendu 400, reçu ${res.status}`);
});

await test("POST /mcp/janitor sans action → 400 + error message", async () => {
  const { status, body } = await postMcp("/mcp/janitor", { params: {} });
  assert(status === 400, `Attendu 400, reçu ${status}`);
  assert(body.error, "Champ error manquant");
  assert(body.success === false || body.error, "Réponse d'erreur invalide");
});

// ─── 3. Terminal ──────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Terminal"));

await test("terminal/listProcesses → success + processes[]", async () => {
  const { status, body } = await postMcp("/mcp/terminal", { action: "listProcesses", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `success=${body.success}, error=${body.error}`);
  assert(Array.isArray(body.processes), "processes doit être un tableau");
});

await test("terminal/execSafe 'pwd' → stdout non vide", async () => {
  const { status, body } = await postMcp("/mcp/terminal", {
    action: "execSafe",
    params: { command: "pwd" },
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(typeof body.stdout === "string" && body.stdout.length > 0, "stdout vide");
});

await test("terminal/execSafe commande dangereuse → blocked", async () => {
  const { status, body } = await postMcp("/mcp/terminal", {
    action: "execSafe",
    params: { command: "rm -rf /tmp/test" },
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait bloquer rm");
  assert(body.error?.includes("non autorisée") || body.code === "COMMAND_NOT_ALLOWED", `error: ${body.error}`);
});

await test("terminal/exec commande simple 'echo hello'", async () => {
  const { status, body } = await postMcp("/mcp/terminal", {
    action: "exec",
    params: { command: "echo hello" },
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(body.stdout?.trim() === "hello", `stdout: "${body.stdout}"`);
});

await test("terminal/exec commande dangereuse → bloquée", async () => {
  const { status, body } = await postMcp("/mcp/terminal", {
    action: "exec",
    params: { command: "shutdown -h now" },
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "shutdown doit être bloqué");
});

await test("terminal/unknownAction → UNKNOWN_ACTION", async () => {
  const { status, body } = await postMcp("/mcp/terminal", {
    action: "unknownThing",
    params: {},
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, `success=${body.success}`);
  assert(body.code === "UNKNOWN_ACTION", `code=${body.code}`);
});

// ─── 4. Janitor ───────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Janitor"));

await test("janitor/getStats → heap_mb, rss_mb, temp_files", async () => {
  const { status, body } = await postMcp("/mcp/janitor", { action: "getStats", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(body.heap_mb !== undefined, "heap_mb manquant");
  assert(body.rss_mb !== undefined, "rss_mb manquant");
  assert(typeof body.temp_files === "number", "temp_files doit être un nombre");
});

await test("janitor/gcRAM → freed_mb string", async () => {
  const { status, body } = await postMcp("/mcp/janitor", { action: "gcRAM", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(body.freed_mb !== undefined, "freed_mb manquant");
});

await test("janitor/purgeTemp → success + purged count", async () => {
  const { status, body } = await postMcp("/mcp/janitor", { action: "purgeTemp", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(typeof body.purged === "number", `purged=${body.purged}`);
});

await test("janitor/rotateLogs → success + rotated count", async () => {
  const { status, body } = await postMcp("/mcp/janitor", { action: "rotateLogs", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(typeof body.rotated === "number", `rotated=${body.rotated}`);
});

// ─── 5. Rollback ──────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Rollback"));

await test("rollback/listSnapshots → success + snapshots[]", async () => {
  const { status, body } = await postMcp("/mcp/rollback", { action: "listSnapshots", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === true, `error: ${body.error}`);
  assert(Array.isArray(body.snapshots), "snapshots doit être un tableau");
});

await test("rollback/restore sans snapshotId → error", async () => {
  const { status, body } = await postMcp("/mcp/rollback", { action: "restore", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer sans snapshotId");
  assert(body.error, "error manquant");
});

await test("rollback/restore snapshotId inconnu → error", async () => {
  const { status, body } = await postMcp("/mcp/rollback", {
    action: "restore",
    params: { snapshotId: "snap-inexistant-99999" },
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer avec snapshot inconnu");
});

// ─── 6. Vault ────────────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Vault"));

await test("vault/getProfile → objet avec champs attendus", async () => {
  const { status, body } = await postMcp("/mcp/vault", { action: "getProfile", params: {} });
  assert(status === 200, `HTTP ${status}`);
  // Peut être un profil vide ou un profil existant — les deux sont valides
  assert(typeof body === "object" && body !== null, "Devrait retourner un objet");
});

await test("vault/findSimilar sans query → error", async () => {
  const { status, body } = await postMcp("/mcp/vault", { action: "findSimilar", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer sans query");
});

await test("vault/storeExperience sans task → error", async () => {
  const { status, body } = await postMcp("/mcp/vault", {
    action: "storeExperience",
    params: { result: "ok", success: true },
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer sans task");
});

await test("vault/unknownAction → UNKNOWN_ACTION", async () => {
  const { status, body } = await postMcp("/mcp/vault", { action: "nope", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, `success=${body.success}`);
  assert(body.code === "UNKNOWN_ACTION", `code=${body.code}`);
});

// ─── 7. Skill-Factory ────────────────────────────────────────────────────────
console.log(chalk.bold("\n  Skill-Factory"));

await test("skill-factory/listSkills → réponse 200 (success ou erreur gracieuse)", async () => {
  // db.js peut être absent en environnement de test — on vérifie juste que la route répond
  const { status, body } = await postMcp("/mcp/skill-factory", { action: "listSkills", params: {} });
  assert(status === 200, `HTTP ${status}`);
  // Soit succès avec tableau, soit erreur gracieuse (db.js absent) — les deux sont OK
  assert(typeof body.success === "boolean", "success doit être boolean");
  if (body.success) {
    assert(Array.isArray(body.skills), "skills doit être un tableau quand success=true");
  } else {
    assert(body.error, "error doit être présent quand success=false");
  }
});

await test("skill-factory/createSkill sans description → error", async () => {
  const { status, body } = await postMcp("/mcp/skill-factory", { action: "createSkill", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer sans description");
});

await test("skill-factory/evolveSkill sans params requis → error", async () => {
  const { status, body } = await postMcp("/mcp/skill-factory", {
    action: "evolveSkill",
    params: { skillName: "test_skill" }, // manque error
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer sans error");
});

// ─── 8. OS-Control (sans robot — HID optionnel) ────────────────────────────
console.log(chalk.bold("\n  OS-Control (sans HID)"));

await test("os-control/screenshot sans jimp → { success: false } ou succès", async () => {
  const { status, body } = await postMcp("/mcp/os-control", { action: "screenshot", params: {} });
  assert(status === 200, `HTTP ${status}`);
  // Soit HID absent (success: false avec message d'erreur), soit succès — les deux sont OK
  assert(typeof body.success === "boolean", "success doit être boolean");
});

await test("os-control/unknownAction → UNKNOWN_ACTION", async () => {
  const { status, body } = await postMcp("/mcp/os-control", { action: "unknownThing", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, `success=${body.success}`);
  assert(body.code === "UNKNOWN_ACTION", `code=${body.code}`);
});

await test("os-control/getPosition → réponse valide", async () => {
  const { status, body } = await postMcp("/mcp/os-control", { action: "getPosition", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(typeof body.success === "boolean", "success doit être boolean");
});

// ─── 9. Vision (sans Python — gracieux) ────────────────────────────────────
console.log(chalk.bold("\n  Vision (gracieux sans Python)"));

await test("vision/findElement sans description → error", async () => {
  const { status, body } = await postMcp("/mcp/vision", { action: "findElement", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, "Devrait échouer sans description");
});

await test("vision/unknownAction → UNKNOWN_ACTION", async () => {
  const { status, body } = await postMcp("/mcp/vision", { action: "nope", params: {} });
  assert(status === 200, `HTTP ${status}`);
  assert(body.success === false, `success=${body.success}`);
  assert(body.code === "UNKNOWN_ACTION", `code=${body.code}`);
});

// ─── Résultat ─────────────────────────────────────────────────────────────────
console.log();
const total = passed + failed;
const pct = total > 0 ? Math.round((passed / total) * 100) : 100;
const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
console.log(`  ${bar} ${pct}%`);
console.log(`  ${chalk.green(`✅ ${passed} passés`)}  ${failed > 0 ? chalk.red(`❌ ${failed} échoués`) : chalk.dim("❌ 0 échoué")}\n`);

if (failed > 0) process.exit(1);
