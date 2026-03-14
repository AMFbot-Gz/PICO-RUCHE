/**
 * src/api/config_routes.js — Endpoints de lecture/écriture configuration
 * GET /api/config est déjà défini dans missions.js — ce fichier ajoute les POST.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function safeReadYaml(path) {
  try {
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch { return {}; }
}

function safeReadEnv(path) {
  // Lit .env et retourne les clés SANS les valeurs sensibles
  try {
    const lines = readFileSync(path, 'utf-8').split('\n');
    const result = {};
    const SENSITIVE = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD'];
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (!m) continue;
      const [, k, v] = m;
      const isSensitive = SENSITIVE.some(s => k.includes(s));
      result[k] = isSensitive ? (v.trim() ? '••••••••' : '') : v.trim();
    }
    return result;
  } catch { return {}; }
}

export function registerConfigRoutes(app) {
  // GET /api/config/full — lit la config principale enrichie (YAML + .env + couches)
  // Note : GET /api/config de base est dans missions.js
  app.get('/api/config/full', (c) => {
    const config = safeReadYaml(join(ROOT, 'agent_config.yml'));
    const env = safeReadEnv(join(ROOT, '.env'));
    const layerConfigs = {};
    for (const layer of ['brain', 'perception', 'memory', 'executor']) {
      const p = join(ROOT, 'config', 'layers', `${layer}.yml`);
      if (existsSync(p)) layerConfigs[layer] = safeReadYaml(p);
    }
    const portsPath = join(ROOT, 'config', 'deployment', 'ports.yml');
    const ports = existsSync(portsPath) ? safeReadYaml(portsPath) : {};
    return c.json({ config, env, layerConfigs, ports });
  });

  // POST /api/config/:section — sauvegarde une section de config YAML
  app.post('/api/config/:section', async (c) => {
    const section = c.req.param('section');
    let body;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'Body JSON invalide' }, 400);
    }

    const ALLOWED_LAYERS = ['brain', 'perception', 'memory', 'executor'];
    if (ALLOWED_LAYERS.includes(section)) {
      const p = join(ROOT, 'config', 'layers', `${section}.yml`);
      const current = safeReadYaml(p);
      const merged = { ...current, ...body };
      try {
        writeFileSync(p, yaml.dump(merged));
        return c.json({ success: true, section, saved: merged });
      } catch (err) {
        return c.json({ success: false, error: err.message }, 500);
      }
    }

    if (section === 'general') {
      const p = join(ROOT, 'agent_config.yml');
      const current = safeReadYaml(p);
      // Merge seulement les clés de top level autorisées
      const SAFE_KEYS = ['ollama', 'perception', 'brain', 'memory', 'security'];
      for (const k of SAFE_KEYS) {
        if (body[k]) current[k] = { ...(current[k] || {}), ...body[k] };
      }
      try {
        writeFileSync(p, yaml.dump(current));
        return c.json({ success: true, section: 'general' });
      } catch (err) {
        return c.json({ success: false, error: err.message }, 500);
      }
    }

    return c.json({ success: false, error: 'Section non autorisée' }, 400);
  });

  // POST /api/config/env — met à jour des variables .env (non sensibles uniquement)
  app.post('/api/config/env', async (c) => {
    let body;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'Body JSON invalide' }, 400);
    }
    const EDITABLE = ['OLLAMA_HOST', 'HITL_TIMEOUT_SECONDS', 'STANDALONE_MODE', 'LOG_LEVEL', 'LARUCHE_MODE', 'QUEEN_MAX_PARALLEL'];
    const envPath = join(ROOT, '.env');

    try {
      let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      const updated = [];
      for (const [key, value] of Object.entries(body)) {
        if (!EDITABLE.includes(key)) continue;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content += `\n${key}=${value}`;
        }
        updated.push(key);
      }
      writeFileSync(envPath, content);
      return c.json({ success: true, updated });
    } catch (err) {
      return c.json({ success: false, error: err.message }, 500);
    }
  });
}
