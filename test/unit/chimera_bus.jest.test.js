/**
 * test/unit/chimera_bus.jest.test.js — Tests unitaires ChimeraBus
 *
 * Couvre :
 *   - HMAC signing via writeCommand (signature correcte)
 *   - writeCommand : structure de la commande retournée
 *   - readCommand : retourne null si fichier absent / status != pending
 *   - markExecuted : met à jour le statut dans le fichier
 *   - getLastCommand : lit la dernière commande
 *
 * Stratégie : on mock `fs` pour ne jamais toucher le disque réel.
 */
import { jest } from '@jest/globals';
import { createHmac } from 'crypto';

// ─── Mock du module `fs` avant tout import ────────────────────────────────────
const mockFs = {
  existsSync:    jest.fn(),
  mkdirSync:     jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync:  jest.fn(),
};

jest.unstable_mockModule('fs', () => mockFs);

// Import du module après le mock
const { writeCommand, readCommand, markExecuted, getLastCommand } = await import('../../core/chimera_bus.js');

const SECRET = process.env.CHIMERA_SECRET || 'pico-ruche-dev-secret';

function expectedSignature(cmd) {
  const payload = `${cmd.id}|${cmd.action}|${cmd.target}|${cmd.key}|${cmd.new_value}`;
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
  // Par défaut : le répertoire existe déjà (évite mkdirSync)
  mockFs.existsSync.mockReturnValue(true);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.readFileSync.mockReturnValue('{}');
});

// ─── writeCommand ─────────────────────────────────────────────────────────────

describe('chimera_bus — writeCommand', () => {
  test('retourne un objet cmd avec les champs obligatoires', () => {
    const cmd = writeCommand({
      action:    'mutate',
      target:    'agent_config.yml',
      key:       'vital_loop_interval_sec',
      old_value: 35,
      new_value: 30,
    });

    expect(cmd).toHaveProperty('id');
    expect(cmd.action).toBe('mutate');
    expect(cmd.target).toBe('agent_config.yml');
    expect(cmd.key).toBe('vital_loop_interval_sec');
    expect(cmd.old_value).toBe(35);
    expect(cmd.new_value).toBe(30);
    expect(cmd.status).toBe('pending');
    expect(cmd.created_by).toBe('coeus');
    expect(cmd.executed_at).toBeNull();
  });

  test('l\'id est unique entre deux appels successifs', () => {
    const cmd1 = writeCommand({ action: 'mutate', target: 'f.yml', key: 'k', old_value: 1, new_value: 2 });
    const cmd2 = writeCommand({ action: 'mutate', target: 'f.yml', key: 'k', old_value: 1, new_value: 2 });
    expect(cmd1.id).not.toBe(cmd2.id);
  });

  test('génère une signature HMAC sha256 correcte', () => {
    const cmd = writeCommand({
      action:    'mutate',
      target:    'agent_config.yml',
      key:       'vital_loop_interval_sec',
      old_value: 35,
      new_value: 30,
    });

    expect(cmd.signature).toBe(expectedSignature(cmd));
  });

  test('appelle writeFileSync avec du JSON valide', () => {
    writeCommand({ action: 'mutate', target: 'f.yml', key: 'k', old_value: 1, new_value: 2 });
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenJson = mockFs.writeFileSync.mock.calls[0][1];
    expect(() => JSON.parse(writtenJson)).not.toThrow();
  });

  test('inclut les champs optionnels find/replace/after/line si fournis', () => {
    const cmd = writeCommand({
      action:  'patch_code',
      target:  'agent/executor.py',
      find:    'old code',
      replace: 'new code',
    });
    expect(cmd.find).toBe('old code');
    expect(cmd.replace).toBe('new code');
    expect(cmd.key).toBeUndefined();
  });

  test('n\'inclut pas les champs undefined dans la commande', () => {
    const cmd = writeCommand({
      action:    'mutate',
      target:    'f.yml',
      key:       'k',
      old_value: 1,
      new_value: 2,
    });
    expect(cmd).not.toHaveProperty('find');
    expect(cmd).not.toHaveProperty('replace');
    expect(cmd).not.toHaveProperty('after');
    expect(cmd).not.toHaveProperty('line');
  });
});

// ─── readCommand ──────────────────────────────────────────────────────────────

describe('chimera_bus — readCommand', () => {
  test('retourne null si le fichier n\'existe pas', () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = readCommand();
    expect(result).toBeNull();
  });

  test('retourne la commande si status === "pending"', () => {
    const pending = {
      id: 'chim-123-1', action: 'mutate', target: 'f.yml',
      key: 'k', new_value: 2, status: 'pending',
      created_by: 'coeus', created_at: new Date().toISOString(),
      executed_at: null, signature: 'abc',
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(pending));

    const result = readCommand();
    expect(result).not.toBeNull();
    expect(result.id).toBe('chim-123-1');
    expect(result.status).toBe('pending');
  });

  test('retourne null si status === "done"', () => {
    const done = {
      id: 'chim-123-2', action: 'mutate', target: 'f.yml',
      key: 'k', new_value: 2, status: 'done',
      created_by: 'coeus', created_at: new Date().toISOString(),
      executed_at: new Date().toISOString(), signature: 'abc',
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(done));

    const result = readCommand();
    expect(result).toBeNull();
  });

  test('retourne null si le fichier contient du JSON invalide', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{ invalid json !!!');

    const result = readCommand();
    expect(result).toBeNull();
  });

  test('retourne null si le fichier est vide', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('   ');

    const result = readCommand();
    expect(result).toBeNull();
  });
});

// ─── markExecuted ─────────────────────────────────────────────────────────────

describe('chimera_bus — markExecuted', () => {
  const baseCmd = {
    id: 'chim-999-1', action: 'mutate', target: 'f.yml',
    key: 'k', new_value: 2, status: 'pending',
    created_by: 'coeus', created_at: new Date().toISOString(),
    executed_at: null, signature: 'abc',
  };

  test('écrit status "done" si success=true', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(baseCmd));

    markExecuted('chim-999-1', true);

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.status).toBe('done');
    expect(written.executed_at).not.toBeNull();
  });

  test('écrit status "failed" si success=false', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(baseCmd));

    markExecuted('chim-999-1', false, 'une erreur');

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.status).toBe('failed');
    expect(written.error).toBe('une erreur');
  });

  test('ne fait rien si le fichier n\'existe pas', () => {
    mockFs.existsSync.mockReturnValue(false);
    markExecuted('chim-999-1', true);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  test('ne modifie pas le fichier si l\'id ne correspond pas', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(baseCmd));

    markExecuted('chim-WRONG-id', true);

    // writeFileSync ne doit pas être appelé (id différent)
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ─── getLastCommand ───────────────────────────────────────────────────────────

describe('chimera_bus — getLastCommand', () => {
  test('retourne null si le fichier est absent', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(getLastCommand()).toBeNull();
  });

  test('retourne la commande peu importe son status', () => {
    const done = { id: 'chim-888-1', status: 'done' };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(done));

    const result = getLastCommand();
    expect(result).not.toBeNull();
    expect(result.id).toBe('chim-888-1');
    expect(result.status).toBe('done');
  });

  test('retourne null si le JSON est invalide', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{ bad json');
    expect(getLastCommand()).toBeNull();
  });
});
