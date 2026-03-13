/**
 * chimera_bus.js — Bus de Commandes Chimériques v1.0
 *
 * Pont de communication entre Coeus (le cerveau diagnostiqueur) et
 * le Phagocyte (le bras exécutant).
 *
 * Architecture IPC :
 *   Intra-processus  → SharedArrayBuffer (latence ~1µs, zero-copy)
 *   Cross-processus  → mutations/chimera_cmd.json (latence ~10ms, polling 10Hz)
 *
 * Le fichier chimera_cmd.json est la "concrétisation persistée" du SharedArrayBuffer
 * pour les scénarios où Coeus et Phagocyte tournent dans des processus séparés.
 *
 * Format de commande :
 * {
 *   id:         "chim-1710318600000-1",
 *   action:     "mutate",
 *   target:     "agent_config.yml",
 *   key:        "vital_loop_interval_sec",
 *   old_value:  35,
 *   new_value:  30,
 *   status:     "pending" | "executing" | "done" | "failed",
 *   created_by: "coeus",
 *   created_at: ISO string,
 *   executed_at: ISO string | null,
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';

const CHIMERA_SECRET = process.env.CHIMERA_SECRET || 'pico-ruche-dev-secret';

function _signCommand(cmd) {
  const payload = `${cmd.id}|${cmd.action}|${cmd.target}|${cmd.key}|${cmd.new_value}`;
  return createHmac('sha256', CHIMERA_SECRET).update(payload).digest('hex');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const MUTATIONS_DIR = join(ROOT, 'mutations');
const CMD_FILE      = join(MUTATIONS_DIR, 'chimera_cmd.json');

// ─── SharedArrayBuffer intra-processus ────────────────────────────────────────
// Utilisé quand Coeus et Phagocyte partagent le même processus Node.js.
// Layout: [cmdLength (Int32) | cmdJson (UTF-8 bytes, max 1020 bytes)]
const _SAB_SIZE    = 1024;
export const sharedCmdBuffer = new SharedArrayBuffer(_SAB_SIZE);
const _cmdLenView  = new Int32Array(sharedCmdBuffer, 0, 1);   // longueur JSON
const _cmdDataView = new Uint8Array(sharedCmdBuffer, 4);      // données JSON

let _cmdCounter = 0;

function ensureMutationsDir() {
  if (!existsSync(MUTATIONS_DIR)) mkdirSync(MUTATIONS_DIR, { recursive: true });
}

// ─── Écriture d'une commande ───────────────────────────────────────────────────
/**
 * Coeus appelle writeCommand() pour envoyer une mutation au Phagocyte.
 * Écrit simultanément dans le SAB (intra-processus) ET dans le fichier (cross-process).
 */
export function writeCommand({ action, target, key, old_value, new_value, find, replace, after, line }) {
  ensureMutationsDir();
  _cmdCounter++;

  const cmd = {
    id:          `chim-${Date.now()}-${_cmdCounter}`,
    action,
    target,
    ...(key       !== undefined && { key }),
    ...(old_value !== undefined && { old_value }),
    ...(new_value !== undefined && { new_value }),
    ...(find      !== undefined && { find }),
    ...(replace   !== undefined && { replace }),
    ...(after     !== undefined && { after }),
    ...(line      !== undefined && { line }),
    status:      'pending',
    created_by:  'coeus',
    created_at:  new Date().toISOString(),
    executed_at: null,
  };

  cmd.signature = _signCommand(cmd);

  const json    = JSON.stringify(cmd);
  const encoded = new TextEncoder().encode(json);

  // 1. SharedArrayBuffer (intra-processus) — lecture atomique côté Phagocyte
  if (encoded.length <= _SAB_SIZE - 4) {
    _cmdDataView.set(encoded);
    Atomics.store(_cmdLenView, 0, encoded.length);  // signal atomique
  }

  // 2. Fichier JSON (cross-processus) — polling côté Phagocyte standalone
  writeFileSync(CMD_FILE, json, 'utf-8');

  return cmd;
}

// ─── Lecture d'une commande (fichier) ─────────────────────────────────────────
/**
 * Phagocyte appelle readCommand() pour récupérer une commande en attente.
 * Source: fichier JSON (utilisé en mode cross-processus).
 */
export function readCommand() {
  if (!existsSync(CMD_FILE)) return null;
  try {
    const raw = readFileSync(CMD_FILE, 'utf-8').trim();
    if (!raw) return null;
    const cmd = JSON.parse(raw);
    return cmd.status === 'pending' ? cmd : null;
  } catch {
    return null;
  }
}

// ─── Lecture depuis le SharedArrayBuffer (intra-processus) ────────────────────
/**
 * Phagocyte appelle readCommandSAB() pour récupérer une commande depuis le SAB.
 * Source: SharedArrayBuffer (utilisé en mode intra-processus).
 */
export function readCommandSAB() {
  const len = Atomics.load(_cmdLenView, 0);
  if (len <= 0) return null;
  try {
    const bytes = _cmdDataView.slice(0, len);
    const json  = new TextDecoder().decode(bytes);
    const cmd   = JSON.parse(json);
    return cmd.status === 'pending' ? cmd : null;
  } catch {
    return null;
  }
}

// ─── Marquer une commande comme exécutée ──────────────────────────────────────
export function markExecuted(cmdId, success = true, error = null) {
  // Mettre à zéro la longueur dans le SAB (efface la commande intra-processus)
  Atomics.store(_cmdLenView, 0, 0);

  // Mettre à jour le fichier
  if (!existsSync(CMD_FILE)) return;
  try {
    const raw = readFileSync(CMD_FILE, 'utf-8').trim();
    if (!raw) return;
    const cmd = JSON.parse(raw);
    if (cmd.id === cmdId) {
      writeFileSync(CMD_FILE, JSON.stringify({
        ...cmd,
        status:      success ? 'done' : 'failed',
        executed_at: new Date().toISOString(),
        ...(error && { error }),
      }), 'utf-8');
    }
  } catch { /* fichier entre-temps modifié */ }
}

// ─── Historique des commandes exécutées ───────────────────────────────────────
export function getLastCommand() {
  if (!existsSync(CMD_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CMD_FILE, 'utf-8').trim());
  } catch {
    return null;
  }
}
