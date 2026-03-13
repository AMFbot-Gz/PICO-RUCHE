"""
claude_architecte.py — Claude claude-opus-4-6 comme Architecte de Ruche
Reçoit les messages Telegram, appelle les APIs PICO-RUCHE via tool use,
apprend et sauvegarde des scripts réutilisables pour les agents locaux.

Aucun Ollama, aucun sous-agent, aucun screenshot inutile.
Claude agit comme cerveau + bras via les APIs.
"""
import asyncio
import json
import os
import re
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import anthropic

# ─── Config ────────────────────────────────────────────────────────────────────

CLAUDE_MODEL = "claude-opus-4-6"
ROOT = Path(__file__).resolve().parent.parent

PORTS = {
    "queen_node": 3000,
    "queen":      8001,
    "perception": 8002,
    "brain":      8003,
    "executor":   8004,
    "evolution":  8005,
    "memory":     8006,
    "mcp_bridge": 8007,
}

# Prompt de base — complété dynamiquement avec l'état live au moment de chaque appel (C2)
SYSTEM_PROMPT_BASE = """Tu es l'Architecte de Ruche — Claude claude-opus-4-6 branché sur LaRuche v4.1, un système d'agents IA locaux sur macOS.

## Ce que tu peux faire via tes outils

Tu contrôles LaRuche en appelant ses APIs. Tu n'as pas besoin du code source — tu as les outils.

**Outils disponibles :**
- `get_ruche_status` — état de toutes les couches (ports 3000, 8001-8007)
- `launch_mission` — lancer une mission autonome sur le Mac
- `list_skills` — voir les skills MCP disponibles
- `execute_shell` — exécuter une commande shell sécurisée (sandboxée)
- `open_app` / `goto_url` — contrôle macOS basique
- `computer_use_screenshot` — screenshot UNIQUEMENT quand tu ne comprends pas l'état de l'écran
- `computer_use_click` / `computer_use_type` — actions GUI par label sémantique
- `get_recent_memory` — voir les derniers épisodes pour apprendre du passé
- `save_skill_script` — écrire un script réutilisable dans la mémoire des agents locaux
- `save_memory_episode` — enregistrer ce qui a été appris après une action

## Règles

1. **Agis directement** — utilise les outils, ne discute pas
2. **Évite les screenshots** — utilise `get_ruche_status` d'abord, screenshot seulement si tu es bloqué
3. **Apprends** — après une action réussie, utilise `save_skill_script` pour écrire le script générique
4. **Sois concis** dans tes réponses Telegram (max 500 chars, Markdown OK)
5. **Si une couche est offline** — dis-le et propose comment la relancer
6. **Réponds en français**
"""

# ─── Définitions des outils ────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "get_ruche_status",
        "description": "Obtient l'état de toutes les couches de LaRuche. À appeler en premier pour comprendre la situation.",
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "launch_mission",
        "description": "Lance une mission autonome via la ruche. Pour toute action sur le Mac ou tâche complexe.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Description en français de la mission"},
                "priority": {"type": "integer", "description": "Priorité 1=haute 2=normale 3=basse", "default": 2}
            },
            "required": ["command"]
        }
    },
    {
        "name": "list_skills",
        "description": "Liste tous les skills MCP disponibles dans la ruche avec leur description.",
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "execute_shell",
        "description": "Exécute une commande shell sécurisée via le sandbox executor. Commandes dangereuses bloquées automatiquement.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Commande shell à exécuter"}
            },
            "required": ["command"]
        }
    },
    {
        "name": "open_app",
        "description": "Ouvre une application macOS par son nom.",
        "input_schema": {
            "type": "object",
            "properties": {
                "app_name": {"type": "string", "description": "Nom de l'app (ex: Safari, Terminal, Finder, Xcode)"}
            },
            "required": ["app_name"]
        }
    },
    {
        "name": "goto_url",
        "description": "Ouvre une URL dans Safari.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL à ouvrir"}
            },
            "required": ["url"]
        }
    },
    {
        "name": "computer_use_screenshot",
        "description": "Prend un screenshot du Mac. Utiliser SEULEMENT quand tu dois voir l'état visuel de l'écran et que tu n'as pas d'autre moyen de le savoir.",
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "computer_use_click",
        "description": "Clique sur un élément de l'interface macOS en le désignant par son label sémantique. Plus fiable que les coordonnées.",
        "input_schema": {
            "type": "object",
            "properties": {
                "element_label": {"type": "string", "description": "Label de l'élément UI à cliquer (ex: 'bouton Envoyer', 'champ URL')"}
            },
            "required": ["element_label"]
        }
    },
    {
        "name": "computer_use_type",
        "description": "Tape du texte dans l'interface macOS active.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Texte à taper"}
            },
            "required": ["text"]
        }
    },
    {
        "name": "get_recent_memory",
        "description": "Récupère les derniers épisodes de mémoire de la ruche pour apprendre des actions passées et éviter les erreurs.",
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Nombre d'épisodes à récupérer", "default": 5}
            },
            "required": []
        }
    },
    {
        "name": "save_skill_script",
        "description": "Sauvegarde un script réutilisable dans la mémoire locale des agents. Appeler après avoir résolu un problème pour entraîner les agents locaux avec du bon code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Nom du skill en snake_case (ex: open_browser_url)"},
                "description": {"type": "string", "description": "Ce que fait ce skill en une phrase"},
                "code": {"type": "string", "description": "Code JavaScript (ES module) du skill — export async function run(params)"},
                "learned_from": {"type": "string", "description": "Mission qui a mené à cet apprentissage"}
            },
            "required": ["name", "description", "code"]
        }
    },
    {
        "name": "save_memory_episode",
        "description": "Enregistre un épisode dans la mémoire épisodique de la ruche. À appeler après chaque action importante pour construire la mémoire des agents.",
        "input_schema": {
            "type": "object",
            "properties": {
                "mission":  {"type": "string", "description": "Description de ce qui a été demandé"},
                "result":   {"type": "string", "description": "Ce qui s'est passé"},
                "success":  {"type": "boolean"},
                "learned":  {"type": "string", "description": "Leçon apprise (pour les agents futurs)"}
            },
            "required": ["mission", "result", "success"]
        }
    },
]


# ─── Exécuteurs d'outils ────────────────────────────────────────────────────────

async def _fetch(method: str, url: str, **kwargs) -> dict:
    """Appel HTTP vers les APIs de la ruche — retourne dict avec _error si KO."""
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await getattr(c, method)(url, **kwargs)
            r.raise_for_status()
            ct = r.headers.get("content-type", "")
            if "json" in ct:
                return r.json()
            return {"text": r.text[:2000], "status": r.status_code}
    except httpx.ConnectError:
        return {"_error": f"couche offline — {url.split('/')[2]}"}
    except Exception as e:
        return {"_error": str(e)[:200]}


async def tool_get_ruche_status(_: dict) -> dict:
    """Checks toutes les couches en parallèle — P0.2 côté Claude Architecte."""
    layer_urls = {
        "queen_node": f"http://localhost:{PORTS['queen_node']}/api/health",
        "queen":      f"http://localhost:{PORTS['queen']}/health",
        "perception": f"http://localhost:{PORTS['perception']}/health",
        "brain":      f"http://localhost:{PORTS['brain']}/health",
        "executor":   f"http://localhost:{PORTS['executor']}/health",
        "evolution":  f"http://localhost:{PORTS['evolution']}/health",
        "memory":     f"http://localhost:{PORTS['memory']}/health",
        "mcp_bridge": f"http://localhost:{PORTS['mcp_bridge']}/health",
    }
    names = list(layer_urls.keys())
    checks = await asyncio.gather(
        *[_fetch("get", url) for url in layer_urls.values()],
        return_exceptions=True,
    )
    results = {
        name: (r if not isinstance(r, Exception) else {"_error": str(r)})
        for name, r in zip(names, checks)
    }
    brain = results.get("brain", {})
    online = sum(1 for v in results.values() if v.get("status") == "ok")
    return {
        "layers": results,
        "online": f"{online}/{len(results)}",
        "active_llm_provider": brain.get("active_provider", "unknown"),
        "llm_providers": brain.get("providers", {}),
    }


async def tool_launch_mission(inp: dict) -> dict:
    # Via Node.js queen :3000 en priorité, fallback Python queen :8001
    r = await _fetch("post", f"http://localhost:{PORTS['queen_node']}/api/mission",
                     json={"mission": inp["command"], "priority": inp.get("priority", 2)})
    if "_error" in r:
        r = await _fetch("post", f"http://localhost:{PORTS['queen']}/mission",
                         json={"command": inp["command"], "priority": inp.get("priority", 2)})
    return r


async def tool_list_skills(_: dict) -> dict:
    r = await _fetch("get", f"http://localhost:{PORTS['queen_node']}/api/skills")
    return r if not isinstance(r, list) else {"skills": r, "count": len(r)}


async def tool_execute_shell(inp: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['executor']}/shell",
                        json={"command": inp["command"]})


async def tool_open_app(inp: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['queen_node']}/mcp/os-control",
                        json={"action": "openApp", "app": inp["app_name"]})


async def tool_goto_url(inp: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['queen_node']}/mcp/os-control",
                        json={"action": "gotoUrl", "url": inp["url"]})


async def tool_screenshot(_: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['queen_node']}/mcp/os-control",
                        json={"action": "screenshot"})


async def tool_click(inp: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['queen_node']}/mcp/os-control",
                        json={"action": "smartClick", "element": inp["element_label"]})


async def tool_type(inp: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['queen_node']}/mcp/os-control",
                        json={"action": "typeText", "text": inp["text"]})


async def tool_get_memory(inp: dict) -> dict:
    limit = inp.get("limit", 5)
    return await _fetch("get", f"http://localhost:{PORTS['memory']}/episodes?limit={limit}")


async def tool_save_skill(inp: dict) -> dict:
    """Écrit un skill réutilisable dans skills/ et met à jour registry.json."""
    name = re.sub(r"[^a-z0-9_]", "_", inp["name"].lower())[:40]
    skill_dir = ROOT / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)

    # skill.js
    skill_js = skill_dir / "skill.js"
    skill_js.write_text(inp["code"], encoding="utf-8")

    # manifest.json compact
    manifest = {
        "name": name,
        "description": inp["description"],
        "version": "1.0.0",
        "tier": "learned",
        "learned_from": inp.get("learned_from", "Claude Architecte"),
        "created": datetime.now().isoformat(),
        "author": "claude-architecte"
    }
    (skill_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # Mise à jour registry.json
    registry_path = ROOT / "skills" / "registry.json"
    try:
        registry = json.loads(registry_path.read_text()) if registry_path.exists() else {"version": "1.1.0", "skills": []}
    except Exception:
        registry = {"version": "1.1.0", "skills": []}
    registry["skills"] = [s for s in registry.get("skills", []) if s.get("name") != name]
    registry["skills"].append(manifest)
    registry["lastUpdated"] = datetime.now().isoformat()
    registry_path.write_text(json.dumps(registry, indent=2), encoding="utf-8")

    return {"success": True, "skill": name, "path": str(skill_dir), "files": ["skill.js", "manifest.json"]}


async def tool_save_episode(inp: dict) -> dict:
    return await _fetch("post", f"http://localhost:{PORTS['memory']}/episode",
                        json={
                            "mission":    inp["mission"],
                            "result":     inp["result"],
                            "success":    inp["success"],
                            "duration_ms": 0,
                            "model_used": CLAUDE_MODEL,
                            "skills_used": [],
                            "learned":    inp.get("learned", "")
                        })


# ─── Dispatch outils ───────────────────────────────────────────────────────────

TOOL_HANDLERS = {
    "get_ruche_status":       tool_get_ruche_status,
    "launch_mission":         tool_launch_mission,
    "list_skills":            tool_list_skills,
    "execute_shell":          tool_execute_shell,
    "open_app":               tool_open_app,
    "goto_url":               tool_goto_url,
    "computer_use_screenshot": tool_screenshot,
    "computer_use_click":     tool_click,
    "computer_use_type":      tool_type,
    "get_recent_memory":      tool_get_memory,
    "save_skill_script":      tool_save_skill,
    "save_memory_episode":    tool_save_episode,
}

async def execute_tool(name: str, inp: dict) -> Any:
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return {"_error": f"Outil inconnu: {name}"}
    try:
        return await handler(inp)
    except Exception as e:
        return {"_error": str(e)[:300]}


# ─── Boucle agentique Claude ───────────────────────────────────────────────────

class ClaudeArchitecte:
    """Architecte de Ruche — Claude branché sur les APIs PICO-RUCHE."""

    def __init__(self):
        self._client: anthropic.AsyncAnthropic | None = None
        self._history: list[dict] = []   # Historique de conversation (glissant)
        self._max_history = 20           # Garde les 20 derniers échanges
        # Cache du system prompt enrichi — reconstruit toutes les 60s (C2)
        self._system_prompt_cache: str = ""
        self._system_prompt_ts: datetime = datetime.min.replace(tzinfo=timezone.utc)

    async def _build_system_prompt(self) -> str:
        """Construit le system prompt avec l'état live de la ruche (C2).
        Le résultat est mis en cache 60s pour éviter trop de requêtes."""
        now = datetime.now(timezone.utc)
        if (now - self._system_prompt_ts).total_seconds() < 60 and self._system_prompt_cache:
            return self._system_prompt_cache

        state_ctx = ""
        try:
            async with httpx.AsyncClient(timeout=4) as c:
                r = await c.get(f"http://localhost:{PORTS['queen']}/status")
                state = r.json()
            layers = state.get("layers", {})
            online = sum(1 for v in layers.values() if v.get("status") == "ok")
            total = len(layers)
            provider = layers.get("brain", {}).get("active_provider", "?")
            hitl_n = state.get("hitl_pending", 0)
            offline = [n for n, v in layers.items() if v.get("status") != "ok"]

            state_ctx = (
                f"\n\n## État actuel de la ruche ({now.strftime('%H:%M')} UTC)\n"
                f"- Couches actives: {online}/{total}\n"
                f"- Provider LLM: **{provider}**\n"
                f"- HITL en attente: {hitl_n}\n"
            )
            if offline:
                state_ctx += f"- ⚠️ Offline: {', '.join(offline)}\n"
                state_ctx += "- Si une couche est offline, propose `python3 start_agent.py` ou la commande de restart.\n"
        except Exception:
            pass  # Si le status est inaccessible, on continue sans contexte live

        prompt = SYSTEM_PROMPT_BASE + state_ctx
        self._system_prompt_cache = prompt
        self._system_prompt_ts = now
        return prompt

    def _get_client(self) -> anthropic.AsyncAnthropic:
        if self._client is None:
            key = os.environ.get("ANTHROPIC_API_KEY", "")
            if not key:
                raise ValueError("ANTHROPIC_API_KEY manquant dans .env")
            self._client = anthropic.AsyncAnthropic(api_key=key)
        return self._client

    @staticmethod
    def _serialize_content(content) -> list:
        """Convertit les SDK content blocks en dicts purs — supprime les thinking blocks."""
        result = []
        for block in content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                if block.text:  # ignore les text blocks vides
                    result.append({"type": "text", "text": block.text})
            elif block_type == "tool_use":
                result.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
            # thinking blocks ignorés — ils ne peuvent pas être renvoyés sans mode thinking actif
        return result

    async def handle_message(self, user_text: str) -> str:
        """Point d'entrée principal — reçoit un message Telegram, retourne la réponse."""
        client = self._get_client()
        # C2 — system prompt avec état live (cached 60s)
        system_prompt = await self._build_system_prompt()
        self._history.append({"role": "user", "content": user_text})

        for turn in range(8):
            print(f"[ClaudeArchitecte] Tour {turn+1} — appel Claude...")
            try:
                response = await asyncio.wait_for(
                    client.messages.create(
                        model=CLAUDE_MODEL,
                        max_tokens=2048,
                        system=system_prompt,
                        tools=TOOLS,
                        messages=self._history[-self._max_history:],
                    ),
                    timeout=90.0
                )
            except asyncio.TimeoutError:
                print(f"[ClaudeArchitecte] Timeout tour {turn+1}")
                return "⏱ Timeout — réessaie."
            except Exception as api_err:
                print(f"[ClaudeArchitecte] Erreur API tour {turn+1}: {api_err}")
                return f"❌ Erreur Claude: `{str(api_err)[:200]}`"

            # Réponse finale
            if response.stop_reason == "end_turn":
                text = next((b.text for b in response.content if b.type == "text"), "")
                # Historique : sérialise en dicts purs, pas d'objets SDK
                self._history.append({
                    "role": "assistant",
                    "content": self._serialize_content(response.content)
                })
                return self._format_for_telegram(text)

            # Appels d'outils
            if response.stop_reason == "tool_use":
                tool_uses = [b for b in response.content if b.type == "tool_use"]

                results = await asyncio.gather(
                    *[execute_tool(t.name, t.input) for t in tool_uses],
                    return_exceptions=True
                )

                tool_results = []
                for tool_block, result in zip(tool_uses, results):
                    if isinstance(result, Exception):
                        result = {"_error": str(result)}
                    print(f"[ClaudeArchitecte] Tool {tool_block.name}: {str(result)[:100]}")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_block.id,
                        # Limite la taille des résultats pour éviter les gros payloads
                        "content": json.dumps(result, ensure_ascii=False, default=str)[:1500],
                    })

                # Historique en dicts purs — critique pour éviter le blocage Tour 2
                self._history.append({
                    "role": "assistant",
                    "content": self._serialize_content(response.content)
                })
                self._history.append({"role": "user", "content": tool_results})
            else:
                break

        return "⚠️ Boucle interrompue."

    def _format_for_telegram(self, text: str) -> str:
        """Formate la réponse pour Telegram — tronque si trop longue."""
        if len(text) <= 4000:
            return text
        # Coupe proprement au dernier saut de ligne
        truncated = text[:3900]
        last_nl = truncated.rfind("\n")
        if last_nl > 3000:
            truncated = truncated[:last_nl]
        return truncated + "\n\n_(réponse tronquée — demande la suite)_"

    def reset_history(self):
        """Réinitialise l'historique de conversation."""
        self._history = []


# ─── Instance singleton ────────────────────────────────────────────────────────

_architecte: ClaudeArchitecte | None = None

def get_architecte() -> ClaudeArchitecte:
    global _architecte
    if _architecte is None:
        _architecte = ClaudeArchitecte()
    return _architecte
