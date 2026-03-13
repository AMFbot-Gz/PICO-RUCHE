/**
 * phagocyte.js — Noyau Phagocyte de Chimera v0.2
 *
 * v0.2 — Mutation Arm activé
 *   – Polling du ChimeraBus à 10Hz
 *   – Réception de commandes "mutate" depuis Coeus
 *   – Application du patch directement sur le fichier cible (ex: agent_config.yml)
 *   – Log temps réel de chaque mutation appliquée
 *
 * Architecture :
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │  Coeus (src/agents/coeus.js)                                  │
 *   │   → auditConfigCoherence() détecte vital_loop_interval_sec=35 │
 *   │   → chimera_bus.writeCommand({mutate, agent_config.yml, ...}) │
 *   └──────────────────┬────────────────────────────────────────────┘
 *                      │  mutations/chimera_cmd.json  (IPC fichier)
 *                      │  SharedArrayBuffer           (IPC mémoire)
 *   ┌──────────────────▼────────────────────────────────────────────┐
 *   │  Phagocyte (ce fichier) — poll 10Hz                           │
 *   │   → readCommand() → cmd.action === "mutate"                   │
 *   │   → applyMutation(cmd) → readFile → patch → writeFile         │
 *   │   → markExecuted(cmd.id)                                      │
 *   │   → log "🔬 MUTATION APPLIQUÉE"                               │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Usage : node core/phagocyte.js [--no-worker]
 */

import { Worker }                       from 'worker_threads';
import { readFile, writeFile }          from 'fs/promises';
import { dirname, join, resolve }       from 'path';
import { fileURLToPath }                from 'url';
import { readCommand, markExecuted }    from './chimera_bus.js';
import { createHmac } from 'crypto';

const CHIMERA_SECRET = process.env.CHIMERA_SECRET || 'pico-ruche-dev-secret';

function _verifyCommand(cmd) {
  if (!cmd.signature) return false;
  const payload = `${cmd.id}|${cmd.action}|${cmd.target}|${cmd.key}|${cmd.new_value}`;
  const expected = createHmac('sha256', CHIMERA_SECRET).update(payload).digest('hex');
  return cmd.signature === expected;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ─── Bannière ─────────────────────────────────────────────────────────────────
console.log('');
console.log('████████████████████████████████████████████████████');
console.log('██  CHIMERA — Phagocyte v0.2 (Mutation Arm actif)  ██');
console.log('██  SharedArrayBuffer + ChimeraBus + MutationArm   ██');
console.log('████████████████████████████████████████████████████');
console.log('');

// ─── SharedArrayBuffer de télémétrie (thread interne) ─────────────────────────
const BUFFER_SIZE  = 1024;
const sharedBuffer = new SharedArrayBuffer(BUFFER_SIZE);
const tsView       = new BigInt64Array(sharedBuffer, 0, 2);
const statusView   = new Uint8Array(sharedBuffer, 16, 8);

// ─── Worker test_target (optionnel, skip avec --no-worker) ────────────────────
const noWorker = process.argv.includes('--no-worker');
let readInterval;
let prevCounter = 0n;

if (!noWorker) {
  const workerPath = join(__dirname, 'test_target.js');
  const worker     = new Worker(workerPath, { workerData: { sharedBuffer } });

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      console.log(`[Phagocyte] ✅ test_target.js injecté (pool PID: ${msg.pid || 'N/A'})`);
      console.log('[Phagocyte] 📡 Télémétrie SharedArrayBuffer @ 1Hz\n');
      startTelemetry();
    }
  });
  worker.on('error', (err) => console.error('[Phagocyte] Worker error:', err.message));
  worker.on('exit',  (code) => { if (code !== 0) clearInterval(readInterval); });

  process.on('SIGINT', () => {
    clearInterval(readInterval);
    worker.postMessage({ type: 'stop' });
    setTimeout(() => process.exit(0), 300);
  });
} else {
  console.log('[Phagocyte] Mode --no-worker : télémétrie désactivée');
}

function startTelemetry() {
  readInterval = setInterval(() => {
    const rawTs   = Atomics.load(tsView, 0);
    if (rawTs === 0n) return;
    const counter   = Atomics.load(tsView, 1);
    const isAlive   = Atomics.load(statusView, 0);
    const newWrites = counter - prevCounter;
    prevCounter     = counter;
    console.log(
      `[Phagocyte] 📡 ts=${new Date(Number(rawTs)).toISOString()} | ` +
      `tick=${counter} (+${newWrites}/s) | worker=${isAlive ? '🟢' : '🔴'}`
    );
  }, 1000);
}

// ─── Mutation Arm ─────────────────────────────────────────────────────────────
// Applique un patch YAML sur un fichier cible.
// Stratégie: regex line-by-line, ne touche qu'à la clé ciblée.
// Le fichier source sur disque est modifié — le code en RAM reste inchangé.

async function applyMutation(cmd) {
  const { id, action, target, key, old_value, new_value } = cmd;
  const filePath = resolve(ROOT, target);

  console.log(`[Phagocyte] 🔬 Mutation reçue : action=${action} target=${target}`);

  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    console.error(`[Phagocyte] ❌ Lecture impossible: ${filePath} — ${err.message}`);
    markExecuted(id, false, err.message);
    return false;
  }

  let patched;

  if (action === 'mutate') {
    // ─── YAML value patch (comportement existant) ─────────────────────────
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(\\s*${escapedKey}\\s*:\\s*)${old_value}(\\s*(#.*)?)$`, 'm');
    if (!pattern.test(content)) {
      console.warn(`[Phagocyte] ⚠️  Clé introuvable ou valeur déjà correcte: ${key}=${old_value}`);
      markExecuted(id, false, 'key not found or value already correct');
      return false;
    }
    patched = content.replace(pattern, `$1${new_value}$2`);

  } else if (action === 'patch_code') {
    // ─── Remplacement de bloc de code (Python ou JS) ──────────────────────
    // cmd.find    = string exact à trouver (peut être multiligne)
    // cmd.replace = string de remplacement
    if (!cmd.find || cmd.replace === undefined) {
      markExecuted(id, false, 'patch_code requires find and replace fields');
      return false;
    }
    if (!content.includes(cmd.find)) {
      console.warn(`[Phagocyte] ⚠️  Bloc introuvable dans ${target}`);
      markExecuted(id, false, 'block not found');
      return false;
    }
    patched = content.replace(cmd.find, cmd.replace);

  } else if (action === 'inject_line') {
    // ─── Injection d'une ligne après un marqueur ──────────────────────────
    // cmd.after   = marqueur ligne (string exact)
    // cmd.line    = ligne à injecter après
    if (!cmd.after || !cmd.line) {
      markExecuted(id, false, 'inject_line requires after and line fields');
      return false;
    }
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.includes(cmd.after));
    if (idx === -1) {
      console.warn(`[Phagocyte] ⚠️  Marqueur introuvable: ${cmd.after}`);
      markExecuted(id, false, 'marker not found');
      return false;
    }
    // Injecte seulement si la ligne suivante ne contient pas déjà le contenu (idempotence)
    if (idx + 1 < lines.length && lines[idx + 1].includes(cmd.line.trim())) {
      console.info(`[Phagocyte] ℹ️  Ligne déjà présente — skip (idempotent)`);
      markExecuted(id, true);
      return true;
    }
    lines.splice(idx + 1, 0, cmd.line);
    patched = lines.join('\n');

  } else {
    console.warn(`[Phagocyte] Action inconnue: ${action}`);
    markExecuted(id, false, 'unknown action');
    return false;
  }

  // ─── Écriture du fichier patché ──────────────────────────────────────────
  try {
    await writeFile(filePath, patched, 'utf-8');
  } catch (err) {
    console.error(`[Phagocyte] ❌ Écriture impossible: ${filePath} — ${err.message}`);
    markExecuted(id, false, err.message);
    return false;
  }

  markExecuted(id, true);

  console.log('');
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log(`│  🔬 MUTATION APPLIQUÉE (${action.padEnd(28)})  │`);
  console.log(`│  Fichier : ${target.padEnd(41)} │`);
  if (action === 'mutate') {
    console.log(`│  Clé     : ${key.padEnd(41)} │`);
    console.log(`│  ${String(old_value).padStart(5)} → ${String(new_value).padEnd(35)} │`);
  }
  console.log(`│  Commande: ${id.padEnd(41)} │`);
  console.log('└─────────────────────────────────────────────────────┘');
  console.log('');

  return true;
}

// ─── Boucle de polling à 10Hz ─────────────────────────────────────────────────
let _lastCmdId = null;

const mutationPoll = setInterval(async () => {
  const cmd = readCommand();
  if (!cmd) return;

  // Déduplique (évite de rejouer la même commande si markExecuted n'a pas encore écrit)
  if (cmd.id === _lastCmdId) return;

  // Vérification HMAC — rejette toute commande non signée ou falsifiée
  if (!_verifyCommand(cmd)) {
    console.error(`[Phagocyte] 🚫 REJET signature invalide — cmd_id=${cmd.id}`);
    markExecuted(cmd.id, false, 'invalid signature');
    _lastCmdId = cmd.id;
    return;
  }

  _lastCmdId = cmd.id;

  await applyMutation(cmd);
}, 100);  // 10Hz

console.log('[Phagocyte] 🦠 Mutation Arm actif — polling ChimeraBus @ 10Hz');
console.log('[Phagocyte] 🚀 En attente de commandes depuis Coeus...\n');

if (!noWorker) {
  console.log('[Phagocyte] 🧬 Injection Worker télémétrie...');
}

process.on('SIGINT', () => {
  clearInterval(mutationPoll);
  setTimeout(() => process.exit(0), 300);
});
