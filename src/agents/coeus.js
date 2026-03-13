/**
 * coeus.js — Agent Coeus, Furet de Performance v1.1
 *
 * Tourne en arrière-plan, audit les performances toutes les 5 minutes.
 * Génère des "mutation tickets" dans mutations/pending_tickets.jsonl.
 * Pour les anomalies config détectées → envoie commande directe au Phagocyte via ChimeraBus.
 *
 * Quatre sources d'audit :
 *   1. Logs système → skills dont l'exécution dépasse 3s
 *   2. CreditSystem → agents en manque de crédits (< 100)
 *   3. Dream Cycle  → heuristiques à faible confiance (< 0.6)
 *   4. Config       → valeurs incohérentes → mutation directe via Phagocyte (NOUVEAU)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { readFile as readFileAsync, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAllBalances } from '../market/creditSystem.js';
import { writeCommand } from '../../core/chimera_bus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

const MUTATIONS_DIR           = join(ROOT, 'mutations');
const PENDING_TICKETS_FILE    = join(MUTATIONS_DIR, 'pending_tickets.jsonl');

const AUDIT_INTERVAL_MS       = 5 * 60 * 1000;  // 5 minutes
const SLOW_SKILL_THRESHOLD_MS = 3000;            // 3 secondes
const LOW_CREDIT_THRESHOLD    = 100;             // seuil d'alerte crédits
const LOW_CONFIDENCE_THRESHOLD = 0.6;            // heuristiques < 60% = confusion

let _ticketCounter  = 0;
let _auditRunning   = false;
let _lastAuditTs    = null;
let _totalTickets   = 0;

// ─── Répertoire mutations ──────────────────────────────────────────────────────
function ensureMutationsDir() {
  if (!existsSync(MUTATIONS_DIR)) {
    mkdirSync(MUTATIONS_DIR, { recursive: true });
    console.info('[Coeus] Répertoire mutations/ créé');
  }
}

// ─── Chargement des tickets en attente ────────────────────────────────────────
export function loadPendingTickets() {
  ensureMutationsDir();
  if (!existsSync(PENDING_TICKETS_FILE)) return [];
  try {
    return readFileSync(PENDING_TICKETS_FILE, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
      .filter(t => t.status === 'pending');
  } catch {
    return [];
  }
}

// ─── Chargement de tous les tickets (toutes status) ───────────────────────────
export function loadAllTickets() {
  ensureMutationsDir();
  if (!existsSync(PENDING_TICKETS_FILE)) return [];
  try {
    return readFileSync(PENDING_TICKETS_FILE, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

// ─── Sauvegarde d'un ticket ────────────────────────────────────────────────────
function saveTicket(ticket) {
  ensureMutationsDir();
  appendFileSync(PENDING_TICKETS_FILE, JSON.stringify(ticket) + '\n', 'utf-8');
  _totalTickets++;
  console.info(`[Coeus] 🎫 Ticket #${ticket.id} — ${ticket.issue}: ${ticket.skill || ticket.agent || ticket.component || '?'}`);
  return ticket;
}

// ─── Approbation / rejet d'un ticket ──────────────────────────────────────────
export function processTicketApproval(ticketId, approved) {
  if (!existsSync(PENDING_TICKETS_FILE)) {
    return { error: 'Aucun fichier de tickets' };
  }
  const lines = readFileSync(PENDING_TICKETS_FILE, 'utf-8')
    .split('\n')
    .filter(l => l.trim());

  let found = false;
  const updated = lines.map(l => {
    try {
      const t = JSON.parse(l);
      if (t.id === ticketId) {
        found = true;
        return JSON.stringify({
          ...t,
          status: approved ? 'approved' : 'rejected',
          reviewed_at: new Date().toISOString(),
        });
      }
      return l;
    } catch {
      return l;
    }
  });

  if (!found) return { error: `Ticket ${ticketId} introuvable` };

  writeFileSync(PENDING_TICKETS_FILE, updated.join('\n') + '\n', 'utf-8');
  return { success: true, ticket_id: ticketId, status: approved ? 'approved' : 'rejected' };
}

// ─── AUDIT 1 : Skills lents ────────────────────────────────────────────────────
async function auditSlowSkills() {
  const skillDurations = new Map(); // skillName → [duration_ms]

  // Sources de logs à scanner
  const logSources = [
    join(ROOT, 'agent/logs/queen_node.log'),
    join(ROOT, '.laruche/logs/queen_oss.log'),
    join(ROOT, 'logs/queen_oss.log'),
  ];

  // Parse les fichiers de log pour les patterns task_done avec duration
  for (const logPath of logSources) {
    try { await access(logPath); } catch { continue; }
    try {
      const content = await readFileAsync(logPath, 'utf-8');
      // Pattern: [task_done] skill=<name> duration=<ms>ms
      const re = /task_done.*?skill[=:\s"']+([a-zA-Z0-9_]+)["']?.*?duration[=:\s]+(\d+)/gi;
      let m;
      while ((m = re.exec(content)) !== null) {
        const skill    = m[1];
        const duration = parseInt(m[2], 10);
        if (!skillDurations.has(skill)) skillDurations.set(skill, []);
        skillDurations.get(skill).push(duration);
      }
    } catch { /* log illisible, continuer */ }
  }

  // Scan mission_log.jsonl pour steps avec duration
  const missionLogPath = join(ROOT, 'data/mission_log.jsonl');
  try {
    await access(missionLogPath);
    try {
      const lines = (await readFileAsync(missionLogPath, 'utf-8')).split('\n').filter(l => l.trim());
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (Array.isArray(entry.steps)) {
          for (const step of entry.steps) {
            if (step.duration && step.skill) {
              if (!skillDurations.has(step.skill)) skillDurations.set(step.skill, []);
              skillDurations.get(step.skill).push(step.duration);
            }
          }
        }
      }
    } catch { /* json invalide */ }
  } catch { /* mission_log.jsonl absent, continuer */ }

  // Filtre : moyenne > seuil
  const problems = [];
  for (const [skill, durations] of skillDurations) {
    if (durations.length === 0) continue;
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    if (avg > SLOW_SKILL_THRESHOLD_MS) {
      problems.push({ skill, avg_ms: Math.round(avg), runs: durations.length });
    }
  }
  return problems;
}

// ─── AUDIT 2 : Agents en manque de crédits ────────────────────────────────────
function auditLowCredits() {
  try {
    const balances = getAllBalances();
    const problems = [];
    for (const [agentId, credits] of Object.entries(balances)) {
      if (credits < LOW_CREDIT_THRESHOLD) {
        problems.push({ agent: agentId, credits });
      }
    }
    return problems;
  } catch {
    return [];
  }
}

// ─── AUDIT 3 : Heuristiques à faible confiance ────────────────────────────────
async function auditWeakHeuristics() {
  const heuristicsPath = join(ROOT, 'agent/memory/heuristics.jsonl');
  try { await access(heuristicsPath); } catch { return []; }
  try {
    const lines = (await readFileAsync(heuristicsPath, 'utf-8')).split('\n').filter(l => l.trim());
    const weak = [];
    for (const line of lines) {
      const h = JSON.parse(line);
      if (typeof h.confidence === 'number' && h.confidence < LOW_CONFIDENCE_THRESHOLD) {
        weak.push({ when: h.when, then: h.then, confidence: h.confidence });
      }
    }
    return weak;
  } catch {
    return [];
  }
}

// ─── AUDIT 4 : Cohérence de la configuration ──────────────────────────────────
// Détecte les valeurs sous-optimales dans agent_config.yml et
// envoie une commande de mutation directe au Phagocyte via ChimeraBus.
// Pas de ticket intermédiaire — action immédiate, zéro latence.
async function auditConfigCoherence() {
  const configPath = join(ROOT, 'agent_config.yml');
  try { await access(configPath); } catch { return []; }

  const actions = [];
  try {
    const content = await readFileAsync(configPath, 'utf-8');

    // Règle : vital_loop_interval_sec doit être 30 (optimal)
    const match = content.match(/vital_loop_interval_sec\s*:\s*(\d+)/);
    if (match) {
      const current = parseInt(match[1], 10);
      if (current > 32) {
        console.warn(`[Coeus] ⚡ Config incohérente détectée: vital_loop_interval_sec=${current} (optimal=30)`);
        try {
          const cmd = writeCommand({
            action:    'mutate',
            target:    'agent_config.yml',
            key:       'vital_loop_interval_sec',
            old_value: current,
            new_value: 30,
          });
          console.info(`[Coeus] 🧬 Commande Phagocyte envoyée → ChimeraBus cmd_id=${cmd.id}`);
          actions.push({ type: 'config_mutation_dispatched', key: 'vital_loop_interval_sec', from: current, to: 30, cmd_id: cmd.id });
        } catch (busErr) {
          console.error(`[Coeus] ChimeraBus write error: ${busErr.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[Coeus] auditConfigCoherence error: ${err.message}`);
  }
  return actions;
}

// ─── AUDIT 5 : Patterns de code dangereux ─────────────────────────────────────
// Détecte les anti-patterns connus dans les sources Python/JS.
// Génère des tickets de mutation pour Phagocyte v0.3 (patch_code, inject_line).
async function auditCodePatterns() {
  const issues = [];

  // Règle 1 : is_blocked() utilise substring matching (vulnérable)
  const executorPath = join(ROOT, 'agent/executor.py');
  try {
    const src = await readFileAsync(executorPath, 'utf-8');
    if (src.includes('any(p in cmd for p in BLOCKED)')) {
      issues.push({
        type:        'insecure_pattern',
        component:   'executor.is_blocked',
        evidence:    'Substring matching sur patterns bloqués — contournable avec variantes (espaces, paths)',
        suggestion:  'Remplacer par regex compilées avec re.compile()',
        target_file: 'agent/executor.py',
      });
    }

    // Règle 2 : asyncio.Lock non initialisé avant usage
    if (src.includes('DB_LOCK: asyncio.Lock | None = None') || src.includes('HITL_LOCK: asyncio.Lock | None = None')) {
      // Vérifie si le guard est présent
      const queenPath = join(ROOT, 'agent/queen.py');
      const queenSrc = await readFileAsync(queenPath, 'utf-8');
      if (!queenSrc.includes('if lock is None') && !queenSrc.includes('if DB_LOCK is None')) {
        issues.push({
          type:        'null_lock_usage',
          component:   'queen.save_mission',
          evidence:    'DB_LOCK/HITL_LOCK peuvent être None pendant le démarrage',
          suggestion:  'Ajouter un guard `if lock is None: return` avant async with',
          target_file: 'agent/queen.py',
        });
      }
    }
  } catch { /* fichier inaccessible */ }

  // Règle 3 : HITL_AUTO_APPROVE override silencieux dans queen_oss.js
  const queenOssPath = join(ROOT, 'src/queen_oss.js');
  try {
    const src = await readFileAsync(queenOssPath, 'utf-8');
    if (src.includes('HITL_AUTO_APPROVE') && src.includes("process.env.HITL_AUTO_APPROVE = 'true'")) {
      issues.push({
        type:        'hitl_bypass',
        component:   'queen_oss.startup',
        evidence:    'HITL_AUTO_APPROVE forcé à true silencieusement au démarrage',
        suggestion:  'Supprimer le bloc if(!process.env.HITL_AUTO_APPROVE)',
        target_file: 'src/queen_oss.js',
      });
    }
  } catch { /* fichier inaccessible */ }

  // Règle 4 : Episodes JSONL avec guard 1MB (trim trop tardif)
  const memoryPath = join(ROOT, 'agent/memory.py');
  try {
    const src = await readFileAsync(memoryPath, 'utf-8');
    if (src.includes('1_000_000') || src.includes('1000000')) {
      issues.push({
        type:        'unbounded_file_growth',
        component:   'memory.episodes',
        evidence:    'Trim épisodes déclenché seulement après 1MB (≈5000 épisodes au lieu de 500)',
        suggestion:  'Supprimer le guard de taille, déclencher trim à chaque save',
        target_file: 'agent/memory.py',
      });
    }
  } catch { /* fichier inaccessible */ }

  return issues;
}

// ─── Création d'un ticket de mutation ─────────────────────────────────────────
export function createMutationTicket({ type, skill, agent, component, evidence, suggestion, target_file }) {
  _ticketCounter++;
  const ticket = {
    id:          `coeus-${Date.now()}-${_ticketCounter}`,
    issue:       type,
    ...(skill     && { skill }),
    ...(agent     && { agent }),
    ...(component && { component }),
    evidence,
    suggestion,
    target_file,
    status:     'pending',
    created_at: new Date().toISOString(),
    created_by: 'coeus',
  };
  return saveTicket(ticket);
}

// ─── Audit principal ───────────────────────────────────────────────────────────
export async function auditPerformance() {
  if (_auditRunning) {
    console.debug('[Coeus] Audit déjà en cours, skip');
    return [];
  }
  _auditRunning = true;
  const tickets = [];

  try {
    console.info('[Coeus] 🔍 Audit de performance démarré...');
    const t0 = Date.now();

    // Audits 1, 2, 3 en parallèle (I/O async non bloquantes)
    const [slowSkills, lowCredits, weakH] = await Promise.all([
      auditSlowSkills(),
      Promise.resolve(auditLowCredits()),
      auditWeakHeuristics(),
    ]);

    // 1. Skills lents
    for (const { skill, avg_ms, runs } of slowSkills) {
      tickets.push(createMutationTicket({
        type:        'slow_skill',
        skill,
        evidence:    `Average exec time: ${(avg_ms / 1000).toFixed(1)}s over ${runs} runs`,
        suggestion:  avg_ms > 8000
          ? `Skill critically slow (${(avg_ms / 1000).toFixed(1)}s). Consider breaking into smaller atomic steps or caching intermediate results.`
          : `Skill exceeds 3s threshold. Profile bottleneck: file I/O, network call, or subprocess overhead?`,
        target_file: `skills/${skill}/index.js`,
      }));
    }

    // 2. Agents à faibles crédits
    for (const { agent, credits } of lowCredits) {
      tickets.push(createMutationTicket({
        type:        'low_credits',
        agent,
        evidence:    `Agent has only ${credits} credits remaining (threshold: ${LOW_CREDIT_THRESHOLD})`,
        suggestion:  `Agent ${agent} is consuming credits rapidly. Audit its skill call frequency — it may be retrying failed skills or running expensive operations unnecessarily.`,
        target_file: 'src/market/creditSystem.js',
      }));
    }

    // 3. Heuristiques faibles (uniquement si >= 3 pour éviter le bruit)
    if (weakH.length >= 3) {
      tickets.push(createMutationTicket({
        type:        'weak_heuristics',
        component:   'dream_cycle',
        evidence:    `${weakH.length} heuristics with confidence < ${LOW_CONFIDENCE_THRESHOLD}. Lowest: "${weakH[0].when}" (conf=${weakH[0].confidence})`,
        suggestion:  `Dream cycle is generating low-confidence heuristics. Increase episode batch size, filter noisy episodes before extraction, or raise the minimum episode count per heuristic.`,
        target_file: 'scripts/dream_cycle.py',
      }));
    }

    // 4. Cohérence config → mutation directe via Phagocyte (zéro ticket, action immédiate)
    // Séparée du Promise.all car elle écrit sur ChimeraBus — séquentialité voulue
    const configActions = await auditConfigCoherence();

    // 5. Patterns de code dangereux → tickets de mutation
    const codeIssues = await auditCodePatterns();
    for (const issue of codeIssues) {
      tickets.push(createMutationTicket({
        type:        issue.type,
        component:   issue.component,
        evidence:    issue.evidence,
        suggestion:  issue.suggestion,
        target_file: issue.target_file,
      }));
    }
    for (const action of configActions) {
      console.info(`[Coeus] ✅ Config mutation dispatched: ${action.key} ${action.from}→${action.to}`);
    }

    _lastAuditTs = new Date().toISOString();
    console.info(`[Coeus] ✅ Audit terminé en ${Date.now() - t0}ms — ${tickets.length} ticket(s) généré(s) (total: ${_totalTickets})`);
  } finally {
    _auditRunning = false;
  }

  return tickets;
}

// ─── Stats pour l'API ─────────────────────────────────────────────────────────
export function getCoeusStats() {
  const pending = loadPendingTickets();
  const all     = loadAllTickets();
  return {
    status:         _auditRunning ? 'auditing' : 'idle',
    last_audit:     _lastAuditTs,
    total_tickets:  all.length,
    pending_tickets: pending.length,
    approved_tickets: all.filter(t => t.status === 'approved').length,
    rejected_tickets: all.filter(t => t.status === 'rejected').length,
    audit_interval_minutes: AUDIT_INTERVAL_MS / 60000,
  };
}

// ─── Boucle périodique ────────────────────────────────────────────────────────
export function startCoeusLoop() {
  ensureMutationsDir();
  console.info(`[Coeus] 🚀 Démarré — audit toutes les ${AUDIT_INTERVAL_MS / 60000} min (premier dans 30s)`);

  // Premier audit 30s après le démarrage (laisse le temps au système)
  setTimeout(async () => {
    await auditPerformance();
    setInterval(auditPerformance, AUDIT_INTERVAL_MS);
  }, 30_000);
}
