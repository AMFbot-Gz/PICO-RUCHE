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
  const { id, target, key, old_value, new_value } = cmd;
  const filePath = resolve(ROOT, target);

  console.log(`[Phagocyte] 🔬 Mutation reçue : ${target} → ${key}: ${old_value} → ${new_value}`);

  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    console.error(`[Phagocyte] ❌ Lecture impossible: ${filePath} — ${err.message}`);
    markExecuted(id, false, err.message);
    return false;
  }

  // Pattern: "key: old_value" → "key: new_value" (commentaire trailing préservé)
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern    = new RegExp(`^(\\s*${escapedKey}\\s*:\\s*)${old_value}(\\s*(#.*)?)$`, 'm');

  if (!pattern.test(content)) {
    console.warn(`[Phagocyte] ⚠️  Clé introuvable ou valeur déjà correcte: ${key}=${old_value}`);
    markExecuted(id, false, 'key not found or value already correct');
    return false;
  }

  const patched = content.replace(pattern, `$1${new_value}$2`);

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
  console.log(`│  🔬 MUTATION APPLIQUÉE                              │`);
  console.log(`│  Fichier : ${target.padEnd(41)} │`);
  console.log(`│  Clé     : ${key.padEnd(41)} │`);
  console.log(`│  ${String(old_value).padStart(5)} → ${String(new_value).padEnd(35)} │`);
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
  _lastCmdId = cmd.id;

  if (cmd.action === 'mutate') {
    await applyMutation(cmd);
  } else {
    console.warn(`[Phagocyte] Action inconnue: ${cmd.action}`);
    markExecuted(cmd.id, false, 'unknown action');
  }
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
