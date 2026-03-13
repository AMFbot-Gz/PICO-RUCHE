"""
Tests pour agent/memory.py.

Couvre :
- _read_episodes_safe() : lecture robuste JSONL (lignes corrompues, fichier vide)
- _trim_episodes_if_needed() : logique de troncature (MAX_EPISODES=500)
- Intégration FastAPI via TestClient (si importable)
"""
import pytest
import asyncio
import json
import tempfile
from pathlib import Path
import sys
import os
import unittest.mock as mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _write_episodes(filepath: Path, n: int):
    """Écrit n épisodes factices dans filepath."""
    with open(filepath, 'w', encoding='utf-8') as f:
        for i in range(n):
            f.write(json.dumps({
                "id": f"ep-{i}",
                "mission": f"test mission {i}",
                "result": f"résultat {i}",
                "success": True,
                "duration_ms": 100 + i,
                "model_used": "test",
                "ts": f"2026-01-{(i % 28) + 1:02d}T00:00:00Z"
            }) + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# Tests de la logique de trim (autonomes — pas besoin d'importer memory.py)
# ─────────────────────────────────────────────────────────────────────────────

class TestEpisodesTrim:
    """Teste la logique de trim JSONL directement (miroir de _trim_episodes_if_needed)."""

    def test_trim_keeps_max_episodes(self, tmp_path):
        """Le trim doit garder seulement les MAX_EPISODES derniers épisodes."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 600)

        MAX_EPISODES = 500
        lines = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(lines) == 600, "Précondition: 600 épisodes créés"

        if len(lines) > MAX_EPISODES:
            kept = lines[-MAX_EPISODES:]
            ep_file.write_text("\n".join(kept) + "\n", encoding='utf-8')

        result = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(result) == MAX_EPISODES, (
            f"Après trim: {len(result)} épisodes (attendu {MAX_EPISODES})"
        )

    def test_trim_keeps_most_recent(self, tmp_path):
        """Le trim doit conserver les épisodes les plus récents (queue = fin du fichier)."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 600)

        MAX_EPISODES = 500
        lines = [l for l in ep_file.read_text().splitlines() if l.strip()]
        kept = lines[-MAX_EPISODES:]
        ep_file.write_text("\n".join(kept) + "\n", encoding='utf-8')

        result_lines = [l for l in ep_file.read_text().splitlines() if l.strip()]
        first_ep = json.loads(result_lines[0])
        last_ep = json.loads(result_lines[-1])
        # Épisodes 100..599 conservés (les 500 derniers)
        assert first_ep["id"] == "ep-100", (
            f"Premier épisode conservé doit être ep-100, got {first_ep['id']}"
        )
        assert last_ep["id"] == "ep-599", (
            f"Dernier épisode doit être ep-599, got {last_ep['id']}"
        )

    def test_no_trim_under_limit(self, tmp_path):
        """Pas de modification si nombre d'épisodes < MAX_EPISODES."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 100)

        MAX_EPISODES = 500
        lines_before = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(lines_before) == 100

        # Simule la condition de trim : rien à faire
        if len(lines_before) <= MAX_EPISODES:
            pass  # Pas de trim
        lines_after = [l for l in ep_file.read_text().splitlines() if l.strip()]

        assert len(lines_after) == 100, "Pas de modification si < 500 épisodes"

    def test_trim_exact_limit_no_change(self, tmp_path):
        """Exactement MAX_EPISODES épisodes — pas de trim."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 500)

        MAX_EPISODES = 500
        lines = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(lines) == 500

        # Pas de trim si <= MAX_EPISODES
        if len(lines) > MAX_EPISODES:
            kept = lines[-MAX_EPISODES:]
            ep_file.write_text("\n".join(kept) + "\n", encoding='utf-8')

        result = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(result) == 500, "Exactement 500 épisodes — pas de trim"

    def test_trim_single_episode(self, tmp_path):
        """Cas limite : 1 seul épisode, pas de trim."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 1)

        MAX_EPISODES = 500
        lines = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(lines) == 1

        if len(lines) > MAX_EPISODES:
            kept = lines[-MAX_EPISODES:]
            ep_file.write_text("\n".join(kept) + "\n", encoding='utf-8')

        result = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(result) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Tests de _read_episodes_safe() — directement depuis memory.py
# ─────────────────────────────────────────────────────────────────────────────

MEMORY_AVAILABLE = False
_read_episodes_safe = None

try:
    _root = Path(__file__).resolve().parent.parent
    _config_path = _root / "agent_config.yml"

    import yaml
    with open(_config_path) as _f:
        _real_config = yaml.safe_load(_f)

    # Patch les fichiers que memory.py tente de créer au module-level
    _episode_file = _root / _real_config["memory"]["episode_file"]
    _world_state = _root / _real_config["memory"]["world_state_file"]
    _episode_file.parent.mkdir(parents=True, exist_ok=True)
    if not _episode_file.exists():
        _episode_file.write_text("")
    if not _world_state.exists():
        _world_state.write_text("{}")

    if 'memory' in sys.modules:
        del sys.modules['memory']
    import memory as _memory_mod
    _read_episodes_safe = _memory_mod._read_episodes_safe
    _trim_episodes_if_needed = _memory_mod._trim_episodes_if_needed
    MEMORY_AVAILABLE = True
except Exception as _mem_err:
    print(f"[test] memory non importable: {_mem_err}")


@pytest.mark.skipif(not MEMORY_AVAILABLE, reason="memory non importable")
class TestReadEpisodesSafe:
    """Teste _read_episodes_safe() — lecture JSONL robuste."""

    def test_empty_file_returns_empty_list(self, tmp_path):
        """Fichier vide → liste vide."""
        ep_file = tmp_path / "episodes.jsonl"
        ep_file.write_text("", encoding='utf-8')
        result = _read_episodes_safe(ep_file)
        assert result == []

    def test_nonexistent_file_returns_empty_list(self, tmp_path):
        """Fichier inexistant → liste vide."""
        ep_file = tmp_path / "nonexistent.jsonl"
        result = _read_episodes_safe(ep_file)
        assert result == []

    def test_valid_episodes_parsed(self, tmp_path):
        """Épisodes valides → liste correctement parsée."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 5)
        result = _read_episodes_safe(ep_file)
        assert len(result) == 5
        assert result[0]["id"] == "ep-0"
        assert result[4]["id"] == "ep-4"

    def test_corrupted_line_skipped(self, tmp_path):
        """Ligne JSON corrompue → ignorée, les autres sont parsées."""
        ep_file = tmp_path / "episodes.jsonl"
        ep_file.write_text(
            '{"mission": "ok1", "success": true}\n'
            'LIGNE_CORROMPUE_PAS_DU_JSON\n'
            '{"mission": "ok2", "success": false}\n',
            encoding='utf-8'
        )
        result = _read_episodes_safe(ep_file)
        assert len(result) == 2
        assert result[0]["mission"] == "ok1"
        assert result[1]["mission"] == "ok2"

    def test_all_corrupted_returns_empty(self, tmp_path):
        """Toutes les lignes corrompues → liste vide."""
        ep_file = tmp_path / "episodes.jsonl"
        ep_file.write_text(
            'pas du json\nceci non plus\n{mauvais}\n',
            encoding='utf-8'
        )
        result = _read_episodes_safe(ep_file)
        assert result == []

    def test_blank_lines_ignored(self, tmp_path):
        """Lignes vides → ignorées."""
        ep_file = tmp_path / "episodes.jsonl"
        ep_file.write_text(
            '\n'
            '{"mission": "valide"}\n'
            '\n'
            '\n'
            '{"mission": "aussi valide"}\n'
            '\n',
            encoding='utf-8'
        )
        result = _read_episodes_safe(ep_file)
        assert len(result) == 2

    def test_unicode_content_preserved(self, tmp_path):
        """Contenu unicode (accents, emoji) → préservé."""
        ep_file = tmp_path / "episodes.jsonl"
        ep_file.write_text(
            '{"mission": "Vérifier l\'état de la ruche 🐝", "success": true}\n',
            encoding='utf-8'
        )
        result = _read_episodes_safe(ep_file)
        assert len(result) == 1
        assert "ruche" in result[0]["mission"]


@pytest.mark.skipif(not MEMORY_AVAILABLE, reason="memory non importable")
class TestTrimEpisodesAsync:
    """Teste _trim_episodes_if_needed() — la vraie fonction async de memory.py."""

    @pytest.mark.asyncio
    async def test_trim_reduces_to_max(self, tmp_path):
        """600 épisodes → réduit à 500 après trim."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 600)
        await _trim_episodes_if_needed(ep_file, 500)
        lines = [l for l in ep_file.read_text().splitlines() if l.strip()]
        assert len(lines) == 500

    @pytest.mark.asyncio
    async def test_trim_no_change_under_max(self, tmp_path):
        """100 épisodes, max=500 → aucune modification."""
        ep_file = tmp_path / "episodes.jsonl"
        _write_episodes(ep_file, 100)
        content_before = ep_file.read_text()
        await _trim_episodes_if_needed(ep_file, 500)
        content_after = ep_file.read_text()
        assert content_before == content_after

    @pytest.mark.asyncio
    async def test_trim_nonexistent_file_no_error(self, tmp_path):
        """Fichier inexistant → pas d'exception."""
        ep_file = tmp_path / "nonexistent.jsonl"
        # Ne doit pas lever d'exception
        await _trim_episodes_if_needed(ep_file, 500)


# ─────────────────────────────────────────────────────────────────────────────
# Tests de l'API FastAPI memory via TestClient
# ─────────────────────────────────────────────────────────────────────────────

MEMORY_API_AVAILABLE = False
_memory_client = None

try:
    if MEMORY_AVAILABLE:
        from fastapi.testclient import TestClient
        _memory_client = TestClient(_memory_mod.app)
        MEMORY_API_AVAILABLE = True
except Exception as _api_err:
    print(f"[test] memory API non disponible: {_api_err}")


@pytest.mark.skipif(not MEMORY_API_AVAILABLE, reason="memory API non disponible")
class TestMemoryAPIHealth:
    """Teste l'endpoint /health de memory.py."""

    def test_health_ok(self):
        """GET /health → status ok."""
        r = _memory_client.get("/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert data["layer"] == "memory"
        assert "episode_count" in data
        assert "max_episodes" in data

    def test_health_max_episodes(self):
        """GET /health → max_episodes doit être 500."""
        r = _memory_client.get("/health")
        data = r.json()
        assert data["max_episodes"] == 500
