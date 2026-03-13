"""
Couche perception — port 8002
Yeux du système · screenshot · scan · détection changements · hash SHA-256
"""
import hashlib
import json
import os
import subprocess
import asyncio
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
import psutil
import yaml
from dotenv import load_dotenv
load_dotenv()

ROOT = Path(__file__).resolve().parent.parent

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Perception", version="1.0.0")

SCREENSHOT_PATH = Path("/tmp/pico_ruche_screen.png")
LAST_HASH = {"screen": "", "timestamp": ""}
_HASH_LOCK = asyncio.Lock()  # FIX 5 — protège LAST_HASH contre les race conditions


def take_screenshot(region: Optional[str] = None) -> Path:
    """Capture écran via screencapture (macOS). Lève RuntimeError si échec."""
    if region:
        cmd = ["screencapture", "-x", "-R", region, str(SCREENSHOT_PATH)]
    else:
        cmd = ["screencapture", "-x", str(SCREENSHOT_PATH)]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=10)  # FIX 7 — timeout 10s
    except subprocess.TimeoutExpired:
        raise RuntimeError("screencapture a dépassé le timeout (10s)")
    if result.returncode != 0:
        stderr_text = result.stderr.decode() if result.stderr else ""  # FIX 6 — decode sécurisé
        raise RuntimeError(
            f"screencapture a échoué (code {result.returncode}): {stderr_text[:200]}"
        )
    if not SCREENSHOT_PATH.exists():
        raise RuntimeError("screencapture n'a pas produit de fichier")
    return SCREENSHOT_PATH


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scan_system() -> dict:
    # interval=None évite le blocage d'1 seconde — valeur instantanée depuis le dernier appel
    cpu = psutil.cpu_percent(interval=None)
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    procs = [p.info for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"])
             if p.info["cpu_percent"] and p.info["cpu_percent"] > 1.0][:10]
    net = psutil.net_io_counters()
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "cpu_percent": cpu,
        "ram_used_gb": round(ram.used / 1e9, 2),
        "ram_total_gb": round(ram.total / 1e9, 2),
        "ram_percent": ram.percent,
        "disk_used_gb": round(disk.used / 1e9, 2),
        "disk_free_gb": round(disk.free / 1e9, 2),
        "top_processes": procs,
        "net_sent_mb": round(net.bytes_sent / 1e6, 2),
        "net_recv_mb": round(net.bytes_recv / 1e6, 2),
        "open_files_count": len(psutil.Process(os.getpid()).open_files())
    }


def scan_recent_files(directory: str = os.path.expanduser("~/Desktop"), minutes: int = 5) -> list:
    import time
    cutoff = time.time() - (minutes * 60)
    recent = []
    try:
        for root, dirs, files in os.walk(directory):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
            for file in files:
                fp = os.path.join(root, file)
                try:
                    if os.path.getmtime(fp) > cutoff:
                        recent.append({
                            "path": fp,
                            "size": os.path.getsize(fp),
                            "modified": datetime.fromtimestamp(os.path.getmtime(fp)).isoformat()
                        })
                except Exception:
                    pass
    except Exception:
        pass
    return recent[:20]


@app.post("/screenshot")
async def screenshot(region: Optional[str] = None):
    try:
        path = take_screenshot(region)
        new_hash = hash_file(path)
        async with _HASH_LOCK:  # FIX 5 — accès thread-safe à LAST_HASH
            changed = new_hash != LAST_HASH["screen"]
            LAST_HASH["screen"] = new_hash
            LAST_HASH["timestamp"] = datetime.utcnow().isoformat()
            timestamp = LAST_HASH["timestamp"]
        return {
            "path": str(path),
            "hash": new_hash,
            "changed": changed,
            "timestamp": timestamp,
            "error": None
        }
    except Exception as e:
        return {
            "path": None,
            "hash": None,
            "changed": False,
            "timestamp": datetime.utcnow().isoformat(),
            "error": str(e)
        }


@app.get("/system")
async def system_scan():
    return scan_system()


@app.get("/files/recent")
async def recent_files(directory: str = None, minutes: int = 5):
    dir_path = directory or os.path.expanduser("~/Desktop")
    return {"files": scan_recent_files(dir_path, minutes)}


@app.post("/observe")
async def full_observation():
    now = datetime.utcnow().isoformat()
    # Screenshot — tolérant aux erreurs (peut échouer en headless)
    screen_info: dict = {"changed": False, "path": None, "hash": None, "error": None}
    try:
        path = take_screenshot()
        new_hash = hash_file(path)
        async with _HASH_LOCK:  # FIX 5 — accès thread-safe à LAST_HASH
            changed = new_hash != LAST_HASH["screen"]
            LAST_HASH["screen"] = new_hash
            LAST_HASH["timestamp"] = now
        screen_info = {"changed": changed, "path": str(path), "hash": new_hash, "error": None}
    except Exception as e:
        screen_info["error"] = str(e)
    # Scan système — toujours disponible
    try:
        system = scan_system()
    except Exception as e:
        system = {"error": str(e)}
    # Fichiers récents
    try:
        recent = scan_recent_files()
    except Exception:
        recent = []
    # Anomalies — filtrer les None
    anomalies = [a for a in [
        f"CPU élevé: {system.get('cpu_percent', 0)}%" if system.get("cpu_percent", 0) > 80 else None,
        f"RAM critique: {system.get('ram_percent', 0)}%" if system.get("ram_percent", 0) > 90 else None,
        f"Disque plein: {system.get('disk_free_gb', 99)}GB libres" if system.get("disk_free_gb", 99) < 5 else None,
    ] if a is not None]
    return {
        "timestamp": now,
        "screen": screen_info,
        "system": system,
        "recent_files": recent,
        "anomalies": anomalies
    }


@app.get("/health")
async def health():
    return {"status": "ok", "layer": "perception"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["perception"])
