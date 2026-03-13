# LaRuche — Contrôleur Agentique Sémantique Computer-Use (CASCU)

## Identité

LaRuche v5.0.0 est un **système multi-agents IA 100% local** qui transforme un Mac en un **contrôleur agentique sémantique** capable d'exécuter n'importe quelle tâche informatique de façon autonome.

Ce n'est **pas** un chatbot. C'est un **agent d'action** qui perçoit, planifie, agit et vérifie.

---

## Architecture Agentique

```
Requête utilisateur
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  ROUTEUR DÉTERMINISTE (intentRouter.js)             │  ← 0ms, 0 LLM, 40+ règles
│  → Screen read, find element, smart click, etc.     │
└──────────────────────┬──────────────────────────────┘
                       │ (si inconnu)
                       ▼
┌─────────────────────────────────────────────────────┐
│  PLANNER LLM (planner.js)                           │  ← llama3.2:3b, ~1-2s
│  → Plan JSON: [{skill, params}]                     │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  EXECUTOR (executor.js)                             │  ← timeout/retry/fallback
│  → Exécute chaque step avec le skill natif macOS    │
└─────────────────────────────────────────────────────┘
```

---

## Couche Sémantique Computer-Use (NOUVEAU)

La différence entre LaRuche et un simple bot de clics pixels :

| Classique | LaRuche Sémantique |
|-----------|-------------------|
| `click(x=452, y=318)` | `smart_click("bouton Envoyer")` |
| Casse si la fenêtre bouge | Fonctionne quelle que soit la position |
| Dépend de la résolution | Indépendant de la résolution |
| Nécessite des coords | Comprend le contexte UI |

### Stack Open Source Utilisé

| Composant | Source | Usage |
|-----------|--------|-------|
| **macOS AXUIElement** | Apple (natif, 0 deps) | Lecture arbre UI sémantique |
| **osascript / System Events** | Apple (natif) | Traversal AX, actions UI |
| **pyautogui** | MIT | Click, keyboard, screenshot |
| **AppKit / NSWorkspace** | pyobjc (MIT) | Apps actives, fenêtres |
| **Quartz** | pyobjc (MIT) | Capture écran, coords |
| **Ollama** | MIT | LLM local (llama3, llava) |
| **Playwright** | Apache 2.0 | Browser automation |

---

## Skills Disponibles

### 🔍 Perception Sémantique
- **`screen_elements`** — Vue d'ensemble complète : app active, tous éléments UI (buttons, text_fields, checkboxes) avec positions
- **`accessibility_reader`** — Arbre AX brut de n'importe quelle app
- **`take_screenshot`** — Capture PNG via screencapture macOS

### 🎯 Action Sémantique
- **`find_element`** — Trouver un élément par description naturelle
- **`smart_click`** — Cliquer par label sémantique (pas de coordonnées)
- **`wait_for_element`** — Attendre l'apparition d'un élément (après navigation)
- **`type_text`** — Taper du texte via System Events
- **`press_key / press_enter`** — Actions clavier

### 🖥️ Control macOS
- **`open_app`** — Ouvrir n'importe quelle app par nom
- **`goto_url`** — Naviguer vers une URL
- **`run_command`** — Shell (liste blanche)

### 📁 Filesystem & Network
- **`read_file`** — Lire un fichier
- **`list_big_files`** — Trouver les gros fichiers
- **`http_fetch`** — Requêtes HTTP
- **`summarize_project`** — Résumé d'un projet

---

## Pipeline d'Exécution : Perceive → Plan → Act → Verify

```
1. PERCEIVE
   screen_elements() → {app: "Safari", elements: [{role: "button", title: "Envoyer", x: 460, y: 340}]}

2. PLAN
   Goal: "Cliquer sur le bouton Envoyer"
   Steps: [{ skill: "smart_click", params: { query: "bouton Envoyer" } }]

3. ACT
   smart_click("bouton Envoyer")
   → find_element via AX tree
   → pyautogui.click(460, 357)
   → { success: true, clicked: "Envoyer", confidence: 0.95 }

4. VERIFY
   take_screenshot() + analyze = "Le formulaire a été soumis"
```

---

## Agents de la Ruche

| Agent | Modèle | Spécialité |
|-------|--------|-----------|
| **Stratège** | llama3:latest | Décomposition, planification |
| **Architecte** | llama3.2:3b | Code, debug, refactoring |
| **Ouvrière** | llama3.2:3b | Micro-tâches parallèles |
| **Vision** | llava:7b | Analyse screenshots, UI visuelle |
| **Computer-Use** | llama3.2:3b | Contrôle GUI macOS |
| **Synthèse** | llama3:latest | Fusion résultats multi-agents |

---

## Identité Injectée dans Chaque Agent

Chaque agent reçoit dans son `system_prompt` :
1. Sa définition complète de LaRuche CASCU
2. La liste exhaustive de ses skills avec descriptions
3. Le pipeline Perceive→Plan→Act→Verify
4. Son rôle spécifique et ses contraintes
5. Le contexte système actuel (heure, résolution, etc.)

Source : `src/context/agentIdentity.js`

---

## Optimisations Performances

| Technique | Gain | Activé |
|-----------|------|--------|
| `keep_alive: -1` | Modèles en RAM permanents | ✅ |
| `top_k: 20` | -50% calcul/token | ✅ |
| `f16_kv: true` | -50% RAM cache KV | ✅ |
| `num_predict: 700` | Stoppe sur-génération | ✅ |
| Fast path < 80 chars | 1 LLM call au lieu de N+2 | ✅ |
| Routeur déterministe | 0 LLM pour 40+ patterns | ✅ |
| AX tree vs vision | 10x plus rapide | ✅ |
| pHash cache | Évite re-analyse même écran | ✅ |

---

## Pour Aller Plus Loin

Ce qui manque encore pour être 100% "surpuissant" :
- [ ] OCR (Tesseract) pour lire du texte dans des images/PDFs
- [ ] Discord/Slack bot integration
- [ ] Auto-scroll + capture page complète
- [ ] Mémoire vectorielle (ChromaDB) pour rappel sémantique
- [ ] Agent de monitoring continu (watcher proactif)
