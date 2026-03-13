import asyncio
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Optional

import httpx

ROOT = Path(__file__).resolve().parent.parent

LAYERS = {
    "queen":      {"file": "agent.queen",      "port": 8001, "level": 0},
    "brain":      {"file": "agent.brain",       "port": 8003, "level": 0},
    "memory":     {"file": "agent.memory",      "port": 8006, "level": 0},
    "executor":   {"file": "agent.executor",    "port": 8004, "level": 1},
    "perception": {"file": "agent.perception",  "port": 8002, "level": 1},
    "mcp_bridge": {"file": "agent.mcp_bridge",  "port": 8007, "level": 1},
    "evolution":  {"file": "agent.evolution",   "port": 8005, "level": 1},
}

HIBERNATE_TIMEOUT = 300
EVOLUTION_INTERVAL = 3600


class LayerManager:
    def __init__(self) -> None:
        self._pids: dict[str, Optional[int]] = {name: None for name in LAYERS}
        self._last_activity: dict[str, Optional[float]] = {name: None for name in LAYERS}
        self._locks: dict[str, asyncio.Lock] = {name: asyncio.Lock() for name in LAYERS}
        self._last_evolution: float = 0.0
        self._pids_dir = ROOT / "agent" / ".pids"
        self._logs_dir = ROOT / "agent" / "logs"
        self._pids_dir.mkdir(parents=True, exist_ok=True)
        self._logs_dir.mkdir(parents=True, exist_ok=True)

    def is_up(self, port: int) -> bool:
        try:
            import httpx as _httpx
            with _httpx.Client(timeout=2.0) as client:
                r = client.get(f"http://127.0.0.1:{port}/health")
                return r.status_code == 200
        except Exception:
            return False

    async def _health_check_async(self, port: int) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"http://127.0.0.1:{port}/health")
                return r.status_code == 200
        except Exception:
            return False

    async def start_layer(self, name: str) -> None:
        cfg = LAYERS[name]
        port = cfg["port"]
        log_path = self._logs_dir / f"{name}.log"
        log_file = open(log_path, "a")

        proc = subprocess.Popen(
            [
                "uvicorn",
                f"{cfg['file']}:app",
                "--host", "127.0.0.1",
                "--port", str(port),
            ],
            cwd=str(ROOT),
            stdout=log_file,
            stderr=log_file,
        )

        self._pids[name] = proc.pid
        pid_file = self._pids_dir / f"{name}.pid"
        pid_file.write_text(str(proc.pid))

        for attempt in range(3):
            await asyncio.sleep(1.5)
            if await self._health_check_async(port):
                self._last_activity[name] = time.time()
                return
        raise RuntimeError(f"Layer '{name}' failed health check after 3 retries")

    async def stop_layer(self, name: str) -> None:
        pid = self._pids.get(name)
        if pid is None:
            pid_file = self._pids_dir / f"{name}.pid"
            if pid_file.exists():
                try:
                    pid = int(pid_file.read_text().strip())
                except ValueError:
                    pid = None

        if pid is not None:
            try:
                os.kill(pid, signal.SIGTERM)
                await asyncio.sleep(3)
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            except ProcessLookupError:
                pass

        self._pids[name] = None
        self._last_activity[name] = None
        pid_file = self._pids_dir / f"{name}.pid"
        if pid_file.exists():
            pid_file.unlink()

    async def ensure_layer(self, name: str) -> bool:
        cfg = LAYERS[name]
        if self.is_up(cfg["port"]):
            self._last_activity[name] = time.time()
            return True

        async with self._locks[name]:
            if self.is_up(cfg["port"]):
                self._last_activity[name] = time.time()
                return True
            try:
                await self.start_layer(name)
                return True
            except RuntimeError:
                return False

    def touch_layer(self, name: str) -> None:
        self._last_activity[name] = time.time()

    def _mission_running(self) -> bool:
        try:
            import httpx as _httpx
            with _httpx.Client(timeout=2.0) as client:
                r = client.get("http://127.0.0.1:8001/mission/status")
                if r.status_code == 200:
                    data = r.json()
                    return data.get("running", False)
        except Exception:
            pass
        return False

    async def hibernate_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.time()
            mission_running = self._mission_running()

            for name, cfg in LAYERS.items():
                level = cfg["level"]

                if level == 1:
                    if mission_running:
                        continue
                    last = self._last_activity.get(name)
                    if last is not None and (now - last) > HIBERNATE_TIMEOUT:
                        if self.is_up(cfg["port"]):
                            await self.stop_layer(name)

                elif level == 2:
                    if (now - self._last_evolution) >= EVOLUTION_INTERVAL:
                        if not self.is_up(cfg["port"]):
                            async with self._locks[name]:
                                try:
                                    await self.start_layer(name)
                                except RuntimeError:
                                    continue
                        self._last_evolution = now
                        await asyncio.sleep(60)
                        if self.is_up(cfg["port"]):
                            await self.stop_layer(name)

    def get_status(self) -> dict:
        status = {}
        for name, cfg in LAYERS.items():
            pid_file = self._pids_dir / f"{name}.pid"
            pid = self._pids.get(name)
            if pid is None and pid_file.exists():
                try:
                    pid = int(pid_file.read_text().strip())
                except ValueError:
                    pid = None

            status[name] = {
                "up": self.is_up(cfg["port"]),
                "level": cfg["level"],
                "last_activity": self._last_activity.get(name),
                "pid": pid,
            }
        return status


_manager: Optional[LayerManager] = None


def get_manager() -> LayerManager:
    global _manager
    if _manager is None:
        _manager = LayerManager()
    return _manager
