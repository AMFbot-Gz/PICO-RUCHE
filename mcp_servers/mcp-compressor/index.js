/**
 * mcp-compressor — Compression automatique du contexte LLM
 * Activé quand le contexte dépasse AUTO_COMPRESS_THRESHOLD tokens
 */

const COMPRESS_THRESHOLD = parseInt(process.env.AUTO_COMPRESS_THRESHOLD) || 8000;

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

export function shouldCompress(messages) {
  const total = (messages || []).map(m => m.content || '').join(' ');
  return estimateTokens(total) > COMPRESS_THRESHOLD;
}

export async function compress(messages, maxTokens = 500) {
  const { default: ollama } = await import('ollama').catch(() => ({ default: null }));
  if (!ollama) return messages.slice(-5).map(m => m.content).join('\n');

  const history = (messages || []).map(m => `${m.role}: ${m.content}`).join('\n');
  try {
    const response = await ollama.chat({
      model: 'llama3.2:3b',
      messages: [
        { role: 'system', content: `Résume cet historique en moins de ${maxTokens} tokens. Garde: décisions, erreurs, état actuel, prochaine étape. Réponds uniquement avec le résumé.` },
        { role: 'user', content: history }
      ]
    });
    return response.message.content;
  } catch {
    return messages.slice(-5).map(m => m.content).join('\n');
  }
}

export async function buildSystemContext(missionType = 'general') {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const contextFile = join(process.cwd(), 'support/domain-contexts', `${missionType}.md`);
  const memoryFile = join(process.cwd(), 'workspace/memory/persistent.md');
  let context = '';
  if (existsSync(contextFile)) context += readFileSync(contextFile, 'utf8');
  if (existsSync(memoryFile)) context += '\n\n' + readFileSync(memoryFile, 'utf8');
  return context;
}
