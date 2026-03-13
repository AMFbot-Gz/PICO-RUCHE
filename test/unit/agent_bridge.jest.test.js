/**
 * test/unit/agent_bridge.jest.test.js — Tests unitaires du skill agent_bridge
 *
 * Couvre : validation params, routing mission/think, erreurs HTTP, offline graceful
 * Tous les fetch sont mockés — aucun serveur Python requis
 */

import { jest } from '@jest/globals';

// ─── Mock global fetch avant tout import ─────────────────────────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ─── Import du skill ──────────────────────────────────────────────────────────
const { run } = await import('../../skills/agent_bridge/skill.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFetchOk(data = { status: 'ok' }) {
  return Promise.resolve({
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
    status: 200,
  });
}

function makeFetchFail(status = 500, body = 'Internal Server Error') {
  return Promise.resolve({
    ok: false,
    json: async () => ({}),
    text: async () => body,
    status,
  });
}

function makeFetchNetworkError() {
  const err = new TypeError('fetch failed');
  err.code = 'ECONNREFUSED';
  return Promise.reject(err);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();
});

describe('agent_bridge — validation des paramètres', () => {
  test('retourne erreur si command est absent', async () => {
    const result = await run({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/command/i);
  });

  test('retourne erreur si type inconnu', async () => {
    const result = await run({ command: 'test', type: 'invalid_layer' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Type inconnu/);
    expect(result.layer).toBe('invalid_layer');
  });
});

describe('agent_bridge — mode mission (port 8001)', () => {
  test('appelle /mission sur port 8001 et retourne success=true', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk({ task_id: 'abc123', status: 'queued' }));

    const result = await run({ command: 'Analyse le système', type: 'mission' });

    expect(result.success).toBe(true);
    expect(result.layer).toBe('mission');
    expect(result.result).toMatchObject({ task_id: 'abc123' });

    // Vérifier que l'URL appelée contient bien 8001
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('8001');
    expect(calledUrl).toContain('/mission');
  });

  test('type mission est la valeur par défaut', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk({ ok: true }));

    const result = await run({ command: 'commande sans type' });

    expect(result.layer).toBe('mission');
    expect(result.success).toBe(true);
  });
});

describe('agent_bridge — mode think (port 8003)', () => {
  test('appelle /think sur port 8003', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk({ thought: 'analyse profonde', confidence: 0.9 }));

    const result = await run({ command: 'Réfléchis à la stratégie', type: 'think' });

    expect(result.success).toBe(true);
    expect(result.layer).toBe('think');

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('8003');
    expect(calledUrl).toContain('/think');
  });
});

describe('agent_bridge — gestion des erreurs', () => {
  test('HTTP 500 → success=false avec code dans le message', async () => {
    mockFetch.mockReturnValueOnce(makeFetchFail(500, 'Internal error'));

    const result = await run({ command: 'test erreur', type: 'mission' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(result.layer).toBe('mission');
  });

  test('réseau inaccessible → offline=true, success=false, pas de throw', async () => {
    mockFetch.mockImplementationOnce(makeFetchNetworkError);

    const result = await run({ command: 'test offline', type: 'mission' });

    expect(result.success).toBe(false);
    expect(result.offline).toBe(true);
    expect(result.error).toMatch(/inaccessible|non disponible/i);
  });
});
