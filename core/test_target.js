/**
 * test_target.js — Cible du Phagocyte
 *
 * Ce script tourne en tant que Worker thread.
 * Il écrit l'horodatage courant dans le SharedArrayBuffer toutes les secondes.
 * Le Phagocyte lit cette mémoire sans passer par IPC — accès direct au buffer.
 *
 * Preuve de concept : shared-memory entre threads Node.js (latence ~microseconde).
 */

import { workerData, parentPort } from 'worker_threads';

const { sharedBuffer } = workerData;

// Vue BigInt64 pour stocker un timestamp 64 bits de façon atomique
// index 0 → timestamp ms (Date.now())
// index 1 → compteur d'écritures (sanity check)
const tsView      = new BigInt64Array(sharedBuffer, 0, 2);  // 16 bytes
const statusView  = new Uint8Array(sharedBuffer, 16, 8);    // byte de statut : 1 = actif

// Signal de vie : le worker est prêt
Atomics.store(statusView, 0, 1);
parentPort.postMessage({ type: 'ready', pid: process.pid });

let writeCount = 0;

const write = () => {
  const now = BigInt(Date.now());
  Atomics.store(tsView, 0, now);          // timestamp en ms
  Atomics.add(tsView, 1, 1n);             // incrémente le compteur
  writeCount++;
};

// Écriture immédiate puis toutes les secondes
write();
const interval = setInterval(write, 1000);

// Arrêt propre sur signal parent
parentPort.on('message', (msg) => {
  if (msg?.type === 'stop') {
    clearInterval(interval);
    Atomics.store(statusView, 0, 0);  // signal arrêt
    parentPort.postMessage({ type: 'stopped', writes: writeCount });
    process.exit(0);
  }
});
