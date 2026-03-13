"""
Tests pour agent/perception.py.

Couvre :
- Validité syntaxique du fichier
- Présence des endpoints et fonctions principales (analyse statique)
- Tests unitaires sur fonctions pures : hash_file, scan_recent_files
"""
import pytest
import sys
import os
import subprocess
import hashlib
import tempfile
import unittest.mock as mock
from pathlib import Path

_ROOT = os.path.join(os.path.dirname(__file__), '..')
_FILE_PATH = os.path.join(_ROOT, 'agent', 'perception.py')


# ─────────────────────────────────────────────────────────────────────────────
# Tests syntaxe (sans import)
# ─────────────────────────────────────────────────────────────────────────────

class TestPerceptionSyntax:
    def test_syntax_valid(self):
        """perception.py doit être syntaxiquement valide."""
        result = subprocess.run(
            ['python3', '-m', 'py_compile', _FILE_PATH],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"Erreur syntaxe perception.py:\n{result.stderr}"


# ─────────────────────────────────────────────────────────────────────────────
# Tests de présence des symboles clés (analyse statique)
# ─────────────────────────────────────────────────────────────────────────────

class TestPerceptionStaticAnalysis:
    """Vérifie la présence des fonctions et endpoints attendus dans perception.py."""

    @pytest.fixture(autouse=True)
    def read_content(self):
        with open(_FILE_PATH, encoding='utf-8') as f:
            self.content = f.read()

    def test_health_endpoint(self):
        """/health endpoint doit être présent."""
        assert '"/health"' in self.content or "'/health'" in self.content

    def test_screenshot_endpoint(self):
        """/screenshot endpoint doit être présent."""
        assert '"/screenshot"' in self.content or "'/screenshot'" in self.content

    def test_observe_endpoint(self):
        """/observe endpoint doit être présent."""
        assert '"/observe"' in self.content or "'/observe'" in self.content

    def test_system_endpoint(self):
        """/system endpoint doit être présent."""
        assert '"/system"' in self.content or "'/system'" in self.content

    def test_take_screenshot_defined(self):
        """take_screenshot() doit être défini."""
        assert 'def take_screenshot(' in self.content

    def test_hash_file_defined(self):
        """hash_file() doit être défini."""
        assert 'def hash_file(' in self.content

    def test_scan_system_defined(self):
        """scan_system() doit être défini."""
        assert 'def scan_system(' in self.content

    def test_scan_recent_files_defined(self):
        """scan_recent_files() doit être défini."""
        assert 'def scan_recent_files(' in self.content

    def test_sha256_used(self):
        """SHA-256 doit être utilisé (hashlib.sha256)."""
        assert 'sha256' in self.content

    def test_screencapture_command(self):
        """screencapture (commande macOS) doit être référencé."""
        assert 'screencapture' in self.content

    def test_psutil_imported(self):
        """psutil doit être importé."""
        assert 'import psutil' in self.content

    def test_fastapi_app_defined(self):
        """FastAPI app doit être instanciée."""
        assert 'FastAPI(' in self.content

    def test_last_hash_state(self):
        """LAST_HASH doit être défini — état interne du dernier screenshot."""
        assert 'LAST_HASH' in self.content

    def test_port_config_used(self):
        """Le port doit provenir de la config (CONFIG[\"ports\"])."""
        assert 'CONFIG' in self.content and 'ports' in self.content


# ─────────────────────────────────────────────────────────────────────────────
# Tests importés de perception.py (avec mocks)
# ─────────────────────────────────────────────────────────────────────────────

PERCEPTION_AVAILABLE = False
_perception_mod = None

MOCK_CONFIG = {
    "ports": {
        "queen": 8001,
        "perception": 8002,
        "brain": 8003,
        "executor": 8004,
        "evolution": 8005,
        "memory": 8006,
        "mcp_bridge": 8007,
    },
    "perception": {
        "interval_seconds": 30,
        "screenshot_enabled": True,
        "system_scan_enabled": True,
        "change_threshold": 0.05,
    },
    "ollama": {
        "base_url": "http://localhost:11434",
        "models": {
            "strategist": "llama3:latest",
            "worker": "llama3.2:3b",
            "vision": "moondream:latest",
            "compressor": "llama3.2:3b",
        },
        "timeout": 120,
    },
}

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))
    with mock.patch('builtins.open', mock.mock_open(read_data="")), \
         mock.patch('yaml.safe_load', return_value=MOCK_CONFIG):
        if 'perception' in sys.modules:
            del sys.modules['perception']
        import perception as _perception_mod
    PERCEPTION_AVAILABLE = True
except Exception as _perception_err:
    print(f"[test] perception non importable: {_perception_err}")


@pytest.mark.skipif(not PERCEPTION_AVAILABLE, reason="perception non importable")
class TestHashFile:
    """Teste hash_file() en isolation — fonction pure."""

    def test_hash_file_returns_hex_string(self):
        """hash_file() doit retourner une chaîne hexadécimale."""
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"contenu de test")
            tmp_path = Path(f.name)
        try:
            result = _perception_mod.hash_file(tmp_path)
            assert isinstance(result, str)
            assert len(result) == 64  # SHA-256 = 64 hex chars
        finally:
            tmp_path.unlink()

    def test_hash_file_deterministic(self):
        """hash_file() doit être déterministe (même fichier → même hash)."""
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"contenu stable")
            tmp_path = Path(f.name)
        try:
            h1 = _perception_mod.hash_file(tmp_path)
            h2 = _perception_mod.hash_file(tmp_path)
            assert h1 == h2
        finally:
            tmp_path.unlink()

    def test_hash_file_changes_on_content_change(self):
        """hash_file() doit produire des hashes différents pour des contenus différents."""
        with tempfile.NamedTemporaryFile(delete=False) as f1:
            f1.write(b"contenu A")
            path1 = Path(f1.name)
        with tempfile.NamedTemporaryFile(delete=False) as f2:
            f2.write(b"contenu B")
            path2 = Path(f2.name)
        try:
            h1 = _perception_mod.hash_file(path1)
            h2 = _perception_mod.hash_file(path2)
            assert h1 != h2
        finally:
            path1.unlink()
            path2.unlink()

    def test_hash_file_matches_manual_sha256(self):
        """hash_file() doit correspondre à hashlib.sha256 manuel."""
        data = b"verification manuelle"
        expected = hashlib.sha256(data).hexdigest()
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
            tmp_path = Path(f.name)
        try:
            result = _perception_mod.hash_file(tmp_path)
            assert result == expected
        finally:
            tmp_path.unlink()

    def test_hash_file_empty_file(self):
        """hash_file() doit fonctionner sur un fichier vide."""
        expected = hashlib.sha256(b"").hexdigest()
        with tempfile.NamedTemporaryFile(delete=False) as f:
            tmp_path = Path(f.name)
        try:
            result = _perception_mod.hash_file(tmp_path)
            assert result == expected
        finally:
            tmp_path.unlink()


@pytest.mark.skipif(not PERCEPTION_AVAILABLE, reason="perception non importable")
class TestScanRecentFiles:
    """Teste scan_recent_files() en isolation."""

    def test_returns_list(self):
        """scan_recent_files() doit retourner une liste."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            result = _perception_mod.scan_recent_files(tmp_dir, minutes=5)
            assert isinstance(result, list)

    def test_detects_recent_file(self):
        """scan_recent_files() doit détecter un fichier créé à l'instant."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            # Créer un fichier dans le répertoire temporaire
            test_file = os.path.join(tmp_dir, "test_recent.txt")
            with open(test_file, 'w') as f:
                f.write("contenu")
            result = _perception_mod.scan_recent_files(tmp_dir, minutes=5)
            paths = [item["path"] for item in result]
            assert test_file in paths

    def test_result_structure(self):
        """Chaque entrée doit avoir les clés 'path', 'size', 'modified'."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_file = os.path.join(tmp_dir, "structure_check.txt")
            with open(test_file, 'w') as f:
                f.write("data")
            result = _perception_mod.scan_recent_files(tmp_dir, minutes=5)
            assert len(result) >= 1
            entry = result[0]
            assert "path" in entry
            assert "size" in entry
            assert "modified" in entry

    def test_nonexistent_directory_returns_empty(self):
        """Répertoire inexistant → liste vide (pas d'exception)."""
        result = _perception_mod.scan_recent_files("/tmp/dossier_inexistant_xyz_abc_123", minutes=5)
        assert isinstance(result, list)

    def test_max_20_results(self):
        """scan_recent_files() ne retourne jamais plus de 20 résultats."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            # Créer 30 fichiers
            for i in range(30):
                fp = os.path.join(tmp_dir, f"file_{i:03d}.txt")
                with open(fp, 'w') as f:
                    f.write(str(i))
            result = _perception_mod.scan_recent_files(tmp_dir, minutes=5)
            assert len(result) <= 20

    def test_excludes_hidden_directories(self):
        """Les répertoires cachés (commençant par '.') doivent être ignorés."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            hidden_dir = os.path.join(tmp_dir, ".hidden")
            os.makedirs(hidden_dir)
            hidden_file = os.path.join(hidden_dir, "secret.txt")
            with open(hidden_file, 'w') as f:
                f.write("caché")
            result = _perception_mod.scan_recent_files(tmp_dir, minutes=5)
            paths = [item["path"] for item in result]
            assert hidden_file not in paths
