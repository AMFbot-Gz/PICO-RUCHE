import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../../data');
const EPISODES_FILE = join(DATA_DIR, 'episodes.jsonl');
const MAX_EPISODES = 500;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Cache en RAM des N derniers épisodes
let _episodesCache = null;

function loadEpisodes() {
  if (_episodesCache) return _episodesCache;
  try {
    if (existsSync(EPISODES_FILE)) {
      const lines = readFileSync(EPISODES_FILE, 'utf8').split('\n').filter(Boolean);
      _episodesCache = lines.slice(-MAX_EPISODES).map(l => JSON.parse(l));
      return _episodesCache;
    }
  } catch {}
  _episodesCache = [];
  return _episodesCache;
}

/**
 * Enregistre une expérience complète de mission
 */
export function storeEpisode({ mission, context = {}, actions = [], observations = [], outcome, rewardScore = 0, lessons = [] }) {
  const episode = {
    id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mission: (mission || '').slice(0, 200),
    context,
    actions: (actions || []).slice(0, 20),
    observations: (observations || []).slice(0, 10),
    outcome: outcome || 'unknown',
    rewardScore: Math.max(0, Math.min(1, rewardScore)),
    lessons: (lessons || []).slice(0, 5),
    timestamp: new Date().toISOString(),
  };

  try {
    appendFileSync(EPISODES_FILE, JSON.stringify(episode) + '\n', 'utf8');
    const episodes = loadEpisodes();
    episodes.push(episode);
    if (episodes.length > MAX_EPISODES) {
      episodes.splice(0, episodes.length - MAX_EPISODES);
      // Réécriture fichier pour refléter le trim
      try {
        writeFileSync(EPISODES_FILE, episodes.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      } catch (_) {}
    }
  } catch {}

  return episode;
}

/**
 * Recherche épisodes similaires par similarité textuelle simple
 */
export function retrieveSimilarEpisodes(query, limit = 5) {
  const episodes = loadEpisodes();
  if (episodes.length === 0) return [];

  const qTokens = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  const scored = episodes.map(ep => {
    const mTokens = new Set((ep.mission || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const intersection = [...qTokens].filter(w => mTokens.has(w)).length;
    const score = intersection / (qTokens.size + mTokens.size - intersection || 1);
    return { ...ep, _score: score };
  });

  return scored.sort((a, b) => b._score - a._score).slice(0, limit).filter(e => e._score > 0.1);
}

export function episodeStats() {
  const episodes = loadEpisodes();
  const avgReward = episodes.length > 0 ? episodes.reduce((s, e) => s + (e.rewardScore || 0), 0) / episodes.length : 0;
  return { totalEpisodes: episodes.length, avgRewardScore: Math.round(avgReward * 100) / 100 };
}

export function getEpisodes(limit = 20, offset = 0) {
  const episodes = loadEpisodes();
  return { episodes: episodes.slice(-limit - offset, episodes.length - offset).reverse(), total: episodes.length };
}

export function deleteEpisode(id) {
  const episodes = loadEpisodes();
  const idx = episodes.findIndex(e => e.id === id);
  if (idx === -1) return false;
  episodes.splice(idx, 1);
  // Réécriture complète (rare)
  try { writeFileSync(EPISODES_FILE, episodes.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'); } catch {}
  return true;
}
