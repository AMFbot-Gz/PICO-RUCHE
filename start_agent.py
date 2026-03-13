"""
Lance tout PICO-RUCHE en une commande
Usage: python3 start_agent.py
"""
import subprocess
import sys
import time
import signal
import os

try:
    import httpx
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "httpx", "--break-system-packages", "-q"])
    import httpx

LAYERS = [
    {"name": "memory",     "file": "agent.memory",     "port": 8006},
    {"name": "perception", "file": "agent.perception", "port": 8002},
    {"name": "brain",      "file": "agent.brain",      "port": 8003},
    {"name": "executor",   "file": "agent.executor",   "port": 8004},
    {"name": "evolution",  "file": "agent.evolution",  "port": 8005},
    {"name": "mcp_bridge", "file": "agent.mcp_bridge", "port": 8007},
    {"name": "queen",      "file": "agent.queen",      "port": 8001},
]

procs = []
ROOT = os.path.dirname(os.path.abspath(__file__))


def start_layer(layer):
    cmd = [
        sys.executable, "-m", "uvicorn",
        f"{layer['file']}:app",
        "--host", "0.0.0.0",
        "--port", str(layer["port"]),
        "--log-level", "warning"
    ]
    p = subprocess.Popen(cmd, cwd=ROOT)
    print(f"  ✅ {layer['name']:15} → http://localhost:{layer['port']}")
    return p


def check_health(port, retries=15):
    for _ in range(retries):
        try:
            r = httpx.get(f"http://localhost:{port}/health", timeout=2)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.7)
    return False


def signal_handler(sig, frame):
    print("\n🛑 Arrêt PICO-RUCHE...")
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    sys.exit(0)


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

print("\n🐝 Démarrage PICO-RUCHE — Agent Vivant Hybride")
print("=" * 50)

for layer in LAYERS:
    p = start_layer(layer)
    procs.append(p)
    time.sleep(1.5)

print("\n🔍 Vérification santé des couches...")
all_ok = True
for layer in LAYERS:
    ok = check_health(layer["port"])
    status = "✅" if ok else "❌"
    print(f"  {status} {layer['name']:15} port {layer['port']}")
    if not ok:
        all_ok = False

print("\n" + "=" * 50)
if all_ok:
    print("✅ PICO-RUCHE actif — toutes les couches répondent")
else:
    print("⚠️  Certaines couches n'ont pas démarré — vérifier les logs")

print("📡 Queen:    http://localhost:8001")
print("📡 Status:   http://localhost:8001/status")
print("📡 Missions: http://localhost:8001/missions")
print("💬 Telegram: envoie /mission <texte> à ton bot")
print("🔄 Boucle vitale: toutes les 30s")
print("\nCtrl+C pour arrêter\n")

try:
    for p in procs:
        p.wait()
except KeyboardInterrupt:
    signal_handler(None, None)
