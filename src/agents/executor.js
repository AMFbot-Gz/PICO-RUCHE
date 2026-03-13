/**
 * executor.js — Exécuteur fiable de steps avec retry + timeout + fallback
 *
 * Principe :
 * 1. Timeout strict par skill
 * 2. Retry automatique (1 retry)
 * 3. Résultat structuré toujours défini
 * 4. Alternatives si skill échoue
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { initAgent, deductCredits, CREDIT_PER_SKILL } from '../market/creditSystem.js';
import { estimateRisk } from '../simulation/riskEstimator.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// Initialisation de l'agent queen au démarrage du module
initAgent('queen');

// Timeouts par skill (ms)
const SKILL_TIMEOUTS = {
  take_screenshot:       6000,
  open_app:              5000,
  goto_url:              8000,
  type_text:             4000,
  press_key:             3000,
  press_enter:           3000,
  run_command:           12000,
  run_shell:             12000,
  http_fetch:            15000,
  read_file:             3000,
  list_big_files:        8000,
  summarize_project:     10000,
  // Semantic computer-use skills
  accessibility_reader:  15000,
  find_element:          15000,
  smart_click:           15000,
  screen_elements:       20000,
  wait_for_element:      30000,  // timeout Python géré en interne
  _default:              10000,
};

// Skill alternatives si le premier échoue
const FALLBACKS = {
  take_screenshot: async (params) => {
    // Fallback : screencapture direct
    const { execSync } = await import('child_process');
    const path = params.path || '/tmp/laruche_screenshot_fb.png';
    execSync(`screencapture -x "${path}"`, { timeout: 5000 });
    return { success: true, path, message: 'Screenshot via fallback' };
  },
  open_app: async ({ app }) => {
    // Fallback : open -a
    const { execSync } = await import('child_process');
    execSync(`open -a "${app}"`, { timeout: 5000 });
    return { success: true, app, message: `Opened via open -a` };
  },
  goto_url: async ({ url }) => {
    // Fallback : open URL directement
    const { execSync } = await import('child_process');
    execSync(`open "${url}"`, { timeout: 5000 });
    return { success: true, url, message: 'Opened via default browser' };
  },
  type_text: async ({ text }) => {
    // Fallback : pbcopy + AppleScript paste (évite les problèmes unicode avec osascript)
    const { execSync } = await import('child_process');
    execSync(`echo ${JSON.stringify(text)} | pbcopy && osascript -e 'tell app "System Events" to keystroke "v" using command down'`, { timeout: 4000 });
    return { success: true, text, message: 'Typed via clipboard fallback' };
  },
  press_key: async ({ key }) => {
    // Fallback : AppleScript keystroke direct
    const { execSync } = await import('child_process');
    execSync(`osascript -e 'tell app "System Events" to keystroke "${key}"'`, { timeout: 3000 });
    return { success: true, key, message: 'Key pressed via AppleScript fallback' };
  },
  press_enter: async () => {
    const { execSync } = await import('child_process');
    execSync(`osascript -e 'tell app "System Events" to key code 36'`, { timeout: 3000 });
    return { success: true, message: 'Enter via AppleScript fallback' };
  },
  run_command: async ({ command }) => {
    // Fallback : execSync direct (si terminal_mcp non disponible)
    const { execSync } = await import('child_process');
    const out = execSync(command, { timeout: 10000, encoding: 'utf8' });
    return { success: true, output: out, message: 'Command via direct fallback' };
  },
  http_fetch: async ({ url }) => {
    // Fallback : curl si skill http_fetch échoue
    const { execSync } = await import('child_process');
    const out = execSync(`curl -s --max-time 10 "${url}"`, { timeout: 12000, encoding: 'utf8' });
    return { success: true, body: out, message: 'Fetched via curl fallback' };
  },
};

// Cache des skill handlers importés
const _skillCache = new Map();

async function loadSkill(skillName) {
  if (_skillCache.has(skillName)) return _skillCache.get(skillName);

  // Cherche index.js puis skill.js (compatibilité anciens skills)
  const candidates = [
    join(ROOT, 'skills', skillName, 'index.js'),
    join(ROOT, 'skills', skillName, 'skill.js'),
  ];
  const skillPath = candidates.find(existsSync);
  if (!skillPath) return null;

  try {
    const mod = await import(skillPath);
    const handler = typeof mod.run === 'function' ? mod.run : null;
    _skillCache.set(skillName, handler);
    return handler;
  } catch {
    return null;
  }
}

/**
 * Exécute un step avec timeout + retry
 * @returns {{ success: boolean, result: any, duration: number, attempts: number }}
 */
export async function executeStep(step, { hudFn, maxRetries = 1 } = {}) {
  const { skill, params = {} } = step;
  const timeout = SKILL_TIMEOUTS[skill] || SKILL_TIMEOUTS._default;
  const startTime = Date.now();

  hudFn?.({ type: 'task_start', task: `${skill}`, params: JSON.stringify(params).slice(0, 80) });

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      // Charger le skill
      const handler = await loadSkill(skill);
      if (!handler) {
        return {
          success: false,
          error: `Skill "${skill}" introuvable`,
          duration: Date.now() - startTime,
          attempts: attempt,
        };
      }

      // Exécuter avec timeout
      const result = await Promise.race([
        handler(params),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${timeout}ms`)), timeout)),
      ]);

      if (result?.success === false) {
        throw new Error(result.error || 'Skill returned failure');
      }

      hudFn?.({ type: 'task_done', task: skill, status: 'ok', duration: Date.now() - startTime });
      return {
        success: true,
        result,
        duration: Date.now() - startTime,
        attempts: attempt,
        skill,
      };

    } catch (err) {
      if (attempt <= maxRetries) {
        hudFn?.({ type: 'thinking', agent: 'Executor', thought: `Retry ${skill}: ${err.message.slice(0, 50)}` });
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }

      // Dernier recours : fallback alternatif
      const fallbackFn = FALLBACKS[skill];
      if (fallbackFn) {
        try {
          hudFn?.({ type: 'thinking', agent: 'Executor', thought: `Fallback ${skill}` });
          const fbResult = await Promise.race([
            fallbackFn(params),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Fallback timeout')), timeout)),
          ]);
          hudFn?.({ type: 'task_done', task: skill, status: 'ok-fallback', duration: Date.now() - startTime });
          return {
            success: true,
            result: fbResult,
            duration: Date.now() - startTime,
            attempts: attempt,
            usedFallback: true,
            skill,
          };
        } catch (fbErr) {
          // Fallback aussi échoué
        }
      }

      hudFn?.({ type: 'task_done', task: skill, status: 'error', error: err.message });
      return {
        success: false,
        error: err.message,
        duration: Date.now() - startTime,
        attempts: attempt,
        skill,
      };
    }
  }
}

/**
 * Exécute une séquence de steps dans l'ordre.
 *
 * v4.2 : distingue explicitement success / partial / failed
 *   - success : tous les steps ont réussi
 *   - partial : au moins 1 step réussi ET au moins 1 échoué
 *   - failed  : tous les steps ont échoué (ou stopOnError déclenché dès le 1er échec)
 *
 * @returns {{
 *   success: boolean,
 *   status: 'success'|'partial'|'failed',
 *   results: any[],
 *   duration: number,
 *   successCount: number,
 *   totalCount: number,
 *   completedSteps: number,
 *   totalSteps: number,
 * }}
 */
export async function executeSequence(steps, { hudFn, stopOnError = false } = {}) {
  const results = [];
  const start   = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    hudFn?.({ type: 'thinking', agent: 'Executor', thought: `${i+1}/${steps.length}: ${step.skill}` });

    // ─── Guard HITL : bloque les actions HIGH-risk si HITL_AUTO_APPROVE != 'true' ─
    const autoApprove = process.env.HITL_AUTO_APPROVE === 'true';
    const riskAssessment = estimateRisk(step.skill, step.params || {});
    if (riskAssessment.level === 'high' && !autoApprove) {
      logger.warn(`[Queen] Action HIGH-risk bloquée — HITL requis: ${step.skill}`);
      const blockedResult = { success: false, reason: 'hitl_required', step };
      results.push({ step, ...blockedResult });
      if (stopOnError) break;
      if (i < steps.length - 1) await new Promise(r => setTimeout(r, 300));
      continue;
    }

    const result = await executeStep(step, { hudFn });
    results.push({ step, ...result });

    // Déduction des crédits de l'agent queen après chaque skill réussi
    if (result.success) {
      deductCredits('queen', CREDIT_PER_SKILL);
    }

    if (!result.success && stopOnError) break;

    // Pause entre steps pour laisser macOS traiter l'action
    if (i < steps.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const successCount = results.filter(r => r.success).length;
  const status = successCount === steps.length ? 'success'
    : successCount > 0 ? 'partial'
    : 'failed';

  return {
    success: status === 'success',
    status,
    results,
    duration: Date.now() - start,
    successCount,
    totalCount: steps.length,
    // Alias pour rétrocompatibilité
    completedSteps: successCount,
    totalSteps: steps.length,
  };
}
