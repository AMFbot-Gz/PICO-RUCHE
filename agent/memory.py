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

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Memory", version="1.0.0")

EPISODE_FILE = Path(CONFIG["memory"]["episode_file"])
PERSISTENT_FILE = Path(CONFIG["memory"]["persistent_file"])
WORLD_STATE_FILE = Path(CONFIG["memory"]["world_state_file"])
MAX_EPISODES = CONFIG["memory"]["max_episodes"]

EPISODE_FILE.parent.mkdir(parents=True, exist_ok=True)
if not EPISODE_FILE.exists():
    EPISODE_FILE.write_text("")
if not WORLD_STATE_FILE.exists():
    WORLD_STATE_FILE.write_text("{}")


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


@app.post("/episode")
async def save_episode(episode: Episode):
    entry = {
        "timestamp": datetime.utcnow().isoformat(),
        **episode.model_dump()
    }
    with open(EPISODE_FILE, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    lines = [l for l in EPISODE_FILE.read_text().strip().split("\n") if l]
    if len(lines) > MAX_EPISODES:
        EPISODE_FILE.write_text("\n".join(lines[-MAX_EPISODES:]) + "\n")
    if episode.learned:
        with open(PERSISTENT_FILE, "a") as f:
            f.write(f"\n### {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} — Apprentissage\n{episode.learned}\n")
    return {"saved": True, "total_episodes": len(lines)}


@app.get("/episodes")
async def get_episodes(limit: int = 20):
    if not EPISODE_FILE.exists():
        return {"episodes": []}
    lines = [l for l in EPISODE_FILE.read_text().strip().split("\n") if l]
    episodes = [json.loads(l) for l in lines[-limit:]]
    return {"episodes": list(reversed(episodes))}


@app.post("/search")
async def search_episodes(query: dict):
    keywords = query.get("keywords", [])
    if not EPISODE_FILE.exists():
        return {"results": []}
    lines = [l for l in EPISODE_FILE.read_text().strip().split("\n") if l]
    results = []
    for line in lines:
        ep = json.loads(line)
        text = (ep.get("mission", "") + ep.get("result", "") + ep.get("learned", "")).lower()
        if any(k.lower() in text for k in keywords):
            results.append(ep)
    return {"results": results[-10:]}


@app.get("/world")
async def get_world_state():
    return json.loads(WORLD_STATE_FILE.read_text())


@app.post("/world")
async def update_world_state(update: WorldStateUpdate):
    state = json.loads(WORLD_STATE_FILE.read_text())
    state[update.key] = update.value
    state["last_updated"] = datetime.utcnow().isoformat()
    WORLD_STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    return {"updated": True}


@app.get("/profile")
async def get_profile():
    profile = PERSISTENT_FILE.read_text() if PERSISTENT_FILE.exists() else "Aucun profil."
    episodes_count = len([l for l in EPISODE_FILE.read_text().strip().split("\n") if l]) if EPISODE_FILE.exists() else 0
    return {"profile": profile, "total_episodes": episodes_count}


@app.get("/health")
async def health():
    episode_count = 0
    try:
        if EPISODE_FILE.exists():
            lines = [l for l in EPISODE_FILE.read_text().strip().split("\n") if l]
            episode_count = len(lines)
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
