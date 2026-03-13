"""
Arrête proprement tous les services PICO-RUCHE
Usage: python3 stop_agent.py

Stratégie :
  1. Lit les PIDs depuis agent/.pids/ (créés par start_agent.py)
  2. Envoie SIGTERM à chaque processus
  3. Attend 5s ; envoie SIGKILL si toujours en vie
  4. Vérifie que les ports sont bien libérés
  Fallback : si pas de PID fichiers, lsof sur chaque port (comme avant).
"""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIDS_DIR = ROOT / "agent" / ".pids"

PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007]
GRACEFUL_TIMEOUT = 5  # secondes avant SIGKILL

# Mapping couche → port (pour affichage)
LAYER_NAMES = {
    8001: "Queen",
    8002: "Perception",
    8003: "Brain",
    8004: "Executor",
    8005: "Evolution",
    8006: "Memory",
    8007: "MCP Bridge",
}

width = 50
bar = "━" * width


def port_in_use(port: int) -> bool:
    """Retourne True si le port est encore occupé."""
    result = subprocess.run(
        ["lsof", "-ti", f":{port}"],
        capture_output=True, text=True
    )
    return bool(result.stdout.strip())


def send_signal_to_pid(pid: int, sig: int) -> bool:
    """Envoie un signal à un PID. Retourne False si le processus n'existe plus."""
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as e:
        print(f"  ⚠️  Permission refusée pour PID {pid}: {e}")
        return False


def kill_pids_from_files() -> dict[str, bool]:
    """
    Lit les fichiers .pid dans PIDS_DIR et tue les processus proprement.
    Retourne un dict {name: success}.
    """
    results: dict[str, bool] = {}

    if not PIDS_DIR.exists():
        return results

    pid_files = list(PIDS_DIR.glob("*.pid"))
    if not pid_files:
        return results

    # Phase 1 : SIGTERM sur tous
    pending: list[tuple[str, int]] = []
    for pid_file in pid_files:
        name = pid_file.stem.replace("_", " ").title()
        try:
            pid = int(pid_file.read_text().strip())
        except (ValueError, OSError):
            continue

        alive = send_signal_to_pid(pid, signal.SIGTERM)
        if alive:
            print(f"  🔶 SIGTERM → {name} (PID {pid})")
            pending.append((name, pid))
        else:
            print(f"  ℹ️  {name} (PID {pid}) déjà arrêté")
            results[name] = True
            pid_file.unlink(missing_ok=True)

    if not pending:
        return results

    # Phase 2 : attendre la terminaison gracieuse
    print(f"  ⏳ Attente arrêt gracieux ({GRACEFUL_TIMEOUT}s)...")
    time.sleep(GRACEFUL_TIMEOUT)

    # Phase 3 : SIGKILL pour les récalcitrants
    for name, pid in pending:
        pid_file = PIDS_DIR / f"{name.lower().replace(' ', '_')}.pid"
        still_alive = send_signal_to_pid(pid, 0)  # signal 0 = test d'existence
        if still_alive:
            print(f"  💀 SIGKILL → {name} (PID {pid})")
            send_signal_to_pid(pid, signal.SIGKILL)
            results[name] = True
        else:
            print(f"  ✅ {name} arrêté proprement")
            results[name] = True
        pid_file.unlink(missing_ok=True)

    return results


def kill_by_port_fallback(port: int) -> bool:
    """Fallback : tue les processus sur un port via lsof."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True
        )
        pids = [p.strip() for p in result.stdout.strip().split("\n") if p.strip()]
        for pid in pids:
            subprocess.run(["kill", "-9", pid], capture_output=True)
            print(f"  💀 Port {port} ({LAYER_NAMES.get(port, '?')}) libéré via lsof (PID {pid})")
        return bool(pids)
    except Exception as e:
        print(f"  ⚠️  Port {port}: {e}")
        return False


def verify_ports() -> dict[int, bool]:
    """Vérifie que les ports sont libérés. Retourne {port: libre}."""
    results: dict[int, bool] = {}
    for port in PORTS:
        results[port] = not port_in_use(port)
    return results


# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

def main():
    print()
    print("🛑 Arrêt PICO-RUCHE")
    print(bar)

    # FIX 5 : le nettoyage des PIDs est garanti même en cas d'exception
    try:
        # Étape 1 : arrêt via PID files
        pid_results = kill_pids_from_files()

        # Étape 2 : fallback lsof pour les ports encore occupés
        if not pid_results:
            print("  ℹ️  Pas de fichiers PID trouvés → fallback lsof")

        still_busy = [port for port in PORTS if port_in_use(port)]
        if still_busy:
            print()
            print("  Ports encore occupés — nettoyage lsof...")
            for port in still_busy:
                kill_by_port_fallback(port)
            time.sleep(1)

        # Étape 3 : vérification finale des ports
        print()
        print("🔍 Vérification des ports...")
        port_status = verify_ports()

        all_free = True
        for port in PORTS:
            name = LAYER_NAMES.get(port, f":{port}")
            free = port_status.get(port, True)
            icon = "✅" if free else "⚠️ "
            state = "libre" if free else "encore occupé"
            print(f"  {icon} :{port}  {name:<12} {state}")
            if not free:
                all_free = False

        print()
        print(bar)
        if all_free:
            print("✅ PICO-RUCHE arrêté — tous les ports sont libres")
        else:
            print("⚠️  PICO-RUCHE arrêté — certains ports sont encore occupés")
            print("   Relancer : python3 stop_agent.py")
        print()

    finally:
        # FIX 5 : nettoyage des PIDs garanti même en cas de crash
        if PIDS_DIR.exists():
            for f in PIDS_DIR.glob("*.pid"):
                f.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
