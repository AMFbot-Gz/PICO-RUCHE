/**
 * src/market/agentMarket.js — Marché d'agents avec allocation par enchères
 *
 * Workflow :
 *  1. Les agents s'enregistrent avec registerAgent()
 *  2. dispatchWithAuction() sélectionne le meilleur via runAuction()
 *  3. recordOutcome() met à jour la réputation après exécution
 */

import { runAuction } from './auctionEngine.js';
import { recordOutcome, getAllScores } from './reputationSystem.js';
import {
  initAgent,
  getCredits,
  deductCredits,
  addCredits,
  resetCredits,
  canExecute,
  CREDIT_PER_SKILL,
} from './creditSystem.js';

/** @type {Map<string, Object>} id → config agent */
const REGISTERED_AGENTS = new Map();

/**
 * Enregistre un agent dans le marché.
 *
 * @param {{
 *   id: string,
 *   name?: string,
 *   specialization?: string[],
 *   model?: string,
 *   latencyEstimate?: number,
 *   cost?: number,
 * }} config
 */
export function registerAgent(config) {
  if (!config?.id) throw new Error('registerAgent: config.id requis');
  REGISTERED_AGENTS.set(config.id, config);
  // Initialisation des crédits (idempotent : ne réinitialise pas si déjà existant)
  initAgent(config.id);
}

/**
 * Dispatche une tâche via enchères.
 * Le gagnant de l'enchère est invoqué via opts.runFn(winnerId, task).
 *
 * @param {{ type?: string }} task
 * @param {{
 *   requiredSpecialization?: string,
 *   runFn: (agentId: string, task: Object) => Promise<Object>,
 * }} opts
 * @returns {Promise<{ success: boolean, winnerId?: string, auction?: Object, error?: string }>}
 */
export async function dispatchWithAuction(task, opts = {}) {
  // Filtrage des candidats selon spécialisation requise
  const candidates = [...REGISTERED_AGENTS.values()].filter(a => {
    if (opts.requiredSpecialization && !a.specialization?.includes(opts.requiredSpecialization)) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return { success: false, error: 'No agents available' };
  }

  const auction = runAuction(task, candidates);
  const winner = auction.winner;

  // Vérification des crédits avant exécution
  if (!canExecute(winner.id)) {
    return { success: false, error: 'INSUFFICIENT_CREDITS', agentId: winner.id };
  }

  const t = Date.now();
  let success = false;

  try {
    const result = await opts.runFn(winner.id, task);
    success = result?.success !== false;
    // Déduction des crédits après exécution réussie
    if (success) {
      deductCredits(winner.id, CREDIT_PER_SKILL);
    }
    return { ...result, winnerId: winner.id, auction };
  } catch (e) {
    return { success: false, error: e.message, winnerId: winner.id };
  } finally {
    recordOutcome(winner.id, { success, latencyMs: Date.now() - t });
  }
}

/**
 * Statistiques du marché : nombre d'agents enregistrés + scores de réputation.
 */
export function marketStats() {
  return {
    agents: REGISTERED_AGENTS.size,
    scores: getAllScores(),
  };
}

export { getAllScores as getReputations };
export { getCredits, addCredits, resetCredits };
