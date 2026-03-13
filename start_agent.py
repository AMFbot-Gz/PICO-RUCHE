"""
Lance tout PICO-RUCHE en une commande — production-ready
Usage: python3 start_agent.py
"""
import os
import subprocess
import sys
import time
import signal
import json
from pathlib import Path
from datetime import datetime

try:
    import httpx
except ImportError:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "httpx", "--break-system-packages", "-q"],
        check=False,
    )
    import httpx

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
PIDS_DIR = ROOT / "agent" / ".pids"

# Ordre de démarrage : brain et memory AVANT queen
LAYERS = [
    {
        "name": "Brain",
        "file": "agent.brain",
        "port": 8003,
        "desc": "llama3:latest",
        "emoji": "🧠",
    },
    {
        "name": "Memory",
        "file": "agent.memory",
        "port": 8006,
        "desc": "episodes.jsonl",
        "emoji": "💾",
    },
    {
        "name": "Queen",
        "file": "agent.queen",
        "port": 8001,
        "desc": "boucle 30s",
        "emoji": "👑",
    },
]

HEALTH_RETRIES = 3
HEALTH_INTERVAL = 2.0  # secondes entre chaque tentative
STARTUP_DELAY = 1.5    # secondes entre chaque couche

procs: list[subprocess.Popen] = []

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ensure_dirs():
    PIDS_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / "agent" / "logs").mkdir(parents=True, exist_ok=True)


def write_pid(name: str, pid: int):
    pid_file = PIDS_DIR / f"{name.lower().replace(' ', '_')}.pid"
    pid_file.write_text(str(pid))


def check_ollama() -> bool:
    """Vérifie qu'Ollama est actif avant tout démarrage."""
    try:
        r = httpx.get("http://localhost:11434/api/tags", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def warmup_ollama():
    """Pré-charge les modèles Ollama pour éviter le cold-start de 3-5s sur la première requête."""
    models_to_warmup = ["llama3.2:3b", "nomic-embed-text", "llama3:latest"]
    ollama_url = os.environ.get("OLLAMA_HOST", "http://localhost:11434")

    print("🔥 Warmup Ollama en cours...")
    for model in models_to_warmup:
        try:
            # Ping minimal : génère 1 token pour forcer le chargement en RAM
            httpx.post(
                f"{ollama_url}/api/generate",
                json={"model": model, "prompt": "hi", "stream": False, "options": {"num_predict": 1}},
                timeout=30,
            )
            print(f"  ✅ {model} chargé")
        except Exception as e:
            print(f"  ⚠️  {model} non disponible: {e}")
    print("🔥 Warmup terminé\n")


def check_ollama_ready(host: str = "http://localhost:11434", timeout: int = 30) -> bool:
    """Attend qu'Ollama soit prêt (max timeout secondes).
    Utilisé juste avant le lancement de Brain pour confirmer que les modèles
    sont bien disponibles et pas seulement que le démon est en train de démarrer."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(f"{host}/api/tags", timeout=3)
            if r.status_code == 200:
                models = [m["name"] for m in r.json().get("models", [])]
                print(f"  ✅ Ollama prêt — {len(models)} modèles disponibles")
                return True
        except Exception:
            pass
        time.sleep(2)
    print(f"  ❌ Ollama non disponible après {timeout}s")
    return False


def check_health(port: int, retries: int = HEALTH_RETRIES) -> tuple[bool, float]:
    """
    Tente retries fois d'appeler /health sur le port donné.
    Retourne (succès, latence_ms).
    """
    for attempt in range(retries):
        try:
            start = time.monotonic()
            r = httpx.get(f"http://localhost:{port}/health", timeout=3)
            latency_ms = (time.monotonic() - start) * 1000
            if r.status_code == 200:
                return True, latency_ms
        except Exception:
            pass
        if attempt < retries - 1:
            time.sleep(HEALTH_INTERVAL)
    return False, 0.0


def start_layer(layer: dict) -> subprocess.Popen:
    log_file = ROOT / "agent" / "logs" / f"{layer['name'].lower().replace(' ', '_')}.log"
    log_fd = open(log_file, "a")
    cmd = [
        sys.executable, "-m", "uvicorn",
        f"{layer['file']}:app",
        "--host", "0.0.0.0",
        "--port", str(layer["port"]),
        "--log-level", "warning",
    ]
    p = subprocess.Popen(cmd, cwd=ROOT, stdout=log_fd, stderr=log_fd)
    write_pid(layer["name"], p.pid)
    return p


def telegram_configured() -> bool:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return False
    content = env_file.read_text()
    for line in content.splitlines():
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            token = line.split("=", 1)[1].strip()
            return bool(token)
    return False


# ---------------------------------------------------------------------------
# Arrêt propre
# ---------------------------------------------------------------------------

def signal_handler(sig, frame):
    print("\n🛑 Interruption reçue — arrêt de PICO-RUCHE...")
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    # Attendre la terminaison gracieuse
    deadline = time.monotonic() + 5
    for p in procs:
        try:
            remaining = max(0, deadline - time.monotonic())
            p.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                p.kill()
            except Exception:
                pass
        except Exception:
            pass
    sys.exit(0)


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

def main():
    ensure_dirs()

    width = 50
    bar = "━" * width

    print()
    print("🐝 PICO-RUCHE v1.1 — Mode éco 3 niveaux — Démarrage")
    print(bar)

    # 1. Vérifier ollama
    print("🔍 Vérification d'Ollama... ", end="", flush=True)
    if not check_ollama():
        print("❌")
        print()
        print("  ERREUR : Ollama n'est pas actif.")
        print("  Lancez d'abord :  ollama serve")
        print()
        sys.exit(1)
    print("✅ actif")
    print()

    # 2. Pré-charger les modèles Ollama en RAM avant le démarrage des couches
    warmup_ollama()

    # 3. Démarrer les couches dans l'ordre
    layer_status: dict[str, dict] = {}

    for layer in LAYERS:
        name = layer["name"]
        port = layer["port"]
        desc = layer["desc"]
        emoji = layer["emoji"]

        # Avant Brain : confirmation que les modèles Ollama sont vraiment disponibles.
        # Si Ollama ne répond pas dans le délai, on avertit mais on continue
        # (Brain pourra démarrer en mode dégradé ou retenter plus tard).
        if name == "Brain":
            print("  🔍 Vérification warmup Ollama (modèles)... ", end="", flush=True)
            if not check_ollama_ready(timeout=30):
                print("  ⚠️  Ollama warmup incomplet — Brain démarré sans garantie de modèles")
            else:
                pass  # message déjà affiché par check_ollama_ready

        print(f"  {emoji} Démarrage {name:<12} :{port}  {desc} ... ", end="", flush=True)
        try:
            p = start_layer(layer)
            procs.append(p)
            # Pause entre les couches pour que le processus s'initialise
            time.sleep(STARTUP_DELAY)

            ok, latency = check_health(port)
            if ok:
                print(f"✅  ({latency:.0f}ms)")
                layer_status[name] = {"ok": True, "latency": latency, "port": port, "desc": desc}
            else:
                print(f"⚠️  (timeout — processus démarré, health non confirmé)")
                layer_status[name] = {"ok": False, "latency": 0, "port": port, "desc": desc}

        except Exception as exc:
            print(f"❌  ({exc})")
            layer_status[name] = {"ok": False, "latency": 0, "port": port, "desc": desc, "error": str(exc)}

    # 4. Tableau de bord ASCII
    print()
    print(bar)
    print("🐝 PICO-RUCHE v1.1 — Mode éco 3 niveaux — Tableau de bord")
    print(bar)

    display_order = [
        ("Brain",  8003, "llama3:latest"),
        ("Memory", 8006, "episodes.jsonl"),
        ("Queen",  8001, "boucle 30s"),
    ]

    for name, port, desc in display_order:
        s = layer_status.get(name, {})
        icon = "✅" if s.get("ok") else "❌"
        print(f"  {icon} {name:<12} :{port}  {desc}")

    print(bar)

    tg = "configuré" if telegram_configured() else "non configuré"
    all_ok = all(s.get("ok") for s in layer_status.values())
    hive_status = "Essaim actif" if all_ok else "Essaim partiel — certaines couches KO"
    print(f"🐝 {hive_status}  |  Telegram: [{tg}]  |  Mode: 3 niveaux (L1 on-demand, L2 planifié)")
    print(bar)

    if not all_ok:
        print()
        print("⚠️  Couches avec erreurs :")
        for name, s in layer_status.items():
            if not s.get("ok"):
                err = s.get("error", "health timeout")
                print(f"   ❌ {name}: {err}")
        print("   → Logs : agent/logs/<couche>.log")

    print()
    print("📡 Queen    :  http://localhost:8001")
    print("📡 Status   :  http://localhost:8001/status")
    print("📡 Missions :  http://localhost:8001/missions")
    print("💬 Telegram :  envoie /status à ton bot")
    print("🔄 Boucle   :  adaptative (10s-5min selon contexte)")
    print("💤 Niveaux  :  L1 on-demand · L2 planifié (Evolution 1x/h)")
    print()
    print("  → python3 scripts/status_agent.py  (monitoring)")
    print("  → python3 stop_agent.py            (arrêt propre)")
    print()
    print("Ctrl+C pour arrêter l'essaim")
    print()

    try:
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        signal_handler(None, None)


if __name__ == "__main__":
    main()
