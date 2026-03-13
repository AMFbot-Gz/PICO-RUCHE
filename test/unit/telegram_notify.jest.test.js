/**
 * test/unit/telegram_notify.jest.test.js — Tests unitaires du skill telegram_notify
 *
 * Couvre : validation params, envoi réussi, erreurs API Telegram, variables d'env manquantes
 * Tous les fetch sont mockés — aucun token Telegram réel requis
 */

import { jest } from '@jest/globals';

// ─── Mock global fetch avant tout import ─────────────────────────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ─── Import du skill ──────────────────────────────────────────────────────────
const { run } = await import('../../skills/telegram_notify/skill.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTelegramOk(messageId = 42) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, result: { message_id: messageId, date: 1234567890 } }),
    status: 200,
  });
}

function makeTelegramFail(description = 'Bad Request: chat not found') {
  return Promise.resolve({
    ok: false,
    json: async () => ({ ok: false, description }),
    status: 400,
  });
}

// ─── Setup / Teardown des variables d'environnement ──────────────────────────

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockFetch.mockReset();
  // Injecter des fausses vars d'env pour les tests nominaux
  process.env.BOT_TOKEN = 'fake-bot-token-123:ABC';
  process.env.CHAT_ID   = '987654321';
});

afterEach(() => {
  // Restaurer l'environnement original
  delete process.env.BOT_TOKEN;
  delete process.env.CHAT_ID;
  Object.assign(process.env, ORIGINAL_ENV);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('telegram_notify — validation des paramètres', () => {
  test('retourne erreur si text est absent', async () => {
    const result = await run({});
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/text/i);
  });

  test('retourne erreur si BOT_TOKEN manquant', async () => {
    delete process.env.BOT_TOKEN;
    const result = await run({ text: 'Bonjour' });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/BOT_TOKEN/i);
  });

  test('retourne erreur si CHAT_ID manquant', async () => {
    delete process.env.CHAT_ID;
    const result = await run({ text: 'Bonjour' });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/CHAT_ID/i);
  });
});

describe('telegram_notify — envoi nominal', () => {
  test('retourne sent=true avec message_id quand Telegram répond ok', async () => {
    mockFetch.mockReturnValueOnce(makeTelegramOk(101));

    const result = await run({ text: '🐝 Mission accomplie' });

    expect(result.sent).toBe(true);
    expect(result.message_id).toBe(101);
    expect(result.error).toBeUndefined();
  });

  test("appelle l'URL api.telegram.org avec le bon botToken", async () => {
    mockFetch.mockReturnValueOnce(makeTelegramOk(55));

    await run({ text: 'Test URL' });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('api.telegram.org');
    expect(calledUrl).toContain('fake-bot-token-123:ABC');
    expect(calledUrl).toContain('sendMessage');
  });

  test('parse_mode Markdown est le mode par défaut', async () => {
    mockFetch.mockReturnValueOnce(makeTelegramOk());

    await run({ text: '*Texte gras*' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBe('Markdown');
  });

  test('parse_mode HTML est transmis correctement', async () => {
    mockFetch.mockReturnValueOnce(makeTelegramOk());

    await run({ text: '<b>Alerte</b>', parse_mode: 'HTML' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBe('HTML');
    expect(body.chat_id).toBe('987654321');
  });
});

describe('telegram_notify — gestion des erreurs API', () => {
  test("retourne sent=false si l'API Telegram répond avec ok=false", async () => {
    mockFetch.mockReturnValueOnce(makeTelegramFail('chat not found'));

    const result = await run({ text: 'Test erreur' });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/chat not found/i);
  });

  test('retourne sent=false en cas de timeout/réseau', async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('AbortError: timeout')));

    const result = await run({ text: 'Test timeout' });

    expect(result.sent).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});
