#!/usr/bin/env python3
"""
real_time_supervisor.py — Superviseur temps réel de LaRuche
Tourne en boucle toutes les 60s, interroge les APIs, envoie un résumé à ghost-os-architect.
Lance en arrière-plan : python3 scripts/real_time_supervisor.py &
"""

import asyncio
import httpx
import json
import signal
import sys
from datetime import datetime
from pathlib import Path

OLLAMA_HOST = "http://localhost:11434"
SUPERVISOR_MODEL = "ghost-os-architect"
FALLBACK_MODEL = "llama3:latest"
INTERVAL_SECONDS = 60

APIS = {
    "episodes": "http://localhost:8006/episodes?limit=3",
    "status":   "http://localhost:8001/status",
    "skills":   "http://localhost:3000/api/skills",
    "brain":    "http://localhost:8003/health",
}


async def fetch_safe(client: httpx.AsyncClient, name: str, url: str) -> tuple[str, dict | list | None]:
    """Fetch une API, retourne (name, data) ou (name, None) si offline."""
    try:
        resp = await client.get(url, timeout=5.0)
        resp.raise_for_status()
        return name, resp.json()
    except Exception:
        return name, None


async def collect_system_state() -> dict:
    """Fetch toutes les APIs en parallèle."""
    async with httpx.AsyncClient() as client:
        tasks = [
            fetch_safe(client, name, url)
            for name, url in APIS.items()
        ]
        results = await asyncio.gather(*tasks)

    # Transforme la liste de tuples en dict
    return {name: data for name, data in results}


def format_report(state: dict, ts: str) -> str:
    """Formate un résumé texte compact du système."""
    lines = [f"[{ts}] PICO-RUCHE Snapshot"]

    # --- Couches actives (depuis /status sur :8001) ---
    status_data = state.get("status")
    if status_data:
        layers = status_data.get("layers", {})
        if layers:
            ok_count = sum(1 for v in layers.values() if isinstance(v, dict) and v.get("status") == "ok")
            total = len(layers)
            lines.append(f"Couches: {ok_count}/{total} OK")
        else:
            lines.append("Couches: données indisponibles")

        # HITL en attente
        hitl = status_data.get("hitl_pending", 0)
        if hitl:
            lines.append(f"HITL en attente: {hitl}")

        # Boucle vitale
        vital = status_data.get("vital_loop")
        if vital is not None:
            lines.append(f"Boucle vitale: {'active' if vital else 'inactive'}")
    else:
        lines.append("Couches: offline")

    # --- Provider LLM actif (depuis /health sur :8003) ---
    brain_data = state.get("brain")
    if brain_data:
        provider = brain_data.get("provider") or brain_data.get("model") or brain_data.get("llm_provider", "?")
        lines.append(f"LLM actif: {provider}")
    else:
        lines.append("Brain: offline")

    # --- Skills disponibles (depuis :3000/api/skills) ---
    skills_data = state.get("skills")
    if skills_data is not None:
        if isinstance(skills_data, list):
            nb_skills = len(skills_data)
        elif isinstance(skills_data, dict):
            # Peut être {"skills": [...], "count": N} ou {"count": N}
            nb_skills = skills_data.get("count") or len(skills_data.get("skills", []))
        else:
            nb_skills = "?"
        lines.append(f"Skills: {nb_skills}")
    else:
        lines.append("Skills: offline")

    # --- Derniers épisodes mémoire (depuis :8006) ---
    episodes_data = state.get("episodes")
    if episodes_data is not None:
        # Normalise : peut être une liste directe ou {"episodes": [...]}
        if isinstance(episodes_data, list):
            episodes = episodes_data
        elif isinstance(episodes_data, dict):
            episodes = episodes_data.get("episodes", [])
        else:
            episodes = []

        if episodes:
            lines.append("Derniers épisodes:")
            for ep in episodes[:3]:
                mission = ep.get("mission") or ep.get("command") or ep.get("task", "?")
                success = ep.get("success") or ep.get("outcome") or ep.get("status", "?")
                # Tronque la mission pour rester compact
                if isinstance(mission, str) and len(mission) > 40:
                    mission = mission[:37] + "..."
                lines.append(f"  · {mission} → {success}")
        else:
            lines.append("Épisodes: aucun")
    else:
        lines.append("Mémoire: offline")

    return "\n".join(lines)


async def query_ollama(model: str, prompt: str) -> str:
    """Envoie une requête à Ollama avec streaming sur /api/generate."""
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "options": {
            "temperature": 0.3,
            "top_p": 0.9,
            "num_predict": 1024,
        },
    }

    full_response: list[str] = []

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", f"{OLLAMA_HOST}/api/generate", json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                        token = chunk.get("response", "")
                        if token:
                            # Affichage en streaming immédiat
                            print(token, end="", flush=True)
                            full_response.append(token)
                        if chunk.get("done"):
                            break
                    except json.JSONDecodeError:
                        continue

    except httpx.ConnectError:
        return f"[Erreur] Impossible de joindre Ollama sur {OLLAMA_HOST} — ollama serve est-il lancé ?"
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return f"[Erreur] Modèle '{model}' introuvable dans Ollama."
        return f"[Erreur] HTTP {e.response.status_code}: {e.response.text[:200]}"
    except Exception as exc:
        return f"[Erreur] {exc}"

    # Saut de ligne après le streaming inline
    print()
    return "".join(full_response)


async def check_model_available(model: str) -> bool:
    """Vérifie si le modèle est disponible dans Ollama."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{OLLAMA_HOST}/api/tags")
            models = [m["name"] for m in resp.json().get("models", [])]
            # Comparaison par nom de base (ignore le tag :latest)
            return any(m.split(":")[0] == model.split(":")[0] for m in models)
    except Exception:
        return False


async def supervisor_loop():
    """Boucle principale du superviseur."""
    print(f"Superviseur LaRuche démarré — rapport toutes les {INTERVAL_SECONDS}s")
    print(f"   Modèle: {SUPERVISOR_MODEL} (fallback: {FALLBACK_MODEL})")
    print(f"   Ctrl+C pour arrêter\n")

    # Détermine le modèle disponible une fois au démarrage
    if await check_model_available(SUPERVISOR_MODEL):
        model = SUPERVISOR_MODEL
    else:
        print(f"   Modèle '{SUPERVISOR_MODEL}' non trouvé — fallback sur '{FALLBACK_MODEL}'")
        model = FALLBACK_MODEL

    cycle = 0
    while True:
        cycle += 1
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"\n{'─'*60}")
        print(f"[{ts}] Cycle #{cycle} — Collecte état système...")

        state = await collect_system_state()
        report = format_report(state, ts)

        print(f"\nRapport:\n{report}")
        print(f"\n[{model}] Analyse en cours...")

        question = (
            f"{report}\n\n"
            "Sur la base de ce rapport, quelle est la recommandation principale "
            "pour optimiser le système ou anticiper le prochain problème ?"
        )

        response = await query_ollama(model, question)
        print(f"\n[SUPERVISOR REPORT]\n{response}")

        print(f"\nProchain rapport dans {INTERVAL_SECONDS}s...")
        await asyncio.sleep(INTERVAL_SECONDS)


def main():
    def _handle_sigint(sig, frame):
        print("\n\nSuperviseur arrêté.")
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_sigint)
    asyncio.run(supervisor_loop())


if __name__ == "__main__":
    main()
