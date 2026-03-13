"""
Monitoring temps réel PICO-RUCHE — interroge les /health de chaque couche
Usage: python3 scripts/status_agent.py
"""
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import httpx
except ImportError:
    import subprocess
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "httpx", "--break-system-packages", "-q"],
        check=False,
    )
    import httpx

# ---------------------------------------------------------------------------
# Configuration des couches
# ---------------------------------------------------------------------------

LAYERS = [
    {"name": "Queen",      "port": 8001, "path": "/health"},
    {"name": "Brain",      "port": 8003, "path": "/health"},
    {"name": "Perception", "port": 8002, "path": "/health"},
    {"name": "Executor",   "port": 8004, "path": "/health"},
    {"name": "Evolution",  "port": 8005, "path": "/health"},
    {"name": "Memory",     "port": 8006, "path": "/health"},
    {"name": "MCP Bridge", "port": 8007, "path": "/health"},
]

NODE_QUEEN = {"name": "Node.js Queen", "port": 3000, "path": "/api/health"}

TIMEOUT = 3.0  # secondes


# ---------------------------------------------------------------------------
# Fonctions de sondage
# ---------------------------------------------------------------------------

def probe(port: int, path: str = "/health") -> tuple[bool, float, dict]:
    """
    Interroge http://localhost:<port><path>.
    Retourne (ok, latence_ms, payload_json).
    """
    url = f"http://localhost:{port}{path}"
    try:
        start = time.monotonic()
        r = httpx.get(url, timeout=TIMEOUT)
        latency_ms = (time.monotonic() - start) * 1000
        if r.status_code == 200:
            try:
                payload = r.json()
            except Exception:
                payload = {}
            return True, latency_ms, payload
        return False, latency_ms, {}
    except Exception:
        return False, 0.0, {}


def probe_queen_status(port: int = 8001) -> dict:
    """
    Récupère /status sur la queen pour obtenir missions, vital_loop, etc.
    """
    try:
        r = httpx.get(f"http://localhost:{port}/status", timeout=TIMEOUT)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}


# ---------------------------------------------------------------------------
# Affichage
# ---------------------------------------------------------------------------

def format_latency(ms: float) -> str:
    if ms == 0:
        return "—"
    if ms < 1000:
        return f"{ms:.0f}ms"
    return f"{ms / 1000:.1f}s"


def main():
    width = 52
    bar = "━" * width
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    print()
    print(f"🐝 PICO-RUCHE Status — {now}")
    print(bar)

    # En-tête colonnes
    print(f"  {'COUCHE':<14} {'PORT':<6} {'STATUS':<12} {'LATENCE'}")
    print(bar)

    results = []

    # Couches Python
    for layer in LAYERS:
        ok, latency_ms, payload = probe(layer["port"], layer["path"])
        icon = "✅ OK" if ok else "❌ KO"
        lat_str = format_latency(latency_ms)
        print(f"  {layer['name']:<14} {layer['port']:<6} {icon:<12} {lat_str}")
        results.append(ok)

    print(bar)

    # Node.js Queen
    ok, latency_ms, _ = probe(NODE_QUEEN["port"], NODE_QUEEN["path"])
    icon = "✅ OK" if ok else "❌ KO"
    lat_str = format_latency(latency_ms)
    note = "(via /api/health)"
    print(f"  {NODE_QUEEN['name']:<14} {NODE_QUEEN['port']:<6} {icon:<12} {lat_str}  {note}")
    print(bar)

    # Métriques queen
    queen_status = probe_queen_status()
    vital = queen_status.get("vital_loop", None)
    missions = queen_status.get("missions_total", "?")
    layers_info = queen_status.get("layers", {})

    # Compter les skills depuis l'évolution si dispo
    _, _, evo_payload = probe(8005, "/health")
    skills_count = evo_payload.get("skills_count", "?")

    if vital is True:
        vital_str = "✅ active"
    elif vital is False:
        vital_str = "❌ inactive"
    else:
        vital_str = "? inconnue"

    print(f"  Boucle vitale: {vital_str}  |  Missions: {missions}  |  Skills: {skills_count}")
    print(bar)

    # Résumé global
    total = len(results)
    ok_count = sum(results)
    if ok_count == total:
        print(f"  ✅ {ok_count}/{total} couches Python actives — essaim opérationnel")
    else:
        print(f"  ⚠️  {ok_count}/{total} couches Python actives")
        print(f"  → Logs : {ROOT}/agent/logs/<couche>.log")

    print()


if __name__ == "__main__":
    main()
