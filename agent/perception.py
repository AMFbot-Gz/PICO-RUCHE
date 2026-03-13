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

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Perception", version="1.0.0")

SCREENSHOT_PATH = Path("/tmp/pico_ruche_screen.png")
LAST_HASH = {"screen": "", "timestamp": ""}


def take_screenshot(region: Optional[str] = None) -> Path:
    if region:
        cmd = ["screencapture", "-x", "-R", region, str(SCREENSHOT_PATH)]
    else:
        cmd = ["screencapture", "-x", str(SCREENSHOT_PATH)]
    subprocess.run(cmd, check=True)
    return SCREENSHOT_PATH


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scan_system() -> dict:
    cpu = psutil.cpu_percent(interval=1)
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
    path = take_screenshot(region)
    new_hash = hash_file(path)
    changed = new_hash != LAST_HASH["screen"]
    LAST_HASH["screen"] = new_hash
    LAST_HASH["timestamp"] = datetime.utcnow().isoformat()
    return {
        "path": str(path),
        "hash": new_hash,
        "changed": changed,
        "timestamp": LAST_HASH["timestamp"]
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
    path = take_screenshot()
    new_hash = hash_file(path)
    changed = new_hash != LAST_HASH["screen"]
    LAST_HASH["screen"] = new_hash
    system = scan_system()
    recent = scan_recent_files()
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "screen": {"path": str(path), "hash": new_hash, "changed": changed},
        "system": system,
        "recent_files": recent,
        "anomalies": [
            f"CPU élevé: {system['cpu_percent']}%" if system["cpu_percent"] > 80 else None,
            f"RAM critique: {system['ram_percent']}%" if system["ram_percent"] > 90 else None,
            f"Disque plein: {system['disk_free_gb']}GB libres" if system["disk_free_gb"] < 5 else None,
        ]
    }


@app.get("/health")
async def health():
    return {"status": "ok", "layer": "perception"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["perception"])
