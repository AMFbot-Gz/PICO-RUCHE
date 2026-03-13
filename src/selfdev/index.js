export { analyzeRepo } from './repoAnalyzer.js';
export { generateSuggestions } from './patchGenerator.js';

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runSelfAnalysis() {
  const { analyzeRepo } = await import('./repoAnalyzer.js');
  const { generateSuggestions } = await import('./patchGenerator.js');
  const root = join(__dirname, '../../');
  const analysis = analyzeRepo(root);
  const suggestions = generateSuggestions(analysis);
  return { analysis, suggestions, timestamp: new Date().toISOString() };
}

// ─── PICO extensions — self-repair via Claude CLI / Aider ────────────────────
import { spawn, execSync as _execSync } from 'child_process';

function getRepairBackend() {
  try { _execSync('which claude', { stdio: 'ignore' }); return 'claude'; } catch {}
  try { _execSync('which aider', { stdio: 'ignore' }); return 'aider'; } catch {}
  return null;
}

export async function repairWithAI(filePath, errorDescription) {
  const backend = getRepairBackend();
  if (!backend) { console.warn('[SelfDev] Ni claude CLI ni aider disponible'); return null; }
  return new Promise((resolve, reject) => {
    const args = backend === 'claude'
      ? ['-p', `Fix this error in ${filePath}: ${errorDescription}`]
      : ['--message', `Fix: ${errorDescription}`, filePath];
    const proc = spawn(backend, args, { stdio: 'pipe' });
    let output = '';
    proc.stdout.on('data', d => { output += d; });
    proc.stderr.on('data', d => console.error('[SelfDev]', d.toString().slice(0, 100)));
    proc.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Exit ${code}`)));
    setTimeout(() => { proc.kill(); reject(new Error('Timeout 120s')); }, 120000);
  });
}

export async function selfRepairLoop(maxIterations = 3) {
  const { execSync } = await import('child_process');
  for (let i = 0; i < maxIterations; i++) {
    console.info(`[SelfDev] Itération repair ${i + 1}/${maxIterations}`);
    try {
      execSync('npm run test:unit', { stdio: 'inherit', cwd: process.cwd() });
      console.info('[SelfDev] Tests verts — repair terminé');
      return true;
    } catch (e) {
      const errorMsg = e.stdout?.toString() || e.message || '';
      const failedFile = errorMsg.match(/at .+\((.+\.(?:js|ts)):/)?.[1];
      if (failedFile) { try { await repairWithAI(failedFile, errorMsg.slice(0, 500)); } catch {} }
    }
  }
  return false;
}

export { getRepairBackend };
