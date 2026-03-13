"""
Skill : system_health — Rapport de santé système pour PICO-RUCHE
Vérifie CPU/RAM/disque, Ollama, et les couches Python (ports 8001-8007)
"""
import httpx
import psutil
from typing import Any


BASE_URL_OLLAMA = "http://localhost:11434"

# Ports des couches Python de l'agent
LAYER_PORTS = {
    "queen":      8001,
    "perception": 8002,
    "brain":      8003,
    "executor":   8004,
    "evolution":  8005,
    "memory":     8006,
    "mcp_bridge": 8007,
}


def _check_ollama() -> dict[str, Any]:
    """Vérifie si Ollama est joignable sur localhost:11434."""
    try:
        resp = httpx.get(f"{BASE_URL_OLLAMA}", timeout=3.0)
        return {"running": True, "status_code": resp.status_code}
    except Exception as exc:
        return {"running": False, "error": str(exc)}


def _check_layers() -> dict[str, dict[str, Any]]:
    """Ping chaque couche Python sur son port /status ou /."""
    results: dict[str, dict[str, Any]] = {}
    for name, port in LAYER_PORTS.items():
        url = f"http://localhost:{port}/status"
        try:
            resp = httpx.get(url, timeout=2.0)
            results[name] = {"running": True, "port": port, "status_code": resp.status_code}
        except Exception as exc:
            results[name] = {"running": False, "port": port, "error": str(exc)}
    return results


def check() -> dict[str, Any]:
    """
    Retourne un rapport de santé complet :
    {
        "cpu_percent": float,
        "ram": {"total_gb": float, "used_gb": float, "percent": float},
        "disk": {"total_gb": float, "used_gb": float, "percent": float},
        "ollama": {"running": bool, ...},
        "layers": { "queen": {"running": bool, "port": int, ...}, ... },
        "healthy": bool   # True si Ollama + toutes couches répondent
    }
    """
    # CPU (intervalle 0.5 s pour ne pas bloquer trop longtemps)
    cpu_percent = psutil.cpu_percent(interval=0.5)

    # RAM
    vm = psutil.virtual_memory()
    ram = {
        "total_gb": round(vm.total / 1e9, 2),
        "used_gb":  round(vm.used  / 1e9, 2),
        "percent":  vm.percent,
    }

    # Disque racine
    du = psutil.disk_usage("/")
    disk = {
        "total_gb": round(du.total / 1e9, 2),
        "used_gb":  round(du.used  / 1e9, 2),
        "percent":  du.percent,
    }

    ollama = _check_ollama()
    layers = _check_layers()

    all_layers_up = all(v["running"] for v in layers.values())
    healthy = ollama["running"] and all_layers_up

    return {
        "cpu_percent": cpu_percent,
        "ram":         ram,
        "disk":        disk,
        "ollama":      ollama,
        "layers":      layers,
        "healthy":     healthy,
    }


# Permet d'appeler le skill directement : python3 -m agent.skills.system_health
if __name__ == "__main__":
    import json
    print(json.dumps(check(), indent=2))
