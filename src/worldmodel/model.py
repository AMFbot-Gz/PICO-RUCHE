"""
src/worldmodel/model.py — WorldModel de Ghost OS v7

Représentation en mémoire de l'état courant du monde :
- Ressources système (CPU, RAM, disque)
- Application active au premier plan
- Cache des coordonnées UI (grounding)
- Crédits des agents (agent market)

Persistance : agent/memory/world_state.json
Thread-safety : threading.Lock sur toutes les opérations R/W
Singleton : WorldModel.get_instance()
"""

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Chemin racine du projet (2 niveaux au-dessus de src/worldmodel/)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_WORLD_STATE_PATH = _PROJECT_ROOT / "agent" / "memory" / "world_state.json"


def _now_iso() -> str:
    """Retourne l'heure UTC courante au format ISO 8601."""
    return datetime.now(timezone.utc).isoformat()


def _make_element_key(app: str, window: str, query: str) -> str:
    """Clé unique pour un élément UI dans le cache."""
    return f"{app}:{window}:{query}"


class WorldModel:
    """
    Modèle mondial de l'agent — état courant du système et de l'environnement UI.

    Usage :
        wm = WorldModel.get_instance()
        app = wm.get_frontmost_app()
        wm.update(perception_snapshot)
    """

    # --- Singleton -----------------------------------------------------------
    _instance: Optional["WorldModel"] = None
    _instance_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "WorldModel":
        """Retourne l'instance unique, chargée depuis world_state.json."""
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls(_WORLD_STATE_PATH)
            return cls._instance

    # --- Initialisation ------------------------------------------------------

    def __init__(self, state_path: Path):
        self._path = Path(state_path)
        self._lock = threading.Lock()
        self._state: dict = self._load()

    def _load(self) -> dict:
        """Charge world_state.json depuis le disque. Retourne {} si absent ou corrompu."""
        try:
            if self._path.exists():
                raw = self._path.read_text(encoding="utf-8").strip()
                if raw:
                    return json.loads(raw)
        except (json.JSONDecodeError, OSError):
            # Fichier corrompu → repart de zéro
            pass
        return {}

    def _save(self) -> None:
        """
        Flush l'état courant vers le disque de façon atomique.
        Écriture dans un fichier temporaire puis renommage pour éviter
        la corruption en cas d'interruption.
        ATTENTION : doit être appelé avec self._lock déjà acquis.
        """
        self._state["updated_at"] = _now_iso()
        payload = json.dumps(self._state, ensure_ascii=False, indent=2)
        try:
            dir_ = self._path.parent
            dir_.mkdir(parents=True, exist_ok=True)
            # Écriture atomique via fichier temporaire dans le même répertoire
            fd, tmp_path = tempfile.mkstemp(dir=dir_, prefix=".world_state_", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(payload)
                os.replace(tmp_path, self._path)
            except Exception:
                # Nettoyage si l'écriture échoue
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except OSError:
            # Non bloquant — l'état reste cohérent en RAM
            pass

    # =========================================================================
    # MÉTHODES DE LECTURE (query)
    # =========================================================================

    def get_frontmost_app(self) -> Optional[str]:
        """Retourne le nom de l'application au premier plan, ou None."""
        with self._lock:
            active = self._state.get("active_app", {})
            return active.get("name") or None

    def get_system(self) -> dict:
        """Retourne le snapshot système complet (CPU, RAM, disque, processus)."""
        with self._lock:
            return dict(self._state.get("system", {}))

    def is_disk_space_low(self, threshold_gb: float = 5.0) -> bool:
        """
        Retourne True si l'espace disque libre est inférieur à threshold_gb.
        Si l'info n'est pas disponible, retourne False par défaut.
        """
        with self._lock:
            free = self._state.get("system", {}).get("disk_free_gb")
        if free is None:
            return False
        return float(free) < threshold_gb

    def is_cpu_high(self, threshold: float = 80.0) -> bool:
        """Retourne True si le CPU dépasse threshold %."""
        with self._lock:
            cpu = self._state.get("system", {}).get("cpu_percent")
        if cpu is None:
            return False
        return float(cpu) >= threshold

    def is_ram_critical(self, threshold: float = 90.0) -> bool:
        """Retourne True si l'utilisation RAM dépasse threshold %."""
        with self._lock:
            ram = self._state.get("system", {}).get("ram_percent")
        if ram is None:
            return False
        return float(ram) >= threshold

    def get_active_processes(self) -> list:
        """Retourne la liste des processus actifs du dernier snapshot."""
        with self._lock:
            return list(self._state.get("system", {}).get("processes", []))

    def get_element_cache(self, app: str, window: str, query: str) -> Optional[dict]:
        """
        Retourne les coordonnées UI mises en cache pour (app, window, query).
        Retourne None si l'élément n'est pas en cache.
        """
        key = _make_element_key(app, window, query)
        with self._lock:
            cache = self._state.get("element_cache", {})
            entry = cache.get(key)
        return dict(entry) if entry else None

    def get_credits(self, agent_id: str) -> int:
        """Retourne les crédits d'un agent (0 si inexistant)."""
        with self._lock:
            credits_ = self._state.get("agent_market", {}).get("credits", {})
            return int(credits_.get(agent_id, 0))

    # =========================================================================
    # MÉTHODES D'ÉCRITURE
    # =========================================================================

    def update(self, snapshot: dict) -> None:
        """
        Fusionne un snapshot de perception (issu de scan_system()) dans l'état courant.

        Si l'app active change, invalide automatiquement le cache UI de l'ancienne app
        (grounding automatique).
        """
        with self._lock:
            # --- Mise à jour système ---
            system_keys = ("cpu_percent", "ram_used_gb", "ram_total_gb",
                           "ram_percent", "disk_used_gb", "disk_free_gb", "processes")
            system_update = {k: snapshot[k] for k in system_keys if k in snapshot}
            if system_update:
                if "system" not in self._state:
                    self._state["system"] = {}
                self._state["system"].update(system_update)

            # --- Détection de l'app frontmost depuis les processus ---
            # On ne déduit pas l'app depuis les processus ici — c'est la
            # responsabilité de set_active_app(). update() met à jour le système.

            self._save()

    def set_active_app(self, app_name: str, window_title: Optional[str] = None) -> None:
        """
        Met à jour l'application au premier plan.

        Si l'app change, invalide automatiquement le cache UI de l'ancienne app
        (les coordonnées d'une app ne sont valides que quand elle est au premier plan).
        """
        with self._lock:
            current = self._state.get("active_app", {})
            old_name = current.get("name")

            # Grounding : invalide le cache de l'ancienne app si elle change
            if old_name and old_name != app_name:
                self._invalidate_elements_for_app(old_name)
                # Déplace l'ancienne app en "previous_app"
                self._state["previous_app"] = {"name": old_name}

            # Met à jour active_app
            self._state["active_app"] = {
                "name": app_name,
                "window_title": window_title,
                "changed_at": _now_iso(),
            }
            self._save()

    def cache_element(self, app: str, window: str, query: str, x: int, y: int) -> None:
        """
        Met en cache la position UI d'un élément.
        L'entrée est marquée valide avec l'horodatage courant.
        """
        key = _make_element_key(app, window, query)
        with self._lock:
            if "element_cache" not in self._state:
                self._state["element_cache"] = {}
            self._state["element_cache"][key] = {
                "x": x,
                "y": y,
                "valid": True,
                "cached_at": _now_iso(),
            }
            self._save()

    def invalidate_element(self, app: str, window: str, query: str) -> None:
        """Marque un élément UI comme invalide (coordonnées potentiellement obsolètes)."""
        key = _make_element_key(app, window, query)
        with self._lock:
            cache = self._state.get("element_cache", {})
            if key in cache:
                cache[key]["valid"] = False
                self._save()

    def set_credits(self, agent_id: str, credits: int) -> None:
        """Sauvegarde les crédits d'un agent dans agent_market."""
        with self._lock:
            if "agent_market" not in self._state:
                self._state["agent_market"] = {}
            if "credits" not in self._state["agent_market"]:
                self._state["agent_market"]["credits"] = {}
            self._state["agent_market"]["credits"][agent_id] = int(credits)
            self._save()

    # =========================================================================
    # GROUNDING AUTOMATIQUE (interne)
    # =========================================================================

    def _invalidate_elements_for_app(self, old_app: str) -> None:
        """
        Invalide tous les éléments en cache appartenant à old_app.
        Appelé automatiquement quand l'app active change.

        ATTENTION : doit être appelé avec self._lock déjà acquis
        (pas de re-acquisition pour éviter le deadlock).
        """
        cache = self._state.get("element_cache", {})
        prefix = f"{old_app}:"
        invalidated = 0
        for key, entry in cache.items():
            if key.startswith(prefix) and entry.get("valid", False):
                entry["valid"] = False
                invalidated += 1
        # Pas de _save() ici — l'appelant s'en charge

    # =========================================================================
    # REPRÉSENTATION
    # =========================================================================

    def __repr__(self) -> str:
        app = self._state.get("active_app", {}).get("name", "—")
        cpu = self._state.get("system", {}).get("cpu_percent", "?")
        ram = self._state.get("system", {}).get("ram_percent", "?")
        return f"<WorldModel app={app!r} cpu={cpu}% ram={ram}%>"
