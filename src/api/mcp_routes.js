/**
 * src/api/mcp_routes.js — Routes MCP REST pour LaRuche v4.1
 *
 * Monte les 8 endpoints MCP sur l'app Hono :
 *   POST /mcp/os-control    — HID souris/clavier/screenshot (os_control_mcp)
 *   POST /mcp/terminal      — exec, execSafe, listProcesses (terminal_mcp)
 *   POST /mcp/vision        — analyzeScreen, findElement, watchChange (vision_mcp)
 *   POST /mcp/vault         — storeExperience, findSimilar, getProfile (vault_mcp)
 *   POST /mcp/rollback      — createSnapshot, listSnapshots, restore (rollback_mcp)
 *   POST /mcp/skill-factory — createSkill, evolveSkill, listSkills (skill_factory_mcp)
 *   POST /mcp/janitor       — purgeTemp, rotateLogs, gcRAM (janitor_mcp)
 *   POST /mcp/pencil        — contrôle Pencil.app via AppleScript (pencil_mcp)
 *
 * Chaque route reçoit { tool, action, params } et dispatche vers la logique du
 * MCP server correspondant. Les MCP servers Node.js utilisent stdio — on
 * réimplémente ici les mêmes handlers directement (pas de spawn stdio à chaque appel).
 *
 * Format de réponse uniforme :
 *   succès : { success: true, ...data }
 *   erreur  : { success: false, error: string, code?: string }
 */

import { join, dirname, resolve, normalize } from "path";
import { fileURLToPath } from "url";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "fs";
import { execa } from "execa";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/** Extrait le payload { tool, action, params } d'une requête Hono. */
async function parseBody(c) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Retourne une réponse d'erreur normalisée. */
function mcpError(c, msg, status = 400, code = undefined) {
  return c.json({ success: false, error: msg, ...(code ? { code } : {}) }, status);
}

// ─── OS-CONTROL ───────────────────────────────────────────────────────────────

const SCREENSHOTS_DIR = join(ROOT, ".laruche/temp/screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Calibration partagée pour la session
let _calibration = { width: 1920, height: 1080, dpiScale: 1.0 };

// FIX 5 — Robotjs initialisé eagerly au démarrage (évite race condition lazy singleton)
let _robot = null;
let _robotLoading = false;
let _robotReady = false;

// IIFE : démarre l'initialisation immédiatement au chargement du module
(async () => {
  _robotLoading = true;
  try {
    const mod = await import("@jitsi/robotjs");
    _robot = mod.default || mod;
    _robotReady = true;
  } catch {
    _robotReady = false;
  } finally {
    _robotLoading = false;
  }
})();

async function getRobot() {
  // Attendre que l'initialisation soit terminée avant de retourner
  while (_robotLoading) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return _robot;
}

// Jimp (lazy) pour encode PNG
let _Jimp = null;
async function getJimp() {
  if (_Jimp === null) {
    try {
      const mod = await import("jimp");
      _Jimp = mod.Jimp || mod.default || false;
    } catch {
      _Jimp = false;
    }
  }
  return _Jimp || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gaussian = (mean = 0, std = 1) => {
  const u = 1 - Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};
const toAbs = (relX, relY) => ({
  x: Math.round((relX / 100) * _calibration.width / _calibration.dpiScale),
  y: Math.round((relY / 100) * _calibration.height / _calibration.dpiScale),
});

/**
 * Actions os-control disponibles :
 *   calibrate, moveMouse, click, typeText, scroll, screenshot, getPosition, keyPress
 */
async function handleOsControl(action, params = {}) {
  const robot = await getRobot();

  switch (action) {
    case "calibrate": {
      if (!robot) return { success: false, error: "HID non disponible (@jitsi/robotjs absent)" };
      const screen = robot.getScreenSize();
      _calibration = {
        width: screen.width,
        height: screen.height,
        dpiScale: screen.width > 2560 ? 2.0 : 1.0,
      };
      return { success: true, resolution: `${screen.width}x${screen.height}`, dpiScale: _calibration.dpiScale };
    }

    case "moveMouse": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const { relX = 50, relY = 50, ms: duration = 300 } = params;
      const { x, y } = toAbs(relX, relY);
      const steps = Math.round(duration / 8);
      const start = robot.getMousePos();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        robot.moveMouse(
          Math.round(start.x + (x - start.x) * ease + gaussian(0, 0.8)),
          Math.round(start.y + (y - start.y) * ease + gaussian(0, 0.8))
        );
        await sleep(8);
      }
      return { success: true, x, y };
    }

    case "click": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const { relX = 50, relY = 50, button = "left", double = false } = params;
      const { x, y } = toAbs(relX, relY);
      robot.moveMouse(x, y);
      await sleep(50);
      robot.mouseClick(button, double);
      return { success: true, x, y, button, double };
    }

    case "typeText": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const { text = "", wpm = 65 } = params;
      for (const char of text) {
        const delay = (60000 / (wpm * 5)) * (1 + gaussian(0, 0.3));
        robot.typeString(char);
        await sleep(Math.max(30, delay));
      }
      return { success: true, chars: text.length };
    }

    case "scroll":
    case "scrollTo": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const { direction = "down", amount = 3 } = params;
      const dy = direction === "down" ? -amount : direction === "up" ? amount : 0;
      const dx = direction === "right" ? amount : direction === "left" ? -amount : 0;
      robot.scrollMouse(dx, dy);
      return { success: true, direction, amount };
    }

    case "keyPress": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const { key, modifier } = params;
      if (!key) return { success: false, error: "Paramètre 'key' requis" };
      if (modifier) {
        robot.keyTap(key, [modifier]);
      } else {
        robot.keyTap(key);
      }
      return { success: true, key, modifier };
    }

    case "screenshot": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const Jimp = await getJimp();
      const bitmap = robot.screen.capture();
      const timestamp = Date.now();
      const filePath = join(SCREENSHOTS_DIR, `shot_${timestamp}.png`);

      // FIX 6 — Rotation : supprimer les plus anciens si > 100 fichiers dans le répertoire temp
      try {
        const existing = readdirSync(SCREENSHOTS_DIR)
          .filter((f) => f.startsWith("shot_") && f.endsWith(".png"))
          .sort();
        if (existing.length >= 100) {
          const toDelete = existing.slice(0, existing.length - 99);
          for (const f of toDelete) {
            try { rmSync(join(SCREENSHOTS_DIR, f)); } catch {}
          }
        }
      } catch {}

      if (!Jimp) {
        return {
          success: false,
          error: "jimp non installé (npm install jimp)",
          width: bitmap.width,
          height: bitmap.height,
          timestamp,
        };
      }

      const { width, height } = bitmap;
      const rgbaBuffer = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const src = i * 4;
        rgbaBuffer[src + 0] = bitmap.image[src + 2];
        rgbaBuffer[src + 1] = bitmap.image[src + 1];
        rgbaBuffer[src + 2] = bitmap.image[src + 0];
        rgbaBuffer[src + 3] = 255;
      }
      const image = new Jimp({ data: rgbaBuffer, width, height });
      await image.write(filePath);
      return { success: true, path: filePath, width, height, timestamp };
    }

    case "getPosition": {
      if (!robot) return { success: false, error: "HID non disponible" };
      const pos = robot.getMousePos();
      return { success: true, ...pos };
    }

    default:
      return { success: false, error: `Action os-control inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── TERMINAL ─────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || process.cwd());

const SAFE_COMMANDS = new Set([
  "ls", "cat", "echo", "pwd", "date", "whoami", "uname",
  "df", "du", "ps", "top", "uptime", "which", "find",
  "grep", "awk", "sed", "head", "tail", "wc", "sort",
  "node", "python3", "npm", "pip3", "git",
]);

const DANGEROUS_COMMANDS = new Set([
  "rm", "rmdir", "mv", "dd", "mkfs", "fdisk",
  "chmod", "chown", "sudo", "su", "kill", "killall",
  "shutdown", "reboot", "halt", "format",
]);

function validatePath(p) {
  const abs = normalize(resolve(p));
  if (!abs.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Chemin hors workspace: ${abs}`);
  }
  return abs;
}

function validateCommand(cmd) {
  const base = cmd.trim().split(/\s+/)[0];
  if (DANGEROUS_COMMANDS.has(base)) {
    throw new Error(`Commande dangereuse interdite: ${base}`);
  }
  return cmd;
}

/**
 * Actions terminal disponibles :
 *   exec, execSafe, listProcesses, killProcess
 */
async function handleTerminal(action, params = {}) {
  switch (action) {
    case "exec": {
      const { command, cwd, timeout = 30000 } = params;
      if (!command) return { success: false, error: "Paramètre 'command' requis" };
      try {
        validateCommand(command);
        const workDir = cwd ? validatePath(cwd) : WORKSPACE_ROOT;
        const { stdout, stderr, exitCode } = await execa("bash", ["-c", command], {
          cwd: workDir,
          timeout,
          reject: false,
          shell: false,
        });
        return { success: exitCode === 0, stdout, stderr, exitCode };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "execSafe": {
      const { command, cwd } = params;
      if (!command) return { success: false, error: "Paramètre 'command' requis" };
      const base = command.trim().split(/\s+/)[0];
      if (!SAFE_COMMANDS.has(base)) {
        return {
          success: false,
          error: `Commande non autorisée: ${base}. Utilisez exec pour les commandes avancées.`,
          code: "COMMAND_NOT_ALLOWED",
        };
      }
      try {
        const workDir = cwd ? validatePath(cwd) : WORKSPACE_ROOT;
        const parts = command.trim().split(/\s+/);
        const { stdout, stderr, exitCode } = await execa(parts[0], parts.slice(1), {
          cwd: workDir,
          timeout: 10000,
          reject: false,
        });
        return { success: exitCode === 0, stdout, stderr };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "listProcesses": {
      try {
        const { stdout } = await execa("ps", ["aux"], { reject: false });
        const procs = stdout
          .split("\n")
          .slice(1, 21) // skip header, max 20
          .filter(Boolean)
          .map((l) => {
            const parts = l.trim().split(/\s+/);
            return {
              pid: parts[1],
              cpu: parts[2],
              mem: parts[3],
              cmd: parts.slice(10).join(" "),
            };
          });
        return { success: true, processes: procs };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "killProcess": {
      const { pid, signal: sig = "TERM" } = params;
      if (!pid) return { success: false, error: "Paramètre 'pid' requis" };
      // Sécurité : kill est dans DANGEROUS_COMMANDS — autorisé uniquement via cette action dédiée
      try {
        process.kill(parseInt(pid, 10), `SIG${sig.toUpperCase()}`);
        return { success: true, pid, signal: sig };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Action terminal inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── VISION ───────────────────────────────────────────────────────────────────

async function callVisionPy(fn, args = {}) {
  try {
    const { stdout } = await execa("python3", [
      join(ROOT, "src/vision.py"),
      "--fn", fn,
      "--args", JSON.stringify(args),
    ], { reject: false, timeout: 60000 });
    try { return JSON.parse(stdout); } catch { return { success: false, error: stdout }; }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Actions vision disponibles :
 *   analyzeScreen, findElement, identifyCursorTarget, watchChange
 */
async function handleVision(action, params = {}) {
  switch (action) {
    case "analyzeScreen": {
      const { question = "Décris l'écran actuel", region } = params;
      return callVisionPy("analyze_screen", { question, region });
    }

    case "findElement": {
      const { description } = params;
      if (!description) return { success: false, error: "Paramètre 'description' requis" };
      return callVisionPy("find_element", { description });
    }

    case "identifyCursorTarget": {
      return callVisionPy("analyze_screen", {
        question: "Qu'est-ce qui se trouve sous le curseur de la souris ? Identifie l'élément UI (bouton, champ, lien, etc.).",
      });
    }

    case "watchChange": {
      const { interval = 2000, maxChecks = 10 } = params;
      // Prend 2 screenshots avec un délai et compare via vision.py
      const before = await callVisionPy("analyze_screen", { question: "Décris l'état actuel de l'écran en détail" });
      await sleep(interval);
      const after = await callVisionPy("analyze_screen", { question: "Décris l'état actuel de l'écran en détail" });
      return {
        success: true,
        before: before.description || before,
        after: after.description || after,
        changed: JSON.stringify(before) !== JSON.stringify(after),
      };
    }

    default:
      return { success: false, error: `Action vision inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── VAULT ────────────────────────────────────────────────────────────────────

const VAULT_DIR = join(ROOT, "vault");
const PROFILE_PATH = join(ROOT, ".laruche/patron-profile.json");
mkdirSync(VAULT_DIR, { recursive: true });

function loadProfile() {
  try {
    return JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
  } catch {
    return {
      identity: {},
      work_style: {},
      learned_rules: [],
      session_count: 0,
      total_tasks_completed: 0,
    };
  }
}

function saveProfile(profile) {
  profile.last_updated = new Date().toISOString();
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
}

// Singleton ChromaDB
let _chromaCollection = null;
async function getVaultCollection() {
  if (!_chromaCollection) {
    const { ChromaClient } = await import("chromadb");
    const client = new ChromaClient({ path: VAULT_DIR });
    _chromaCollection = await client.getOrCreateCollection({ name: "laruche_experiences" });
  }
  return _chromaCollection;
}

/**
 * Actions vault disponibles :
 *   storeExperience, findSimilar, getProfile, updateProfile, addRule
 */
async function handleVault(action, params = {}) {
  switch (action) {
    case "storeExperience": {
      const { task, result, success = true, skillUsed, platform } = params;
      if (!task) return { success: false, error: "Paramètre 'task' requis" };
      try {
        const collection = await getVaultCollection();
        const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const doc = `Task: ${task} | Result: ${(result || "").substring(0, 200)} | Platform: ${platform || "unknown"}`;
        await collection.add({
          ids: [id],
          documents: [doc],
          metadatas: [{
            timestamp: new Date().toISOString(),
            success,
            skill: skillUsed || "unknown",
            platform: platform || "unknown",
            resolved: success,
          }],
        });
        if (success) {
          const profile = loadProfile();
          profile.total_tasks_completed = (profile.total_tasks_completed || 0) + 1;
          saveProfile(profile);
        }
        return { success: true, id };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "findSimilar": {
      const { query, k = 5, onlySuccess = true } = params;
      if (!query) return { success: false, error: "Paramètre 'query' requis" };
      try {
        const collection = await getVaultCollection();
        const count = await collection.count();
        if (count === 0) return { results: [] };
        const where = onlySuccess ? { resolved: true } : undefined;
        const results = await collection.query({
          queryTexts: [query],
          nResults: Math.min(k, count),
          where,
        });
        return {
          results: results.documents[0] || [],
          metadatas: results.metadatas[0] || [],
        };
      } catch (e) {
        return { results: [], error: e.message };
      }
    }

    case "getProfile": {
      return loadProfile();
    }

    case "updateProfile": {
      const { key, value } = params;
      if (!key) return { success: false, error: "Paramètre 'key' requis" };
      try {
        const profile = loadProfile();
        profile[key] = value;
        saveProfile(profile);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "addRule": {
      const { rule } = params;
      if (!rule) return { success: false, error: "Paramètre 'rule' requis" };
      try {
        const profile = loadProfile();
        if (!profile.learned_rules) profile.learned_rules = [];
        if (!profile.learned_rules.includes(rule)) {
          profile.learned_rules.push(rule);
          saveProfile(profile);
        }
        return { success: true, total_rules: profile.learned_rules.length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Action vault inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── ROLLBACK ─────────────────────────────────────────────────────────────────

const ROLLBACK_DIR = join(ROOT, ".laruche/rollback");
mkdirSync(ROLLBACK_DIR, { recursive: true });

/**
 * Actions rollback disponibles :
 *   createSnapshot, listSnapshots, restore, purgeOldSnapshots
 */
async function handleRollback(action, params = {}) {
  switch (action) {
    case "createSnapshot": {
      const { missionId = `snap_${Date.now()}`, reason = "manual" } = params;
      try {
        const snapshotId = `${missionId}_${Date.now()}`;
        const snapshotDir = join(ROLLBACK_DIR, snapshotId);
        mkdirSync(snapshotDir, { recursive: true });

        await execa("rsync", [
          "-av", "--checksum",
          `${ROOT}/src/`,
          `${snapshotDir}/src/`,
          "--exclude=node_modules",
          "--exclude=.git",
        ], { reject: false });

        const manifest = {
          id: snapshotId,
          missionId,
          reason,
          timestamp: new Date().toISOString(),
          files: ["src/"],
        };
        writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2));
        return { success: true, snapshotId };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "listSnapshots": {
      try {
        const dirs = readdirSync(ROLLBACK_DIR).filter((d) => {
          try { return statSync(join(ROLLBACK_DIR, d)).isDirectory(); } catch { return false; }
        });
        const snapshots = dirs
          .map((d) => {
            try {
              return JSON.parse(readFileSync(join(ROLLBACK_DIR, d, "manifest.json"), "utf-8"));
            } catch { return null; }
          })
          .filter(Boolean)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return { success: true, snapshots };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "restore": {
      const { snapshotId } = params;
      if (!snapshotId) return { success: false, error: "Paramètre 'snapshotId' requis" };
      try {
        const snapshotDir = join(ROLLBACK_DIR, snapshotId);
        if (!existsSync(snapshotDir)) return { success: false, error: `Snapshot inconnu: ${snapshotId}` };
        await execa("rsync", [
          "-av", "--checksum",
          `${snapshotDir}/src/`,
          `${ROOT}/src/`,
        ], { reject: false });
        return { success: true, snapshotId };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "purgeOldSnapshots": {
      const { keepDays = 7 } = params;
      try {
        const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
        const dirs = readdirSync(ROLLBACK_DIR);
        let purged = 0;
        for (const dir of dirs) {
          const fullPath = join(ROLLBACK_DIR, dir);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory() && stat.mtimeMs < cutoff) {
              rmSync(fullPath, { recursive: true });
              purged++;
            }
          } catch {}
        }
        return { success: true, purged };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Action rollback inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── SKILL-FACTORY ────────────────────────────────────────────────────────────

/**
 * Actions skill-factory disponibles :
 *   createSkill, testSkill, registerSkill, evolveSkill, listSkills
 */
async function handleSkillFactory(action, params = {}) {
  switch (action) {
    case "createSkill": {
      const { description, ttl } = params;
      if (!description) return { success: false, error: "Paramètre 'description' requis" };
      try {
        const { createSkill } = await import("../skill_evolution.js");
        const result = await createSkill(description);
        return { success: true, ...result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "evolveSkill": {
      const { skillName, error: skillError, stack } = params;
      if (!skillName) return { success: false, error: "Paramètre 'skillName' requis" };
      if (!skillError) return { success: false, error: "Paramètre 'error' requis" };
      try {
        const { evolveSkill } = await import("../skill_evolution.js");
        const result = await evolveSkill(skillName, { error: skillError, stack });
        return { success: true, ...result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "listSkills": {
      try {
        const { listSkills } = await import("../skill_evolution.js");
        const skills = listSkills();
        return { success: true, skills };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "testSkill": {
      const { skillName, params: skillParams = {} } = params;
      if (!skillName) return { success: false, error: "Paramètre 'skillName' requis" };
      try {
        const { runSkill } = await import("../skill_runner.js");
        const result = await runSkill(skillName, skillParams);
        return { success: true, result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "registerSkill": {
      // Alias de createSkill avec enregistrement explicite dans le registre
      const { description } = params;
      if (!description) return { success: false, error: "Paramètre 'description' requis" };
      try {
        const { createSkill } = await import("../skill_evolution.js");
        const result = await createSkill(description);
        return { success: true, registered: true, ...result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Action skill-factory inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── JANITOR ──────────────────────────────────────────────────────────────────

const TEMP_DIR = join(ROOT, ".laruche/temp");
const LOGS_DIR = join(ROOT, ".laruche/logs");
mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Actions janitor disponibles :
 *   purgeTemp, rotateLogs, gcRAM, getStats, deleteExpiredSkills
 */
async function handleJanitor(action, params = {}) {
  switch (action) {
    case "purgeTemp": {
      try {
        const files = readdirSync(TEMP_DIR).filter((f) => f !== ".gitkeep");
        for (const f of files) {
          try { rmSync(join(TEMP_DIR, f), { recursive: true }); } catch {}
        }
        return { success: true, purged: files.length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "rotateLogs": {
      const { maxSizeMB = 10 } = params;
      try {
        if (!existsSync(LOGS_DIR)) {
          mkdirSync(LOGS_DIR, { recursive: true });
          return { success: true, rotated: 0 };
        }
        const logFiles = readdirSync(LOGS_DIR).filter((f) => f.endsWith(".log"));
        let rotated = 0;
        for (const f of logFiles) {
          const fp = join(LOGS_DIR, f);
          try {
            const { size } = statSync(fp);
            if (size > maxSizeMB * 1024 * 1024) {
              // Rotation : renomme en .log.old (écrase l'ancien)
              const oldPath = `${fp}.old`;
              if (existsSync(oldPath)) rmSync(oldPath);
              const content = readFileSync(fp, "utf-8");
              writeFileSync(oldPath, content);
              writeFileSync(fp, ""); // vide le log actif
              rotated++;
            }
          } catch {}
        }
        return { success: true, rotated };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "gcRAM": {
      const before = process.memoryUsage().heapUsed;
      if (global.gc) global.gc();
      const after = process.memoryUsage().heapUsed;
      const freedMB = ((before - after) / (1024 * 1024)).toFixed(1);
      return { success: true, freed_mb: freedMB };
    }

    case "getStats": {
      const mem = process.memoryUsage();
      let tempFiles = 0;
      try { tempFiles = readdirSync(TEMP_DIR).filter((f) => f !== ".gitkeep").length; } catch {}
      return {
        success: true,
        heap_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
        rss_mb: (mem.rss / 1024 / 1024).toFixed(1),
        temp_files: tempFiles,
      };
    }

    case "deleteExpiredSkills": {
      // Supprime les skills avec TTL dépassé dans le registre
      try {
        const { listSkills } = await import("../skill_evolution.js");
        const skills = listSkills();
        const now = Date.now();
        let deleted = 0;
        for (const skill of skills) {
          if (skill.ttl && new Date(skill.created).getTime() + skill.ttl < now) {
            const skillDir = join(ROOT, "skills", skill.name);
            if (existsSync(skillDir)) {
              rmSync(skillDir, { recursive: true });
              deleted++;
            }
          }
        }
        return { success: true, deleted };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Action janitor inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── PENCIL ───────────────────────────────────────────────────────────────────

import { exec as _exec } from "child_process";
import { promisify as _promisify } from "util";
const _execAsync = _promisify(_exec);

const PENCIL_APP   = "Pencil";
const PENCIL_PATH  = "/Applications/Pencil.app";

async function _pencilRunning() {
  try {
    const { stdout } = await _execAsync(`pgrep -x "${PENCIL_APP}" 2>/dev/null || echo ""`);
    return stdout.trim().length > 0;
  } catch { return false; }
}

async function _runAS(script) {
  const tmp = join(ROOT, ".laruche/temp/pencil_as.scpt");
  writeFileSync(tmp, script, "utf8");
  const { stdout, stderr } = await _execAsync(`osascript "${tmp}"`);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function handlePencil(action, params = {}) {
  switch (action) {
    case "open_app": {
      try {
        const running = await _pencilRunning();
        if (running) {
          await _runAS(`tell application "${PENCIL_APP}" to activate`);
          return { success: true, action: "activated", message: "Pencil activé." };
        }
        await _execAsync(`open -a "${PENCIL_PATH}"`);
        let ready = false;
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (await _pencilRunning()) { ready = true; break; }
        }
        return { success: true, action: "launched", ready };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "new_document": {
      try {
        if (!await _pencilRunning()) {
          await _execAsync(`open -a "${PENCIL_PATH}"`);
          await new Promise(r => setTimeout(r, 3000));
        }
        await _runAS(`
tell application "${PENCIL_APP}" to activate
tell application "System Events"
  tell process "${PENCIL_APP}"
    keystroke "n" using command down
  end tell
end tell`);
        return { success: true, message: "Nouveau document créé." };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "open_file": {
      const { path: fp } = params;
      if (!fp) return { success: false, error: "Paramètre 'path' requis" };
      try {
        if (!existsSync(fp)) return { success: false, error: `Fichier introuvable: ${fp}` };
        await _execAsync(`open -a "${PENCIL_PATH}" "${fp}"`);
        await new Promise(r => setTimeout(r, 1500));
        return { success: true, message: `Fichier ouvert: ${fp}` };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "screenshot": {
      try {
        if (!await _pencilRunning()) return { success: false, error: "Pencil n'est pas ouvert." };
        await _runAS(`tell application "${PENCIL_APP}" to activate`);
        await new Promise(r => setTimeout(r, 300));
        const name = params.filename || `pencil_${Date.now()}`;
        const outPath = join(SCREENSHOTS_DIR, `${name}.png`);
        await _execAsync(`screencapture -x "${outPath}"`);
        return { success: true, path: outPath };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "get_windows": {
      try {
        if (!await _pencilRunning()) return { success: true, running: false, windows: [] };
        const { stdout } = await _runAS(`
set winList to {}
tell application "${PENCIL_APP}"
  repeat with w in windows
    set end of winList to name of w
  end repeat
end tell
return winList`);
        const windows = stdout ? stdout.split(", ").filter(Boolean) : [];
        return { success: true, running: true, count: windows.length, windows };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "click_menu": {
      const { menu, item, submenu } = params;
      if (!menu || !item) return { success: false, error: "Paramètres 'menu' et 'item' requis" };
      try {
        if (!await _pencilRunning()) return { success: false, error: "Pencil n'est pas ouvert." };
        await _runAS(`tell application "${PENCIL_APP}" to activate`);
        const script = submenu
          ? `tell application "System Events"\n  tell process "${PENCIL_APP}"\n    click menu item "${submenu}" of menu "${menu}" of menu bar 1\n    click menu item "${item}" of menu 1 of menu item "${submenu}" of menu "${menu}" of menu bar 1\n  end tell\nend tell`
          : `tell application "System Events"\n  tell process "${PENCIL_APP}"\n    click menu item "${item}" of menu "${menu}" of menu bar 1\n  end tell\nend tell`;
        await _runAS(script);
        return { success: true, message: `Menu ${menu}${submenu ? ' > ' + submenu : ''} > ${item} cliqué.` };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "focus_window": {
      try {
        if (!await _pencilRunning()) return { success: false, error: "Pencil n'est pas ouvert." };
        await _runAS(`tell application "${PENCIL_APP}"\n  activate\n  set frontmost to true\nend tell`);
        return { success: true, message: "Pencil mis au premier plan." };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "close_app": {
      try {
        if (!await _pencilRunning()) return { success: true, message: "Pencil n'était pas ouvert." };
        if (params.force) {
          await _execAsync(`pkill -x "${PENCIL_APP}" 2>/dev/null || true`);
          return { success: true, action: "force_killed" };
        }
        await _runAS(`tell application "${PENCIL_APP}" to quit`);
        return { success: true, action: "quit" };
      } catch (e) { return { success: false, error: e.message }; }
    }

    default:
      return { success: false, error: `Action Pencil inconnue: ${action}`, code: "UNKNOWN_ACTION" };
  }
}

// ─── FIX 7 — Rate limiting en mémoire pour les endpoints MCP critiques ────────
const _rateLimits = new Map();

/**
 * Vérifie si la clé dépasse maxPerSec requêtes par seconde.
 * @param {string} key
 * @param {number} maxPerSec
 * @returns {boolean} true si la requête est autorisée
 */
function checkRateLimit(key, maxPerSec = 10) {
  const now = Date.now();
  const entry = _rateLimits.get(key) || { count: 0, reset: now + 1000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 1000;
  }
  entry.count++;
  _rateLimits.set(key, entry);
  return entry.count <= maxPerSec;
}

// ─── Montage des routes sur l'app Hono ────────────────────────────────────────

/**
 * @param {import('hono').Hono} app
 */
export function createMcpRoutes(app) {
  // ── POST /mcp/os-control ─────────────────────────────────────────────────────
  app.post("/mcp/os-control", async (c) => {
    // FIX 7 — Rate limit : max 10 req/s sur os-control
    const clientIp = c.req.header("x-forwarded-for") || "local";
    if (!checkRateLimit(`os-control:${clientIp}`, 10)) {
      return c.json({ success: false, error: "Rate limit dépassé (max 10 req/s)", code: "RATE_LIMIT" }, 429);
    }
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleOsControl(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/terminal ────────────────────────────────────────────────────────
  app.post("/mcp/terminal", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleTerminal(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/vision ─────────────────────────────────────────────────────────
  app.post("/mcp/vision", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleVision(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/vault ──────────────────────────────────────────────────────────
  app.post("/mcp/vault", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleVault(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/rollback ───────────────────────────────────────────────────────
  app.post("/mcp/rollback", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleRollback(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/skill-factory ──────────────────────────────────────────────────
  app.post("/mcp/skill-factory", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleSkillFactory(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/janitor ────────────────────────────────────────────────────────
  app.post("/mcp/janitor", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handleJanitor(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── POST /mcp/pencil ─────────────────────────────────────────────────────────
  // Contrôle Pencil.app (prototypage / wireframing) via AppleScript
  app.post("/mcp/pencil", async (c) => {
    const body = await parseBody(c);
    if (!body) return mcpError(c, "Body JSON invalide");
    const { action, params = {} } = body;
    if (!action) return mcpError(c, "Champ 'action' requis");
    try {
      const result = await handlePencil(action, params);
      return c.json(result);
    } catch (e) {
      return c.json({ success: false, error: e.message, code: "INTERNAL_ERROR" }, 500);
    }
  });

  // ── GET /mcp/health ──────────────────────────────────────────────────────────
  // Endpoint utilitaire pour vérifier que les routes MCP sont montées
  app.get("/mcp/health", (c) =>
    c.json({
      ok: true,
      endpoints: [
        "POST /mcp/os-control",
        "POST /mcp/terminal",
        "POST /mcp/vision",
        "POST /mcp/vault",
        "POST /mcp/rollback",
        "POST /mcp/skill-factory",
        "POST /mcp/janitor",
        "POST /mcp/pencil",
      ],
    })
  );
}
