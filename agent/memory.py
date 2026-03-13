"""
Couche mémoire — port 8006
Mémoire épisodique JSONL + mémoire persistante + world state
"""
import json
import os
import asyncio
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List, Any
import yaml
from dotenv import load_dotenv
load_dotenv()

ROOT = Path(__file__).resolve().parent.parent

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Memory", version="1.0.0")

EPISODE_FILE = ROOT / CONFIG["memory"]["episode_file"]
PERSISTENT_FILE = ROOT / CONFIG["memory"]["persistent_file"]
WORLD_STATE_FILE = ROOT / CONFIG["memory"]["world_state_file"]
MAX_EPISODES = CONFIG["memory"]["max_episodes"]

EPISODE_FILE.parent.mkdir(parents=True, exist_ok=True)
if not EPISODE_FILE.exists():
    EPISODE_FILE.write_text("")
if not WORLD_STATE_FILE.exists():
    WORLD_STATE_FILE.write_text("{}")

# CORRECTION 1 — Verrou asyncio pour protéger EPISODE_FILE contre les
# accès concurrents (race condition en lecture/écriture/trim).
_FILE_LOCK = asyncio.Lock()

# CORRECTION 2 — Compteur de lignes JSON corrompues détectées.
_corruption_count = 0


class Episode(BaseModel):
    mission: str
    result: str
    success: bool
    duration_ms: int
    model_used: str
    skills_used: List[str] = []
    learned: Optional[str] = None


class WorldStateUpdate(BaseModel):
    key: str
    value: Any


def _read_episodes_safe(filepath: Path) -> list:
    """Lit episodes.jsonl en sautant les lignes corrompues.
    CORRECTION 2 : incrémente _corruption_count et loggue une alerte si >10.
    NOTE : cette fonction doit être appelée depuis un contexte déjà protégé
    par _FILE_LOCK (voir GET /episodes) ou depuis un contexte où la concurrence
    n'est pas un risque (health, profile, search — lecture seule légère).
    """
    global _corruption_count
    episodes = []
    if not filepath.exists():
        return episodes
    for line in filepath.read_text(encoding="utf-8").strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            episodes.append(json.loads(line))
        except json.JSONDecodeError as e:
            _corruption_count += 1
            print(f"[Memory] Ligne corrompue ignorée: {e} — {line[:80]}")
            # CORRECTION 2 — Alerte visible si trop de corruptions
            if _corruption_count > 10:
                print(
                    f"[Memory] ⚠️ ALERTE: {_corruption_count} lignes corrompues "
                    f"détectées dans {filepath.name}"
                )
                _corruption_count = 0  # Réinitialisation après l'alerte
    return episodes


async def _trim_unlocked(filepath: Path, max_ep: int) -> None:
    """Version interne du trim — doit être appelée depuis un contexte
    déjà protégé par _FILE_LOCK (pas de re-lock pour éviter le deadlock).
    CORRECTION 3 : écriture atomique via fichier temporaire + os.replace.
    """
    try:
        if not filepath.exists():
            return
        lines = [l for l in filepath.read_text(encoding="utf-8").splitlines() if l.strip()]
        if len(lines) <= max_ep:
            return
        to_archive = lines[:-max_ep]   # les plus anciens, qui seront supprimés
        kept = lines[-max_ep:]

        # Archivage des épisodes supprimés — append dans episodes_archive.jsonl
        archive_path = filepath.parent / "episodes_archive.jsonl"
        try:
            with open(archive_path, "a", encoding="utf-8") as af:
                for line in to_archive:
                    af.write(line + "\n")
            print(f"[Memory] 📦 Archivage: {len(to_archive)} épisodes → {archive_path.name}")
        except Exception as arch_err:
            print(f"[Memory] ⚠️  Archive error (non-bloquant): {arch_err}")

        # CORRECTION 3 — Écriture atomique : .tmp puis os.replace
        tmp_path = filepath.with_suffix(".tmp")
        tmp_path.write_text("\n".join(kept) + "\n", encoding="utf-8")
        os.replace(tmp_path, filepath)

        print(f"[Memory] 🗑️  Trim épisodes: {len(lines)} → {len(kept)} (archivés: {len(to_archive)})")
    except Exception as e:
        print(f"[Memory] ⚠️  Trim error: {e}")


@app.post("/episode")
async def save_episode(episode: Episode):
    # CORRECTION 1 — Toute l'opération write + trim est protégée par le lock.
    async with _FILE_LOCK:
        entry = {
            "timestamp": datetime.utcnow().isoformat(),
            **episode.model_dump()
        }
        with open(EPISODE_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        # Trim appelé directement (pas via create_task) — déjà sous lock,
        # on utilise _trim_unlocked pour éviter le deadlock.
        await _trim_unlocked(EPISODE_FILE, MAX_EPISODES)
        if episode.learned:
            with open(PERSISTENT_FILE, "a", encoding="utf-8") as f:
                f.write(f"\n### {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} — Apprentissage\n{episode.learned}\n")
        episodes = _read_episodes_safe(EPISODE_FILE)
    return {"saved": True, "total_episodes": len(episodes)}


@app.get("/episodes")
async def get_episodes(limit: int = 20):
    # CORRECTION 4 — Lecture protégée par le lock pour éviter une lecture
    # pendant un trim en cours.
    async with _FILE_LOCK:
        episodes = _read_episodes_safe(EPISODE_FILE)
    return {"episodes": list(reversed(episodes[-limit:]))}


@app.post("/search")
async def search_episodes(query: dict):
    keywords = query.get("keywords", [])
    results = []
    for ep in _read_episodes_safe(EPISODE_FILE):
        text = (ep.get("mission", "") + ep.get("result", "") + ep.get("learned", "")).lower()
        if any(k.lower() in text for k in keywords):
            results.append(ep)
    return {"results": results[-10:]}


@app.get("/world")
async def get_world_state():
    return json.loads(WORLD_STATE_FILE.read_text(encoding="utf-8"))


@app.post("/world")
async def update_world_state(update: WorldStateUpdate):
    state = json.loads(WORLD_STATE_FILE.read_text(encoding="utf-8"))
    state[update.key] = update.value
    state["last_updated"] = datetime.utcnow().isoformat()
    WORLD_STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    return {"updated": True}


@app.get("/profile")
async def get_profile():
    profile = PERSISTENT_FILE.read_text(encoding="utf-8") if PERSISTENT_FILE.exists() else "Aucun profil."
    episodes_count = len(_read_episodes_safe(EPISODE_FILE))
    return {"profile": profile, "total_episodes": episodes_count}


@app.get("/health")
async def health():
    episode_count = 0
    try:
        episode_count = len(_read_episodes_safe(EPISODE_FILE))
    except Exception:
        pass
    return {
        "status": "ok",
        "layer": "memory",
        "episode_count": episode_count,
        "max_episodes": MAX_EPISODES,
        "episode_file": str(EPISODE_FILE),
        "world_state_file": str(WORLD_STATE_FILE),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["memory"])
