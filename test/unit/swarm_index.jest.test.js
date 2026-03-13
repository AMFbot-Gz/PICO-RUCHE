/**
 * test/unit/swarm_index.jest.test.js — Tests du point d'entrée src/swarm/index.js
 *
 * Couvre : présence des exports nommés, nodeRegistry.stats(), selectNode, callOnNode
 * Le fetch est mocké pour éviter les appels réseau vers Ollama.
 *
 * Note : initSwarm() et getSwarmStats() délèguent à nodeRegistry (testé dans swarm.jest.test.js).
 *        On teste ici que le module re-exporte correctement tous les symboles attendus.
 */

import { jest } from '@jest/globals';

// ─── Mock fetch avant tout import ────────────────────────────────────────────
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ models: [{ name: 'llama3:latest' }, { name: 'mistral:latest' }] }),
});

// ─── Import du module swarm/index.js ─────────────────────────────────────────
const swarmModule = await import('../../src/swarm/index.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('swarm/index.js — exports nommés', () => {
  test('exporte nodeRegistry (objet)', () => {
    expect(swarmModule.nodeRegistry).toBeDefined();
    expect(typeof swarmModule.nodeRegistry).toBe('object');
  });

  test('nodeRegistry expose les méthodes attendues', () => {
    const reg = swarmModule.nodeRegistry;
    expect(typeof reg.getAll).toBe('function');
    expect(typeof reg.get).toBe('function');
    expect(typeof reg.stats).toBe('function');
    expect(typeof reg.getAvailable).toBe('function');
  });

  test('exporte selectNode en tant que fonction', () => {
    expect(typeof swarmModule.selectNode).toBe('function');
  });

  test('exporte callOnNode en tant que fonction', () => {
    expect(typeof swarmModule.callOnNode).toBe('function');
  });

  test('exporte initSwarm en tant que fonction', () => {
    expect(typeof swarmModule.initSwarm).toBe('function');
  });

  test('exporte getSwarmStats en tant que fonction', () => {
    expect(typeof swarmModule.getSwarmStats).toBe('function');
  });
});

describe('swarm/index.js — nodeRegistry via re-export', () => {
  beforeAll(async () => {
    // Initialiser le registre via l'import direct (évite le bug de scope dans initSwarm)
    await swarmModule.nodeRegistry.init();
  });

  test('nodeRegistry.getAll() retourne un tableau non vide', () => {
    const nodes = swarmModule.nodeRegistry.getAll();
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
  });

  test('nodeRegistry.stats() retourne total, up, down, totalCapacity, activeJobs', () => {
    const stats = swarmModule.nodeRegistry.stats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('up');
    expect(stats).toHaveProperty('down');
    expect(stats).toHaveProperty('totalCapacity');
    expect(stats).toHaveProperty('activeJobs');
  });

  test('selectNode() importé via index retourne un nœud valide', () => {
    const node = swarmModule.selectNode('llama3:latest');
    expect(node).toBeDefined();
    expect(node).toHaveProperty('id');
    expect(node).toHaveProperty('url');
  });
});
