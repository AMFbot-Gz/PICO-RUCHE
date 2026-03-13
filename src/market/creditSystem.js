/**
 * creditSystem.js — Système de crédits Agent Market v1
 *
 * Chaque agent démarre avec 1000 crédits.
 * Chaque exécution de skill coûte CREDIT_PER_SKILL (10) crédits.
 * Un agent à 0 crédits refuse de travailler.
 *
 * Les soldes sont persistés dans world_state.json (agent_market.credits).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

export const CREDIT_PER_SKILL = 10;
export const INITIAL_CREDITS  = 1000;

const WORLD_STATE_PATH = join(ROOT, 'agent/memory/world_state.json');

/** @type {Map<string, number>} agentId → solde de crédits */
const _credits = new Map();

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * Charge les soldes depuis world_state.json au démarrage.
 * Ne lève pas d'erreur si le fichier est absent ou mal formé.
 */
export function loadFromWorldState() {
  try {
    if (!existsSync(WORLD_STATE_PATH)) return;
    const raw = readFileSync(WORLD_STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    const savedCredits = state?.agent_market?.credits;
    if (savedCredits && typeof savedCredits === 'object') {
      for (const [id, balance] of Object.entries(savedCredits)) {
        if (typeof balance === 'number') {
          _credits.set(id, balance);
        }
      }
    }
  } catch {
    // Silencieux au démarrage : état vide acceptable
  }
}

/**
 * Persiste tous les soldes dans world_state.json sous agent_market.credits.
 * Écriture atomique : écriture dans un .tmp puis rename.
 */
export function persistToWorldState() {
  try {
    // Lire l'état existant pour ne pas écraser les autres clés
    let state = {};
    if (existsSync(WORLD_STATE_PATH)) {
      try {
        state = JSON.parse(readFileSync(WORLD_STATE_PATH, 'utf8'));
      } catch {
        state = {};
      }
    }

    // Mettre à jour la section agent_market.credits
    if (!state.agent_market) state.agent_market = {};
    state.agent_market.credits     = Object.fromEntries(_credits);
    state.agent_market.last_updated = new Date().toISOString();

    // Écriture atomique via fichier temporaire
    const tmpPath = WORLD_STATE_PATH + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmpPath, WORLD_STATE_PATH);
  } catch {
    // Ne pas faire planter l'agent si la persistance échoue
  }
}

// ─── Chargement au démarrage du module ──────────────────────────────────────
loadFromWorldState();

// ─── API publique ────────────────────────────────────────────────────────────

/**
 * Initialise les crédits d'un agent (idempotent : ne réinitialise pas si déjà existant).
 *
 * @param {string} agentId
 * @param {number} initialCredits
 */
export function initAgent(agentId, initialCredits = INITIAL_CREDITS) {
  if (!_credits.has(agentId)) {
    _credits.set(agentId, initialCredits);
    persistToWorldState();
  }
}

/**
 * Retourne le solde actuel d'un agent.
 * Retourne 0 si l'agent n'est pas initialisé.
 *
 * @param {string} agentId
 * @returns {number}
 */
export function getCredits(agentId) {
  return _credits.get(agentId) ?? 0;
}

/**
 * Déduit des crédits d'un agent.
 * Refuse si le solde est insuffisant.
 *
 * @param {string} agentId
 * @param {number} amount
 * @returns {{ success: boolean, remaining: number, error?: string }}
 */
export function deductCredits(agentId, amount = CREDIT_PER_SKILL) {
  const current = getCredits(agentId);
  if (current < amount) {
    return { success: false, remaining: current, error: 'INSUFFICIENT_CREDITS' };
  }
  const newBalance = current - amount;
  _credits.set(agentId, newBalance);
  persistToWorldState();
  return { success: true, remaining: newBalance };
}

/**
 * Recharge les crédits d'un agent.
 *
 * @param {string} agentId
 * @param {number} amount
 * @returns {number} nouveau solde
 */
export function addCredits(agentId, amount) {
  const current = getCredits(agentId);
  const newBalance = current + amount;
  _credits.set(agentId, newBalance);
  persistToWorldState();
  return newBalance;
}

/**
 * Vérifie si un agent a assez de crédits pour exécuter au moins 1 skill.
 *
 * @param {string} agentId
 * @returns {boolean}
 */
export function canExecute(agentId) {
  return getCredits(agentId) >= CREDIT_PER_SKILL;
}

/**
 * Réinitialise le solde d'un agent à la valeur donnée.
 *
 * @param {string} agentId
 * @param {number} amount
 */
export function resetCredits(agentId, amount = INITIAL_CREDITS) {
  _credits.set(agentId, amount);
  persistToWorldState();
}

/**
 * Retourne tous les soldes sous la forme { agentId: credits, ... }.
 *
 * @returns {Object}
 */
export function getAllBalances() {
  return Object.fromEntries(_credits);
}

/**
 * Réinitialise la Map en mémoire (utile pour les tests).
 */
export function _resetAll() {
  _credits.clear();
}
