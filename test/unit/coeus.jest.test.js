/**
 * test/unit/coeus.jest.test.js — Tests unitaires Coeus
 *
 * Couvre :
 *   - auditSlowSkills  : parse les logs, retourne les skills > 3s de moyenne
 *   - auditLowCredits  : détecte les agents sous le seuil de crédits
 *   - auditWeakHeuristics : retourne les heuristiques < 0.6 de confiance
 *   - auditCodePatterns   : détecte les anti-patterns dans les sources
 *
 * Stratégie :
 *   - Mock `fs` (sync) et `fs/promises` (async) pour simuler les fichiers
 *   - Mock `../market/creditSystem.js` pour getAllBalances
 *   - Mock `../../core/chimera_bus.js` pour writeCommand
 *   - Les fonctions d'audit sont "private" dans coeus.js, donc on teste
 *     via auditPerformance() en observant les tickets créés, ou en
 *     réimplémentant localement la logique exacte avec des dépendances injectées.
 */
import { jest } from '@jest/globals';

// ─── Mocks déclarés AVANT tout import ─────────────────────────────────────────

// Mock fs (sync)
const mockFs = {
  existsSync:     jest.fn().mockReturnValue(false),
  mkdirSync:      jest.fn(),
  writeFileSync:  jest.fn(),
  readFileSync:   jest.fn(),
  appendFileSync: jest.fn(),
};
jest.unstable_mockModule('fs', () => mockFs);

// Mock fs/promises (async)
const mockAccess   = jest.fn().mockRejectedValue(new Error('ENOENT'));
const mockReadFileAsync = jest.fn().mockRejectedValue(new Error('ENOENT'));
jest.unstable_mockModule('fs/promises', () => ({
  readFile: mockReadFileAsync,
  access:   mockAccess,
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

// Mock creditSystem
const mockGetAllBalances = jest.fn().mockReturnValue({});
jest.unstable_mockModule('../../src/market/creditSystem.js', () => ({
  getAllBalances:   mockGetAllBalances,
  CREDIT_PER_SKILL: 10,
  INITIAL_CREDITS:  1000,
}));

// Mock chimera_bus
const mockWriteCommand = jest.fn().mockReturnValue({ id: 'chim-mock-1' });
jest.unstable_mockModule('../../core/chimera_bus.js', () => ({
  writeCommand:    mockWriteCommand,
  readCommand:     jest.fn().mockReturnValue(null),
  markExecuted:    jest.fn(),
  sharedCmdBuffer: new SharedArrayBuffer(1024),
}));

// ─── Import du module après les mocks ─────────────────────────────────────────
const {
  auditPerformance,
  loadPendingTickets,
  loadAllTickets,
  createMutationTicket,
  processTicketApproval,
  getCoeusStats,
} = await import('../../src/agents/coeus.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetFsMocks() {
  jest.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockReadFileAsync.mockRejectedValue(new Error('ENOENT'));
  mockGetAllBalances.mockReturnValue({});
  mockWriteCommand.mockReturnValue({ id: 'chim-mock-1' });
  mockFs.appendFileSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReturnValue(undefined);
}

// ─── Tests auditSlowSkills ────────────────────────────────────────────────────
// auditSlowSkills est private ; on la teste via auditPerformance()
// qui produit des tickets "slow_skill".

describe('coeus — auditSlowSkills (via auditPerformance)', () => {
  beforeEach(resetFsMocks);

  test('retourne 0 ticket si aucun fichier de log accessible', async () => {
    // access() lève ENOENT → aucun log scannable
    const tickets = await auditPerformance();
    const slowTickets = tickets.filter(t => t.issue === 'slow_skill');
    expect(slowTickets).toHaveLength(0);
  });

  test('génère un ticket slow_skill si la moyenne dépasse 3s dans mission_log.jsonl', async () => {
    // Simule mission_log.jsonl accessible
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('mission_log.jsonl')) return;
      throw new Error('ENOENT');
    });

    const logLine = JSON.stringify({
      steps: [
        { skill: 'slow_skill_x', duration: 5000 },
        { skill: 'slow_skill_x', duration: 6000 },
      ],
    });
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('mission_log.jsonl')) return logLine + '\n';
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const slowTickets = tickets.filter(t => t.issue === 'slow_skill');
    expect(slowTickets.length).toBeGreaterThanOrEqual(1);
    const ticket = slowTickets.find(t => t.skill === 'slow_skill_x');
    expect(ticket).toBeDefined();
    expect(ticket.evidence).toMatch(/5\.5s/);
  });

  test('ne génère pas de ticket si la moyenne est < 3s', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('mission_log.jsonl')) return;
      throw new Error('ENOENT');
    });

    const logLine = JSON.stringify({
      steps: [
        { skill: 'fast_skill', duration: 1000 },
        { skill: 'fast_skill', duration: 1200 },
      ],
    });
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('mission_log.jsonl')) return logLine + '\n';
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const slowTickets = tickets.filter(t => t.skill === 'fast_skill');
    expect(slowTickets).toHaveLength(0);
  });
});

// ─── Tests auditLowCredits ────────────────────────────────────────────────────

describe('coeus — auditLowCredits (via auditPerformance)', () => {
  beforeEach(resetFsMocks);

  test('retourne 0 ticket si tous les agents ont assez de crédits', async () => {
    mockGetAllBalances.mockReturnValue({ 'agent-a': 500, 'agent-b': 1000 });
    const tickets = await auditPerformance();
    const creditTickets = tickets.filter(t => t.issue === 'low_credits');
    expect(creditTickets).toHaveLength(0);
  });

  test('génère un ticket low_credits si un agent < 100 crédits', async () => {
    mockGetAllBalances.mockReturnValue({ 'agent-broke': 50, 'agent-rich': 500 });
    const tickets = await auditPerformance();
    const creditTickets = tickets.filter(t => t.issue === 'low_credits');
    expect(creditTickets).toHaveLength(1);
    expect(creditTickets[0].agent).toBe('agent-broke');
    expect(creditTickets[0].evidence).toMatch(/50/);
  });

  test('génère un ticket par agent sous le seuil', async () => {
    mockGetAllBalances.mockReturnValue({
      'agent-a': 10,
      'agent-b': 0,
      'agent-c': 800,
    });
    const tickets = await auditPerformance();
    const creditTickets = tickets.filter(t => t.issue === 'low_credits');
    expect(creditTickets).toHaveLength(2);
  });

  test('retourne tableau vide si getAllBalances lève une exception', async () => {
    mockGetAllBalances.mockImplementation(() => { throw new Error('DB error'); });
    const tickets = await auditPerformance();
    const creditTickets = tickets.filter(t => t.issue === 'low_credits');
    expect(creditTickets).toHaveLength(0);
  });
});

// ─── Tests auditWeakHeuristics ───────────────────────────────────────────────

describe('coeus — auditWeakHeuristics (via auditPerformance)', () => {
  beforeEach(resetFsMocks);

  test('retourne 0 ticket si le fichier heuristics.jsonl est absent', async () => {
    // access() lève ENOENT → aucune heuristique
    const tickets = await auditPerformance();
    const hTickets = tickets.filter(t => t.issue === 'weak_heuristics');
    expect(hTickets).toHaveLength(0);
  });

  test('génère un ticket si >= 3 heuristiques < 0.6', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('heuristics.jsonl')) return;
      throw new Error('ENOENT');
    });

    const heuristics = [
      { when: 'context A', then: 'action A', confidence: 0.3 },
      { when: 'context B', then: 'action B', confidence: 0.4 },
      { when: 'context C', then: 'action C', confidence: 0.5 },
      { when: 'context D', then: 'action D', confidence: 0.9 },
    ];
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('heuristics.jsonl')) return heuristics.map(h => JSON.stringify(h)).join('\n') + '\n';
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const hTickets = tickets.filter(t => t.issue === 'weak_heuristics');
    expect(hTickets).toHaveLength(1);
    expect(hTickets[0].evidence).toMatch(/3 heuristics/);
  });

  test('ne génère pas de ticket si < 3 heuristiques faibles', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('heuristics.jsonl')) return;
      throw new Error('ENOENT');
    });

    const heuristics = [
      { when: 'context A', then: 'action A', confidence: 0.4 },
      { when: 'context B', then: 'action B', confidence: 0.95 },
    ];
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('heuristics.jsonl')) return heuristics.map(h => JSON.stringify(h)).join('\n') + '\n';
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const hTickets = tickets.filter(t => t.issue === 'weak_heuristics');
    expect(hTickets).toHaveLength(0);
  });
});

// ─── Tests auditCodePatterns ─────────────────────────────────────────────────

describe('coeus — auditCodePatterns (via auditPerformance)', () => {
  beforeEach(resetFsMocks);

  test('détecte insecure_pattern dans executor.py', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('executor.py')) return;
      throw new Error('ENOENT');
    });

    const fakeExecutor = `
def is_blocked(cmd):
    return any(p in cmd for p in BLOCKED)
`;
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('executor.py')) return fakeExecutor;
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const codeTickets = tickets.filter(t => t.issue === 'insecure_pattern');
    expect(codeTickets.length).toBeGreaterThanOrEqual(1);
    expect(codeTickets[0].component).toBe('executor.is_blocked');
  });

  test('détecte hitl_bypass dans queen_oss.js', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('queen_oss.js')) return;
      throw new Error('ENOENT');
    });

    const fakeQueenOss = `
if(!process.env.HITL_AUTO_APPROVE) {
  process.env.HITL_AUTO_APPROVE = 'true';
}
`;
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('queen_oss.js')) return fakeQueenOss;
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const bypassTickets = tickets.filter(t => t.issue === 'hitl_bypass');
    expect(bypassTickets.length).toBeGreaterThanOrEqual(1);
    expect(bypassTickets[0].component).toBe('queen_oss.startup');
  });

  test('détecte unbounded_file_growth dans memory.py', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('memory.py') && !path.includes('agent/memory/')) return;
      throw new Error('ENOENT');
    });

    const fakeMemory = `
if len(content) > 1_000_000:
    trim_episodes()
`;
    mockReadFileAsync.mockImplementation(async (path) => {
      if (path.includes('memory.py') && !path.includes('agent/memory/')) return fakeMemory;
      throw new Error('ENOENT');
    });

    const tickets = await auditPerformance();
    const growthTickets = tickets.filter(t => t.issue === 'unbounded_file_growth');
    expect(growthTickets.length).toBeGreaterThanOrEqual(1);
  });

  test('aucun ticket si les fichiers source sont sans anti-patterns', async () => {
    mockAccess.mockImplementation(async (path) => {
      if (path.includes('executor.py') || path.includes('queen_oss.js') || path.includes('memory.py')) return;
      throw new Error('ENOENT');
    });

    const cleanCode = '# fichier propre\ndef run(): pass\n';
    mockReadFileAsync.mockImplementation(async () => cleanCode);

    const tickets = await auditPerformance();
    const codeTickets = tickets.filter(t =>
      ['insecure_pattern', 'hitl_bypass', 'unbounded_file_growth', 'null_lock_usage'].includes(t.issue)
    );
    expect(codeTickets).toHaveLength(0);
  });
});

// ─── Tests loadPendingTickets / loadAllTickets ────────────────────────────────

describe('coeus — loadPendingTickets / loadAllTickets', () => {
  beforeEach(resetFsMocks);

  test('loadPendingTickets retourne [] si le fichier n\'existe pas', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(loadPendingTickets()).toEqual([]);
  });

  test('loadPendingTickets filtre uniquement les tickets pending', () => {
    const lines = [
      JSON.stringify({ id: '1', status: 'pending' }),
      JSON.stringify({ id: '2', status: 'approved' }),
      JSON.stringify({ id: '3', status: 'pending' }),
    ].join('\n');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(lines);

    const result = loadPendingTickets();
    expect(result).toHaveLength(2);
    expect(result.every(t => t.status === 'pending')).toBe(true);
  });

  test('loadAllTickets retourne tous les tickets quelle que soit leur status', () => {
    const lines = [
      JSON.stringify({ id: '1', status: 'pending' }),
      JSON.stringify({ id: '2', status: 'approved' }),
      JSON.stringify({ id: '3', status: 'rejected' }),
    ].join('\n');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(lines);

    const result = loadAllTickets();
    expect(result).toHaveLength(3);
  });
});

// ─── Tests processTicketApproval ─────────────────────────────────────────────

describe('coeus — processTicketApproval', () => {
  beforeEach(resetFsMocks);

  test('retourne erreur si le fichier de tickets n\'existe pas', () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = processTicketApproval('ticket-1', true);
    expect(result).toHaveProperty('error');
  });

  test('approuve un ticket existant', () => {
    const ticket = { id: 'ticket-42', status: 'pending', evidence: 'test' };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(ticket));

    const result = processTicketApproval('ticket-42', true);
    expect(result.success).toBe(true);
    expect(result.status).toBe('approved');

    const written = mockFs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('"approved"');
  });

  test('rejette un ticket existant', () => {
    const ticket = { id: 'ticket-43', status: 'pending', evidence: 'test' };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(ticket));

    const result = processTicketApproval('ticket-43', false);
    expect(result.success).toBe(true);
    expect(result.status).toBe('rejected');
  });

  test('retourne erreur si le ticket est introuvable', () => {
    const ticket = { id: 'ticket-99', status: 'pending' };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(ticket));

    const result = processTicketApproval('ticket-WRONG', true);
    expect(result).toHaveProperty('error');
  });
});

// ─── Tests getCoeusStats ──────────────────────────────────────────────────────

describe('coeus — getCoeusStats', () => {
  beforeEach(resetFsMocks);

  test('retourne les champs attendus', () => {
    mockFs.existsSync.mockReturnValue(false);
    const stats = getCoeusStats();
    expect(stats).toHaveProperty('status');
    expect(stats).toHaveProperty('last_audit');
    expect(stats).toHaveProperty('total_tickets');
    expect(stats).toHaveProperty('pending_tickets');
    expect(stats).toHaveProperty('approved_tickets');
    expect(stats).toHaveProperty('rejected_tickets');
    expect(stats).toHaveProperty('audit_interval_minutes');
  });

  test('status est "idle" au démarrage (pas d\'audit en cours)', () => {
    mockFs.existsSync.mockReturnValue(false);
    const stats = getCoeusStats();
    expect(stats.status).toBe('idle');
  });

  test('audit_interval_minutes vaut 5', () => {
    mockFs.existsSync.mockReturnValue(false);
    const stats = getCoeusStats();
    expect(stats.audit_interval_minutes).toBe(5);
  });
});
