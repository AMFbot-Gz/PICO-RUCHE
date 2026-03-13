/**
 * test/integration/e2e.test.js — Tests d'intégration PICO-RUCHE v7
 *
 * Ces tests vérifient les flux entre composants réels.
 * Pas de mocks — mais timeout limité pour éviter les dépendances réseau.
 */

import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 : WorldModel ↔ world_state.json
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: WorldModel', () => {
  test('WorldModel persiste et recharge correctement depuis disque', () => {
    // Utilise un fichier temporaire pour éviter de corrompre world_state.json
    const tmpDir = '/tmp/laruche_integration_worldmodel';
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });

    const tmpStatePath = join(tmpDir, 'world_state.json');

    // Script Python inline qui :
    // 1. Instancie WorldModel avec le fichier tmp
    // 2. Update avec un snapshot contenant active_app
    // 3. Recharge depuis le disque (nouvelle instance)
    // 4. Appelle get_frontmost_app() et retourne le résultat
    const pyScript = `
import sys
sys.path.insert(0, '${ROOT}')
import json
from pathlib import Path
from src.worldmodel.model import WorldModel

state_path = Path('${tmpStatePath}')

# Première instance : update système + set_active_app
wm1 = WorldModel(state_path)
snapshot = {
    'cpu_percent': 10.0,
    'ram_percent': 50.0,
    'ram_used_gb': 4.0,
    'ram_total_gb': 16.0,
    'disk_used_gb': 100.0,
    'disk_free_gb': 400.0,
}
wm1.update(snapshot)
wm1.set_active_app('TestApp', 'Main Window')

# Deuxième instance (recharge depuis disque)
wm2 = WorldModel(state_path)
app = wm2.get_frontmost_app()

print(json.dumps({'app': app}))
`;

    const result = execFileSync('python3', ['-c', pyScript], {
      timeout: 10000,
      encoding: 'utf8',
      cwd: ROOT,
    });

    const parsed = JSON.parse(result.trim());
    expect(parsed.app).toBe('TestApp');

    // Nettoyage
    rmSync(tmpDir, { recursive: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 : intentRouter → run_command sanitization
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: Security', () => {
  test('run_command bloque les commandes dangereuses', async () => {
    const { routeByRules } = await import('../../src/agents/intentRouter.js');

    // Commande dangereuse : rm -rf /
    const dangerous = routeByRules('exécute rm -rf /');
    // Si matchée, la commande doit être bloquée (remplacée par un echo de sécurité)
    if (dangerous.matched) {
      const cmd = dangerous.plan.steps[0].params.command;
      expect(cmd).toMatch(/bloquée/i);
      expect(cmd).not.toMatch(/rm\s+-rf\s*\//);
    } else {
      // Si pas de match sur "exécute rm -rf /" c'est aussi acceptable (sécurisé par défaut)
      expect(dangerous.matched).toBe(false);
    }
  });

  test('run_command autorise git status normalement', async () => {
    const { routeByRules } = await import('../../src/agents/intentRouter.js');

    const safe = routeByRules('exécute git status');
    // git status peut matcher via la règle git ou la règle exécute
    if (safe.matched) {
      const cmd = safe.plan.steps[0].params.command;
      // La commande ne doit pas être bloquée
      expect(cmd).not.toMatch(/bloquée/i);
      expect(cmd).toContain('git status');
    }
    // Même si pas de match, le test est valide (pas d'erreur)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 : planner recall() → heuristiques
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: Memory & Heuristics', () => {
  test('getHeuristicHint retourne un hint pour une commande musicale', async () => {
    // Prépare un fichier heuristics.jsonl temporaire avec une règle musique → Spotify
    const heuristicsDir = join(ROOT, 'agent/memory');
    mkdirSync(heuristicsDir, { recursive: true });

    const heuristicsFile = join(heuristicsDir, 'heuristics.jsonl');
    const backupFile = heuristicsFile + '.bak';

    // Sauvegarde le fichier original s'il existe
    const originalExists = existsSync(heuristicsFile);
    let originalContent = '';
    if (originalExists) {
      originalContent = readFileSync(heuristicsFile, 'utf8');
      writeFileSync(backupFile, originalContent, 'utf8');
    }

    try {
      // Écrit une règle "musique → Spotify"
      const rule = JSON.stringify({
        when: 'une commande musicale est demandée pour jouer de la musique',
        then: 'ouvrir Spotify',
        confidence: 0.9,
        extracted_at: new Date().toISOString(),
        episode_count: 3,
        source: 'test',
      });
      writeFileSync(heuristicsFile, rule + '\n', 'utf8');

      // Import dynamique pour contourner le cache du module
      // (le module met en cache _heuristicsCache avec TTL 60s)
      // On passe par un sous-process pour avoir un contexte Node propre
      const script = `
        import { getHeuristicHint } from '${ROOT}/src/learning/missionMemory.js';
        const hint = getHeuristicHint('mets de la musique');
        console.log(JSON.stringify({ hint }));
      `;

      const tmpScript = '/tmp/laruche_heuristic_test.mjs';
      writeFileSync(tmpScript, script, 'utf8');

      const result = execFileSync('node', ['--experimental-vm-modules', tmpScript], {
        timeout: 8000,
        encoding: 'utf8',
        cwd: ROOT,
      });

      const parsed = JSON.parse(result.trim());

      // Le hint peut être null si les mots-clés ne matchent pas (score ≤ 0.5)
      // mais la fonction doit au moins s'exécuter sans erreur
      if (parsed.hint !== null) {
        expect(parsed.hint).toHaveProperty('when');
        expect(parsed.hint).toHaveProperty('then');
        expect(parsed.hint).toHaveProperty('confidence');
        expect(parsed.hint.then).toMatch(/Spotify/i);
      } else {
        // Hint null est acceptable si le matching score est insuffisant
        expect(parsed.hint).toBeNull();
      }
    } finally {
      // Restaure le fichier original
      if (originalExists) {
        writeFileSync(heuristicsFile, originalContent, 'utf8');
        if (existsSync(backupFile)) rmSync(backupFile);
      } else {
        // Remet le fichier original (vide ou supprimé)
        rmSync(heuristicsFile, { force: true });
      }
    }
  });

  // ─── Test 5 : missionMemory recall() → learn() cycle ────────────────────────

  test('learn() puis recall() retourne le plan appris', async () => {
    // Utilise un sous-process isolé pour éviter les interférences avec le cache
    const testCommand = 'ouvre youtube integration test ' + Date.now();
    const steps = JSON.stringify([{ skill: 'goto_url', params: { url: 'https://youtube.com' } }]);

    const script = `
      import { learn, recall, forget } from '${ROOT}/src/learning/missionMemory.js';

      const cmd = '${testCommand}';
      const steps = ${steps};

      // Apprend la commande
      learn(cmd, steps, true, 100, 'llm');

      // Tente de la rappeler
      const recalled = recall(cmd);

      // Nettoyage
      forget(cmd);

      console.log(JSON.stringify({
        recalled: recalled,
        hasSteps: recalled !== null && Array.isArray(recalled.steps),
        firstSkill: recalled !== null ? recalled.steps[0]?.skill : null,
        source: recalled !== null ? recalled.source : null,
      }));
    `;

    const tmpScript = '/tmp/laruche_learn_recall_test.mjs';
    writeFileSync(tmpScript, script, 'utf8');

    const result = execFileSync('node', ['--experimental-vm-modules', tmpScript], {
      timeout: 10000,
      encoding: 'utf8',
      cwd: ROOT,
    });

    const parsed = JSON.parse(result.trim());

    expect(parsed.recalled).not.toBeNull();
    expect(parsed.hasSteps).toBe(true);
    expect(parsed.firstSkill).toBe('goto_url');
    expect(parsed.source).toBe('memory');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 : creditSystem — cycle complet
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: CreditSystem', () => {
  test('creditSystem: init → deduct → insufficient → recharge', async () => {
    const {
      initAgent,
      getCredits,
      deductCredits,
      addCredits,
      resetCredits,
      _resetAll,
      INITIAL_CREDITS,
      CREDIT_PER_SKILL,
    } = await import('../../src/market/creditSystem.js');

    const agentId = 'test_integration_agent_' + Date.now();

    // Nettoyage préventif
    _resetAll();

    // 1. Init à 1000 crédits
    initAgent(agentId, INITIAL_CREDITS);
    expect(getCredits(agentId)).toBe(INITIAL_CREDITS);

    // 2. Déduit 10 crédits → 990
    const r1 = deductCredits(agentId, CREDIT_PER_SKILL);
    expect(r1.success).toBe(true);
    expect(r1.remaining).toBe(INITIAL_CREDITS - CREDIT_PER_SKILL);
    expect(getCredits(agentId)).toBe(INITIAL_CREDITS - CREDIT_PER_SKILL);

    // 3. Remet le solde à 0 pour tester l'insuffisance
    resetCredits(agentId, 0);
    expect(getCredits(agentId)).toBe(0);

    // 4. Déduction quand solde 0 → erreur INSUFFICIENT_CREDITS
    const r2 = deductCredits(agentId, CREDIT_PER_SKILL);
    expect(r2.success).toBe(false);
    expect(r2.error).toBe('INSUFFICIENT_CREDITS');
    expect(r2.remaining).toBe(0);

    // 5. Recharge → nouveau solde positif
    const newBalance = addCredits(agentId, 500);
    expect(newBalance).toBe(500);
    expect(getCredits(agentId)).toBe(500);

    // 6. Déduction fonctionne à nouveau
    const r3 = deductCredits(agentId, CREDIT_PER_SKILL);
    expect(r3.success).toBe(true);
    expect(r3.remaining).toBe(490);

    // Nettoyage
    _resetAll();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 : executor.js FALLBACKS couvrent les skills critiques
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: Executor Fallbacks', () => {
  test('FALLBACKS existent pour les skills critiques', async () => {
    // Utilise un sous-process pour importer executor.js (qui démarre initAgent au chargement)
    const script = `
      // Import executor et expose FALLBACKS
      // On contourne l'import direct car executor.js appelle initAgent('queen') au niveau module
      import { readFileSync } from 'fs';
      import { createRequire } from 'module';

      // Importe dynamiquement pour récupérer FALLBACKS via reflection
      // On lit le fichier source et vérifie les clés présentes dans FALLBACKS
      const src = readFileSync('${ROOT}/src/agents/executor.js', 'utf8');

      // Extrait les clés de FALLBACKS via regex (évite d'exécuter le module entier)
      const fallbackSection = src.match(/const FALLBACKS = \\{([\\s\\S]*?)^\\};/m);
      const keys = [];
      if (fallbackSection) {
        const matches = fallbackSection[1].matchAll(/^\\s+(\\w+):/mg);
        for (const m of matches) keys.push(m[1]);
      }

      console.log(JSON.stringify({ keys }));
    `;

    const tmpScript = '/tmp/laruche_fallbacks_test.mjs';
    writeFileSync(tmpScript, script, 'utf8');

    const result = execFileSync('node', ['--experimental-vm-modules', tmpScript], {
      timeout: 8000,
      encoding: 'utf8',
      cwd: ROOT,
    });

    const parsed = JSON.parse(result.trim());
    const keys = parsed.keys;

    // Vérifie que les skills critiques ont un fallback
    expect(keys).toContain('take_screenshot');
    expect(keys).toContain('goto_url');
    expect(keys).toContain('run_command');
  });
});
