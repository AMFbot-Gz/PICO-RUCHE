/**
 * intentRouter.js — Routeur Déterministe d'Intentions v1.0
 *
 * Principe : regex → plan garanti, ZÉRO LLM pour les commandes connues.
 * Le LLM est utilisé uniquement en fallback pour les commandes inconnues.
 *
 * Chaque règle : { test: RegExp, build: (match, text) => Step[] }
 */

// ─── Types ────────────────────────────────────────────────────────────────────
// Step : { skill: string, params: object, description?: string }
// Plan : { goal: string, steps: Step[], confidence: number, source: 'rules'|'llm' }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const step  = (skill, params = {}, desc = '') => ({ skill, params, description: desc || skill });
const steps = (...s) => s;

// ─── Sécurité : blocklist pour run_command ─────────────────────────────────
// Commandes destructrices bloquées — toujours passer par execSafe côté MCP
const SHELL_BLOCKLIST = [
  /rm\s+-rf?\s+\//,           // rm -rf /
  /:\(\)\{.*\|.*&\}/,         // fork bomb
  /dd\s+if=\/dev\/zero/,      // dd zero wipe
  /mkfs\./,                   // formater un disque
  /shutdown/i,                // arrêt système
  /reboot/i,                  // redémarrage
  /halt\b/,                   // arrêt
  />\s*\/dev\/s[d-z]/,        // écriture disque brut
  /sudo\s+rm\s+-rf/,          // rm -rf via sudo
  /curl.+\|\s*(?:sh|bash)/,   // curl | bash (injection)
  /wget.+\|\s*(?:sh|bash)/,   // wget | bash
];

function sanitizeCommand(cmd) {
  for (const pattern of SHELL_BLOCKLIST) {
    if (pattern.test(cmd)) {
      return { blocked: true, reason: `Commande bloquée (pattern dangereux): ${cmd.slice(0, 60)}` };
    }
  }
  return { blocked: false };
}

function safeRunCommand(command) {
  const check = sanitizeCommand(command);
  if (check.blocked) {
    console.warn(`[intentRouter] BLOCKED: ${check.reason}`);
    return steps(step('run_command', { command: 'echo "Commande bloquée pour raison de sécurité"' }, 'Bloqué'));
  }
  return steps(step('run_command', { command }, `Shell: ${command}`));
}

// Normalise une app : "vscode" → "Visual Studio Code", "safari" → "Safari", etc.
function normalizeApp(raw = '') {
  const map = {
    vscode: 'Visual Studio Code', 'vs code': 'Visual Studio Code', 'vs-code': 'Visual Studio Code',
    safari: 'Safari', chrome: 'Google Chrome', firefox: 'Firefox',
    terminal: 'Terminal', finder: 'Finder', spotify: 'Spotify',
    slack: 'Slack', discord: 'Discord', zoom: 'Zoom',
    mail: 'Mail', notes: 'Notes', calendar: 'Calendar',
    photos: 'Photos', music: 'Music', 'app store': 'App Store',
    xcode: 'Xcode', figma: 'Figma', sketch: 'Sketch',
  };
  const key = raw.toLowerCase().trim();
  return map[key] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Extrait une URL depuis le texte (avec ou sans https://)
function extractUrl(text) {
  const withProto = text.match(/https?:\/\/[^\s]+/i);
  if (withProto) return withProto[0];
  const domain = text.match(/(?:sur|on|url|site)\s+([a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i);
  if (domain) return 'https://' + domain[1];
  const raw = text.match(/\b([a-z0-9-]+\.(?:com|fr|org|io|net|dev|app|ai)(?:\/[^\s]*)?)\b/i);
  if (raw) return 'https://' + raw[1];
  return null;
}

// ─── Catalogue de règles ──────────────────────────────────────────────────────
const RULES = [

  // ── Screenshot ─────────────────────────────────────────────────────────────
  {
    test: /screenshot|capture\s*d['']?écran|prends?\s+(une\s+)?capture|prends?\s+un\s+screenshot/i,
    build: () => steps(step('take_screenshot', {}, 'Capture écran')),
  },

  // ── Screenshot + analyse vision ────────────────────────────────────────────
  {
    test: /screenshot.*(analys|regarde|lis|que\s+vois|qu['']est.ce|décris)/i,
    build: () => steps(
      step('take_screenshot', {}, 'Capture écran'),
      step('run_command', { command: 'ls /tmp/laruche_screenshot.png' }, 'Vérifier screenshot'),
    ),
  },

  // ── Ouvrir application ─────────────────────────────────────────────────────
  {
    test: /(?:ouvre?|lance?|démarre?|start|open)\s+(?:l['']?app(?:lication)?\s+)?(?:de\s+)?(vscode|vs\s*code|safari|chrome|firefox|terminal|finder|spotify|slack|discord|zoom|mail|notes|calendar|photos|music|xcode|figma|sketch|[\w\s]+?)(?:\s*$|\s+(?:dans|sur|avec|et))/i,
    build: (m) => steps(step('open_app', { app: normalizeApp(m[1]) }, `Ouvrir ${m[1]}`)),
  },

  // ── Ouvrir VSCode ──────────────────────────────────────────────────────────
  {
    test: /(?:ouvre?|lance?)\s+(?:vscode?|vs\s*code)/i,
    build: () => steps(step('open_app', { app: 'Visual Studio Code' }, 'Ouvrir VSCode')),
  },

  // ── Ouvrir Safari ─────────────────────────────────────────────────────────
  {
    test: /(?:ouvre?|lance?)\s+safari/i,
    build: () => steps(step('open_app', { app: 'Safari' }, 'Ouvrir Safari')),
  },

  // ── Ouvrir Terminal ────────────────────────────────────────────────────────
  {
    test: /(?:ouvre?|lance?)\s+(?:le\s+)?terminal/i,
    build: () => steps(step('open_app', { app: 'Terminal' }, 'Ouvrir Terminal')),
  },

  // ── Naviguer vers URL ──────────────────────────────────────────────────────
  {
    test: /(?:va\s+sur|ouvre?|navigue?|go\s+to|navigate\s+to|open)\s+(https?:\/\/[^\s]+|[\w-]+\.(?:com|fr|org|io|net|dev|app|ai)[^\s]*)/i,
    build: (m) => {
      const url = m[1].startsWith('http') ? m[1] : 'https://' + m[1];
      return steps(step('goto_url', { url }, `Naviguer vers ${url}`));
    },
  },

  // ── YouTube recherche ─────────────────────────────────────────────────────
  {
    test: /(?:cherche?|joue?|mets?|lance?|recherche?|play|search)\s+(.+?)\s+(?:sur\s+)?youtube/i,
    build: (m) => steps(
      step('goto_url', { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }, `YouTube: ${m[1]}`),
    ),
  },
  {
    test: /youtube.+?(?:cherche?|joue?|mets?|lance?|recherche?|play|search)\s+(.+)/i,
    build: (m) => steps(
      step('goto_url', { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }, `YouTube: ${m[1]}`),
    ),
  },

  // ── Google Search ─────────────────────────────────────────────────────────
  {
    test: /(?:cherche?|recherche?|google?|search)\s+(.+?)(?:\s+sur\s+google)?$/i,
    build: (m) => steps(
      step('goto_url', { url: `https://www.google.com/search?q=${encodeURIComponent(m[1])}` }, `Google: ${m[1]}`),
    ),
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  {
    test: /ouvre?\s+(?:mon\s+)?github/i,
    build: () => steps(step('goto_url', { url: 'https://github.com' }, 'Ouvrir GitHub')),
  },

  // ── Exécuter commande shell ────────────────────────────────────────────────
  {
    test: /(?:exécute?|lance?|run|fais?\s+un\s+|tape?\s+dans\s+(?:le\s+)?terminal)\s+(?:la\s+commande?\s+)?["`'"]?([^"`'"]{3,})["`'"]?/i,
    build: (m) => safeRunCommand(m[1].trim()),
  },

  // ── Lister fichiers ────────────────────────────────────────────────────────
  {
    test: /(?:liste?|list|montre?|affiche?)\s+(?:les\s+)?(?:(?:\d+|cinq|dix)\s+)?(?:gros|grands?|lourds?|big|large)\s+fichiers?/i,
    build: (m, text) => {
      const numMatch = text.match(/(\d+)/);
      const limit = numMatch ? parseInt(numMatch[1]) : 10;
      return steps(step('list_big_files', { dir: '.', limit }, `Top ${limit} gros fichiers`));
    },
  },
  {
    test: /(?:liste?|list|ls)\s+(?:les\s+)?fichiers?(?:\s+du\s+(?:projet|dossier|répertoire))?/i,
    build: (m, text) => {
      const dirMatch = text.match(/(?:dans?|du\s+dossier|of)\s+([^\s]+)/i);
      const dir = dirMatch ? dirMatch[1].replace(/[^a-zA-Z0-9_.\/\-]/g, '') : '.';
      return steps(step('run_command', { command: `ls -la ${dir}` }, 'Lister fichiers'));
    },
  },

  // ── Lire fichier ──────────────────────────────────────────────────────────
  {
    test: /(?:lis?|lire|affiche?|montre?|cat|read)\s+(?:le\s+)?(?:fichier\s+)?([^\s]+\.(?:js|ts|jsx|tsx|py|json|md|txt|env|yaml|yml|sh|css|html))/i,
    build: (m) => steps(step('read_file', { path: m[1] }, `Lire ${m[1]}`)),
  },

  // ── Résumé projet ─────────────────────────────────────────────────────────
  {
    test: /(?:résume?|summarize?|analyse?|explique?)\s+(?:le\s+)?(?:projet|architecture|code|codebase)/i,
    build: (m, text) => {
      const dirMatch = text.match(/(?:dans?|of|du\s+projet)\s+([^\s]+)/i);
      return steps(step('summarize_project', { dir: dirMatch ? dirMatch[1] : '.' }, 'Résumé projet'));
    },
  },

  // ── Taper du texte ────────────────────────────────────────────────────────
  {
    test: /(?:tape?|écris?|write|type)\s+["`'"]([^"`'"]+)["`'"]/i,
    build: (m) => steps(step('type_text', { text: m[1] }, `Taper: ${m[1]}`)),
  },
  {
    test: /(?:tape?|écris?|write|type)\s+(?:le\s+texte\s+)?["`'"]?(.{3,60})["`'"]?\s*(?:dans|in|sur)?\s*$/i,
    build: (m) => steps(step('type_text', { text: m[1].trim() }, `Taper: ${m[1]}`)),
  },

  // ── Appuyer touche ────────────────────────────────────────────────────────
  {
    test: /(?:appuie?|presse?|press|touche)\s+(?:sur\s+)?(?:la\s+touche\s+)?(entrée|enter|return|espace|space|escape|echap|tab|retour)/i,
    build: (m) => {
      const km = { entrée:'Return',enter:'Return',return:'Return',espace:'Space',space:'Space',escape:'Escape',echap:'Escape',tab:'Tab',retour:'Return' };
      const key = km[m[1].toLowerCase()] || 'Return';
      return steps(step('press_key', { key }, `Touche ${key}`));
    },
  },

  // ── Entrée ────────────────────────────────────────────────────────────────
  {
    test: /(?:appuie?|presse?)\s+(?:sur\s+)?entrée|press\s+enter/i,
    build: () => steps(step('press_enter', {}, 'Touche Entrée')),
  },

  // ── Fetch HTTP ────────────────────────────────────────────────────────────
  {
    test: /(?:fais?\s+un?\s+)?(?:get|post|fetch|appel|requête)\s+(?:http\s+)?(?:sur\s+)?(https?:\/\/[^\s]+)/i,
    build: (m) => steps(step('http_fetch', { url: m[1] }, `HTTP GET ${m[1]}`)),
  },

  // ── Git status / log ──────────────────────────────────────────────────────
  {
    test: /(?:git\s+status|(?:montre?|affiche?|donne?|git\s+)?status\s+(?:git|du\s+repo))/i,
    build: () => steps(step('run_command', { command: 'git status' }, 'Git status')),
  },
  {
    test: /git\s+log|historique\s+(?:git|des\s+commits)/i,
    build: () => steps(step('run_command', { command: 'git log --oneline -10' }, 'Git log')),
  },
  {
    test: /git\s+diff/i,
    build: () => steps(step('run_command', { command: 'git diff --stat' }, 'Git diff')),
  },

  // ── Espace disque ─────────────────────────────────────────────────────────
  {
    test: /espace\s+(?:disque|libre|disponible)|disk\s+space|df\s+/i,
    build: () => steps(step('run_command', { command: 'df -h' }, 'Espace disque')),
  },

  // ── Processus ─────────────────────────────────────────────────────────────
  {
    test: /(?:processus|process|ps\s+|qui\s+tourne)/i,
    build: () => steps(step('run_command', { command: 'ps aux | head -20' }, 'Processus actifs')),
  },

  // ── Semantic Computer-Use : lire l'écran ───────────────────────────────────
  {
    test: /(?:lis?|lire?|analys|regarde|affiche|montre|donne|quels?\s+sont|qu['']est.ce\s+qui\s+(?:est|apparaît))\s+(?:sur\s+)?(?:l['']?écran|screen|interface|fenêtre)/i,
    build: () => steps(step('screen_elements', {}, 'Lire éléments écran')),
  },
  {
    test: /(?:éléments?|buttons?|boutons?|champs?)\s+(?:sur\s+)?(?:l['']?écran|screen|interface|de\s+l['']?app)/i,
    build: () => steps(
      step('screen_elements', {}, 'Éléments UI'),
    ),
  },

  // ── Semantic Computer-Use : trouver un élément ─────────────────────────────
  {
    test: /(?:trouve?|cherche?|find|locate|où\s+est)\s+(?:le\s+|la\s+|l['']?|un\s+|une\s+)?(?:bouton|button|champ|field|lien|link|case|checkbox|menu)?\s*["`'"]([^"`'"]{2,50})["`'"]/i,
    build: (m) => steps(step('find_element', { query: m[1].trim() }, `Trouver: ${m[1]}`)),
  },
  {
    test: /(?:trouve?|cherche?|find|locate)\s+(?:l['']?élément|the\s+element)\s+(.{3,50})/i,
    build: (m) => steps(step('find_element', { query: m[1].trim() }, `Trouver: ${m[1]}`)),
  },

  // ── Semantic Computer-Use : cliquer par label ──────────────────────────────
  {
    test: /(?:clique?|click|appuie?|presse?)\s+(?:sur\s+)?(?:le\s+|la\s+|l['']?)?(?:bouton\s+)?["`'"]([^"`'"]{2,50})["`'"]/i,
    build: (m) => steps(step('smart_click', { query: m[1].trim() }, `Cliquer: ${m[1]}`)),
  },
  {
    test: /(?:clique?|click)\s+(?:sur\s+)?(?:le\s+bouton\s+|la\s+)(.{3,40}?)(?:\s*$|\s+(?:dans|de|du))/i,
    build: (m) => steps(step('smart_click', { query: m[1].trim() }, `Cliquer: ${m[1]}`)),
  },

  // ── Semantic Computer-Use : attendre élément ───────────────────────────────
  {
    test: /(?:attends?|wait)\s+(?:que?\s+)?(?:l['']?élément|the\s+element|que?\s+)?["`'"]([^"`'"]{2,50})["`'"](?:\s+apparaisse?|appear)/i,
    build: (m) => steps(step('wait_for_element', { query: m[1].trim(), timeout: 10 }, `Attendre: ${m[1]}`)),
  },

  // ── Liste des skills disponibles ──────────────────────────────────────────
  {
    test: /(?:liste?|list|affiche?|montre?|quels?\s+sont)\s+(?:les\s+)?skills?(?:\s+disponibles?)?|skills?\s+(?:disponibles?|dispo|actifs?)/i,
    build: () => steps(step('http_fetch', { url: 'http://localhost:3000/api/skills' }, 'Liste skills disponibles')),
  },

  // ── État / status du système ───────────────────────────────────────────────
  {
    test: /(?:état|status|santé|health)\s+(?:du\s+)?(?:système|system|server|serveur|laruche|la\s+ruche|queen)/i,
    build: () => steps(step('http_fetch', { url: 'http://localhost:3000/api/status' }, 'État du système')),
  },

  // ── Semantic Computer-Use : lire arbre AX ─────────────────────────────────
  {
    test: /(?:arbre\s+ax|accessibility\s+tree|ax\s+tree|éléments?\s+accessibility)/i,
    build: () => steps(step('accessibility_reader', {}, 'Arbre AX')),
  },

  // ── Screenshot + analyse sémantique ───────────────────────────────────────
  {
    test: /(?:capture|screenshot)\s+(?:et\s+)?(?:lis?|lire|analyse?|explique?|décris?)/i,
    build: () => steps(
      step('take_screenshot', {}, 'Screenshot'),
      step('screen_elements', {}, 'Analyse éléments'),
    ),
  },
];

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Tente de résoudre l'intention par règles.
 * @returns {{ plan: Plan, matched: boolean }}
 */
export function routeByRules(text) {
  const normalized = text.trim();

  for (const rule of RULES) {
    const match = normalized.match(rule.test);
    if (match) {
      const built = rule.build(match, normalized);
      if (built && built.length > 0) {
        return {
          matched: true,
          plan: {
            goal: normalized,
            steps: built,
            confidence: 1.0,
            source: 'rules',
          },
        };
      }
    }
  }

  return { matched: false, plan: null };
}

/**
 * Vérifie si une intention est une commande ordinateur (vs query texte)
 */
export function isActionIntent(text) {
  return RULES.some(r => r.test.test(text));
}
