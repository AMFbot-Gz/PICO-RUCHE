#!/usr/bin/env python3
"""
export_context.py — Architecte de Ruche — Export du contexte Ghost OS
Génère ollama_system_context.md à injecter dans le Modelfile Ollama.

Usage:
    python scripts/export_context.py
    python scripts/export_context.py --out /tmp/custom_context.md
"""

import json
import asyncio
import argparse
import httpx
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent

# ─── Ports des couches ─────────────────────────────────────────────────────────
LAYERS = {
    "Queen Node.js": "http://localhost:3000/api/health",
    "Queen Python":  "http://localhost:8001/health",
    "Perception":    "http://localhost:8002/health",
    "Brain":         "http://localhost:8003/health",
    "Executor":      "http://localhost:8004/health",
    "Evolution":     "http://localhost:8005/health",
    "Memory":        "http://localhost:8006/health",
    "MCP Bridge":    "http://localhost:8007/health",
}
MEMORY_EPISODES_URL = "http://localhost:8006/episodes"
MEMORY_WORLD_URL    = "http://localhost:8006/world_state"
BRAIN_HEALTH_URL    = "http://localhost:8003/health"
SKILLS_URL          = "http://localhost:3000/api/skills"

IDENTITY_JS = ROOT / "src" / "context" / "agentIdentity.js"
OUTPUT_FILE = ROOT / "ollama_system_context.md"


async def fetch_json(client: httpx.AsyncClient, url: str, timeout: float = 3.0) -> dict:
    """Fetch JSON from a URL — retourne {} si inaccessible."""
    try:
        r = await client.get(url, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"_error": str(e), "_url": url}


def read_identity() -> str:
    """Extrait CORE_IDENTITY depuis agentIdentity.js (regex simple)."""
    if not IDENTITY_JS.exists():
        return "— agentIdentity.js introuvable —"
    text = IDENTITY_JS.read_text()
    # Extrait le contenu du template literal CORE_IDENTITY
    import re
    m = re.search(r"export const CORE_IDENTITY = `([\s\S]+?)`;", text)
    return m.group(1).strip() if m else "— CORE_IDENTITY non parsé —"


async def main(out: Path):
    ts = datetime.now().isoformat()
    lines: list[str] = []

    print(f"[export_context] Génération du contexte Ghost OS — {ts}")

    async with httpx.AsyncClient() as client:

        # ── 1. État des couches ────────────────────────────────────────────────
        print("  → Vérification des couches...")
        layer_tasks = {name: fetch_json(client, url) for name, url in LAYERS.items()}
        layer_results = {
            name: await task for name, task in layer_tasks.items()
        }

        lines.append(f"# Contexte Ghost OS — LaRuche v4.1")
        lines.append(f"_Généré le {ts}_\n")

        lines.append("## État des couches\n")
        lines.append("| Couche | Port | Statut |")
        lines.append("|--------|------|--------|")
        ports = {
            "Queen Node.js": 3000, "Queen Python": 8001, "Perception": 8002,
            "Brain": 8003, "Executor": 8004, "Evolution": 8005,
            "Memory": 8006, "MCP Bridge": 8007,
        }
        for name, data in layer_results.items():
            ok = "✅ OK" if "_error" not in data else f"❌ {data['_error'][:40]}"
            lines.append(f"| {name} | {ports[name]} | {ok} |")
        lines.append("")

        # ── 2. Fournisseur LLM actif (Brain) ──────────────────────────────────
        print("  → LLM provider actif...")
        brain = await fetch_json(client, BRAIN_HEALTH_URL)
        if "_error" not in brain:
            provider = brain.get("active_provider", "unknown")
            providers = brain.get("providers", {})
            lines.append("## Fournisseur LLM Actif\n")
            lines.append(f"- **Provider actif** : `{provider}`")
            for p, avail in providers.items():
                lines.append(f"- `{p}` : {'disponible' if avail else 'indisponible'}")
            lines.append("")

        # ── 3. Skills disponibles ──────────────────────────────────────────────
        print("  → Skills disponibles...")
        skills_data = await fetch_json(client, SKILLS_URL)
        if "_error" not in skills_data and isinstance(skills_data, list):
            lines.append("## Skills Ghost OS Disponibles\n")
            for s in skills_data[:20]:  # max 20 pour garder le contexte compact
                name_s = s.get("name", s) if isinstance(s, dict) else str(s)
                desc_s = s.get("description", "") if isinstance(s, dict) else ""
                lines.append(f"- **{name_s}** — {desc_s}" if desc_s else f"- `{name_s}`")
            if len(skills_data) > 20:
                lines.append(f"- _(+ {len(skills_data) - 20} autres skills)_")
            lines.append("")

        # ── 4. Épisodes mémoire récents ────────────────────────────────────────
        print("  → Mémoire épisodique...")
        episodes_data = await fetch_json(client, MEMORY_EPISODES_URL)
        episodes = (
            episodes_data if isinstance(episodes_data, list)
            else episodes_data.get("episodes", [])
        )
        if episodes and "_error" not in episodes_data:
            recent = episodes[-5:]  # 5 derniers épisodes
            lines.append("## Derniers Épisodes Mémoire (5)\n")
            for ep in reversed(recent):
                status = "✅" if ep.get("success") else "❌"
                mission = ep.get("mission", "?")[:80]
                model = ep.get("model_used", "?")
                lines.append(f"- {status} `{mission}` via `{model}`")
            lines.append("")

        # ── 5. World State ─────────────────────────────────────────────────────
        print("  → World state...")
        world = await fetch_json(client, MEMORY_WORLD_URL)
        if "_error" not in world and world:
            lines.append("## World State Actuel\n")
            lines.append("```json")
            lines.append(json.dumps(world, indent=2, ensure_ascii=False)[:1500])
            lines.append("```\n")

    # ── 6. Identité canonique ──────────────────────────────────────────────────
    print("  → Identité canonique...")
    identity = read_identity()
    lines.append("## Identité Canonique LaRuche\n")
    lines.append(identity)
    lines.append("")

    # ── 7. APIs disponibles ────────────────────────────────────────────────────
    lines.append("## APIs REST Disponibles\n")
    lines.append("```")
    lines.append("# Node.js Ghost OS :3000")
    lines.append("POST /api/mission          — lancer une mission")
    lines.append("GET  /api/health           — santé Node.js")
    lines.append("GET  /api/agents           — état swarm")
    lines.append("GET  /api/skills           — 19 skills")
    lines.append("POST /mcp/os-control       — click, screenshot, keyPress")
    lines.append("POST /mcp/terminal         — exec shell sandboxé")
    lines.append("POST /mcp/vision           — analyzeScreen, findElement")
    lines.append("POST /mcp/skill-factory    — createSkill, evolveSkill")
    lines.append("")
    lines.append("# Python Queen :8001")
    lines.append("POST /mission              — lancer via orchestrateur Python")
    lines.append("GET  /status               — état 7 couches")
    lines.append("GET  /hitl/queue           — actions HITL en attente")
    lines.append("")
    lines.append("# Brain :8003")
    lines.append("POST /think                — plan JSON depuis une mission")
    lines.append("GET  /health               — provider LLM actif")
    lines.append("```\n")

    # ── Écriture ───────────────────────────────────────────────────────────────
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n✅ Contexte exporté → {out}")
    print(f"   {out.stat().st_size} bytes")

    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export contexte Ghost OS pour Ollama")
    parser.add_argument("--out", type=Path, default=OUTPUT_FILE, help="Fichier de sortie")
    args = parser.parse_args()
    asyncio.run(main(args.out))
