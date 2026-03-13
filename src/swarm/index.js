/**
 * src/swarm/index.js — Point d'entrée du module swarm distribué
 *
 * Usage :
 *   import { initSwarm, nodeRegistry, selectNode, callOnNode } from './swarm/index.js';
 *   await initSwarm();
 */

export { nodeRegistry } from './nodeRegistry.js';
export { selectNode, callOnNode } from './nodeRouter.js';

/**
 * Initialise le swarm : charge la config des nœuds et lance le premier healthcheck.
 * À appeler une seule fois au démarrage de l'application.
 */
export async function initSwarm() {
  await nodeRegistry.init();
}

/**
 * Retourne les statistiques globales du swarm (nombre de nœuds, actifs, jobs).
 */
export async function getSwarmStats() {
  return nodeRegistry.stats();
}
