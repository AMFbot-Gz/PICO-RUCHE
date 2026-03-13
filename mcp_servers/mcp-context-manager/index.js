/**
 * mcp-context-manager — Mémoire externe persistante par domaine (PICO)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SESSIONS_DIR = join(process.cwd(), 'workspace/sessions');
const MEMORY_FILE = join(process.cwd(), 'workspace/memory/persistent.md');
const CONTEXT_DIR = join(process.cwd(), 'support/domain-contexts');

export function saveSession(sessionId, data) {
  const dir = join(SESSIONS_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(data, null, 2));
  const summary = `\n## Session ${sessionId} — ${new Date().toISOString()}\n${data.summary || JSON.stringify(data).slice(0, 200)}\n`;
  try { appendFileSync(MEMORY_FILE, summary); } catch {}
}

export function loadRelevantContext(query = '') {
  if (!existsSync(CONTEXT_DIR)) return '';
  const files = readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.md'));
  const queryWords = query.toLowerCase().split(' ').filter(w => w.length > 2);
  const scored = files.map(file => {
    const content = readFileSync(join(CONTEXT_DIR, file), 'utf8');
    const score = queryWords.filter(w => content.toLowerCase().includes(w)).length;
    return { file, content, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(r => r.content).join('\n\n---\n\n');
}

export function updateDomainContext(domain, newLearning) {
  mkdirSync(CONTEXT_DIR, { recursive: true });
  const file = join(CONTEXT_DIR, `${domain}.md`);
  const entry = `\n### Apprentissage — ${new Date().toISOString()}\n${newLearning}\n`;
  appendFileSync(file, entry);
}

export function getProfile() {
  if (!existsSync(MEMORY_FILE)) return 'Aucun profil encore.';
  return readFileSync(MEMORY_FILE, 'utf8');
}
