"""
Tests pour agent/evolution.py.

Couvre :
- Validité syntaxique du fichier
- Présence des endpoints et fonctions principales (analyse statique)
- Tests unitaires sur get_repair_backend() (fonction pure)
- Tests sur generate_skill() et run_tests() avec mocks
"""
import pytest
import sys
import os
import subprocess
import unittest.mock as mock

_ROOT = os.path.join(os.path.dirname(__file__), '..')
_FILE_PATH = os.path.join(_ROOT, 'agent', 'evolution.py')


# ─────────────────────────────────────────────────────────────────────────────
# Tests syntaxe (sans import)
# ─────────────────────────────────────────────────────────────────────────────

class TestEvolutionSyntax:
    def test_syntax_valid(self):
        """evolution.py doit être syntaxiquement valide."""
        result = subprocess.run(
            ['python3', '-m', 'py_compile', _FILE_PATH],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"Erreur syntaxe evolution.py:\n{result.stderr}"


# ─────────────────────────────────────────────────────────────────────────────
# Tests de présence des symboles clés (analyse statique)
# ─────────────────────────────────────────────────────────────────────────────

class TestEvolutionStaticAnalysis:
    """Vérifie la présence des fonctions et endpoints attendus dans evolution.py."""

    @pytest.fixture(autouse=True)
    def read_content(self):
        with open(_FILE_PATH, encoding='utf-8') as f:
            self.content = f.read()

    def test_health_endpoint(self):
        """/health endpoint doit être présent."""
        assert '"/health"' in self.content or "'/health'" in self.content

    def test_repair_endpoint(self):
        """/repair endpoint doit être présent."""
        assert '"/repair"' in self.content or "'/repair'" in self.content

    def test_generate_skill_endpoint(self):
        """/generate-skill endpoint doit être présent."""
        assert '"/generate-skill"' in self.content or "'/generate-skill'" in self.content

    def test_self_repair_loop_endpoint(self):
        """/self-repair-loop endpoint doit être présent."""
        assert '"/self-repair-loop"' in self.content or "'/self-repair-loop'" in self.content

    def test_analyze_failures_endpoint(self):
        """/analyze-failures endpoint doit être présent."""
        assert '"/analyze-failures"' in self.content or "'/analyze-failures'" in self.content

    def test_skills_endpoint(self):
        """/skills endpoint doit être présent."""
        assert '"/skills"' in self.content or "'/skills'" in self.content

    def test_repair_file_defined(self):
        """repair_file() doit être défini."""
        assert 'async def repair_file(' in self.content

    def test_run_tests_defined(self):
        """run_tests() doit être défini."""
        assert 'async def run_tests(' in self.content

    def test_generate_skill_defined(self):
        """generate_skill() doit être défini."""
        assert 'async def generate_skill(' in self.content

    def test_analyze_failures_defined(self):
        """analyze_failures() doit être défini."""
        assert 'async def analyze_failures(' in self.content

    def test_get_repair_backend_defined(self):
        """get_repair_backend() doit être défini."""
        assert 'def get_repair_backend(' in self.content

    def test_skills_dir_defined(self):
        """SKILLS_DIR doit être défini."""
        assert 'SKILLS_DIR' in self.content

    def test_repair_request_model(self):
        """RepairRequest pydantic model doit être défini."""
        assert 'class RepairRequest(' in self.content

    def test_skill_request_model(self):
        """SkillRequest pydantic model doit être défini."""
        assert 'class SkillRequest(' in self.content

    def test_self_repair_loop_model(self):
        """SelfRepairLoopRequest pydantic model doit être défini."""
        assert 'class SelfRepairLoopRequest(' in self.content

    def test_claude_or_aider_backend(self):
        """Les backends 'claude' et 'aider' doivent être référencés."""
        assert '"claude"' in self.content or "'claude'" in self.content
        assert '"aider"' in self.content or "'aider'" in self.content

    def test_timeout_120_defined(self):
        """Un timeout de 120s doit être défini pour les opérations longues."""
        assert '120' in self.content

    def test_fastapi_app_defined(self):
        """FastAPI app doit être instanciée."""
        assert 'FastAPI(' in self.content

    def test_httpx_imported(self):
        """httpx doit être importé (appels vers brain et memory)."""
        assert 'import httpx' in self.content

    def test_syntax_error_detection(self):
        """La logique de détection d'erreurs syntaxiques doit être présente (compile)."""
        assert 'compile(' in self.content or 'SyntaxError' in self.content


# ─────────────────────────────────────────────────────────────────────────────
# Tests importés de evolution.py (avec mocks)
# ─────────────────────────────────────────────────────────────────────────────

EVOLUTION_AVAILABLE = False
_evolution_mod = None

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
    "ollama": {
        "base_url": "http://localhost:11434",
        "models": {
            "strategist": "llama3:latest",
            "worker": "llama3.2:3b",
        },
        "timeout": 120,
    },
    "memory": {
        "max_episodes": 500,
        "episode_file": "agent/memory/episodes.jsonl",
        "persistent_file": "agent/memory/persistent.md",
        "world_state_file": "agent/memory/world_state.json",
    },
}

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))
    with mock.patch('builtins.open', mock.mock_open(read_data="")), \
         mock.patch('yaml.safe_load', return_value=MOCK_CONFIG), \
         mock.patch('pathlib.Path.mkdir'):
        if 'evolution' in sys.modules:
            del sys.modules['evolution']
        import evolution as _evolution_mod
    EVOLUTION_AVAILABLE = True
except Exception as _evolution_err:
    print(f"[test] evolution non importable: {_evolution_err}")


@pytest.mark.skipif(not EVOLUTION_AVAILABLE, reason="evolution non importable")
class TestGetRepairBackend:
    """Teste get_repair_backend() — sélection du backend de réparation."""

    def test_returns_claude_when_available(self):
        """get_repair_backend() doit retourner 'claude' si claude est dans PATH."""
        with mock.patch('subprocess.run') as mock_run:
            mock_run.return_value = mock.Mock(returncode=0)
            result = _evolution_mod.get_repair_backend()
            assert result == "claude"

    def test_returns_aider_when_claude_absent(self):
        """get_repair_backend() doit retourner 'aider' si seulement aider disponible."""
        def side_effect(cmd, **kwargs):
            if cmd[1] == "claude":
                raise FileNotFoundError
            return mock.Mock(returncode=0)

        with mock.patch('subprocess.run', side_effect=side_effect):
            result = _evolution_mod.get_repair_backend()
            assert result == "aider"

    def test_returns_none_when_neither_available(self):
        """get_repair_backend() doit retourner None si ni claude ni aider disponibles."""
        with mock.patch('subprocess.run', side_effect=FileNotFoundError):
            result = _evolution_mod.get_repair_backend()
            assert result is None

    def test_returns_string_or_none(self):
        """get_repair_backend() doit retourner str ou None, jamais autre chose."""
        with mock.patch('subprocess.run', side_effect=FileNotFoundError):
            result = _evolution_mod.get_repair_backend()
            assert result is None or isinstance(result, str)


@pytest.mark.skipif(not EVOLUTION_AVAILABLE, reason="evolution non importable")
class TestRepairFile:
    """Teste repair_file() avec mocks."""

    @pytest.mark.asyncio
    async def test_repair_file_no_backend(self):
        """repair_file() doit retourner success=False si aucun backend disponible."""
        with mock.patch.object(_evolution_mod, 'get_repair_backend', return_value=None):
            result = await _evolution_mod.repair_file("/some/file.py", "SomeError")
            assert result["success"] is False
            assert "error" in result

    @pytest.mark.asyncio
    async def test_repair_file_claude_timeout(self):
        """repair_file() doit gérer le timeout gracieusement."""
        with mock.patch.object(_evolution_mod, 'get_repair_backend', return_value="claude"), \
             mock.patch('subprocess.run', side_effect=subprocess.TimeoutExpired(cmd=[], timeout=120)):
            result = await _evolution_mod.repair_file("/some/file.py", "SomeError")
            assert result["success"] is False
            assert "Timeout" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_repair_file_success(self):
        """repair_file() doit retourner success=True si le subprocess réussit."""
        mock_proc = mock.Mock(returncode=0, stdout="Fixed!", stderr="")
        with mock.patch.object(_evolution_mod, 'get_repair_backend', return_value="claude"), \
             mock.patch('subprocess.run', return_value=mock_proc):
            result = await _evolution_mod.repair_file("/some/file.py", "SomeError")
            assert result["success"] is True
            assert result["backend"] == "claude"


@pytest.mark.skipif(not EVOLUTION_AVAILABLE, reason="evolution non importable")
class TestRunTests:
    """Teste run_tests() avec mocks."""

    @pytest.mark.asyncio
    async def test_run_tests_npm_not_found(self):
        """run_tests() doit gérer FileNotFoundError si npm absent."""
        with mock.patch('subprocess.run', side_effect=FileNotFoundError):
            result = await _evolution_mod.run_tests()
            assert result["success"] is False
            assert "npm" in result.get("error", "").lower()

    @pytest.mark.asyncio
    async def test_run_tests_success_counts_passing(self):
        """run_tests() doit compter les tests passants dans l'output."""
        mock_proc = mock.Mock(
            returncode=0,
            stdout="passing: 5\npassing: 3\n",
            stderr=""
        )
        with mock.patch('subprocess.run', return_value=mock_proc):
            result = await _evolution_mod.run_tests()
            assert result["success"] is True
            assert result["passed"] >= 2  # au moins 2 occurrences de "passing"

    @pytest.mark.asyncio
    async def test_run_tests_returns_dict_keys(self):
        """run_tests() doit retourner un dict avec les clés attendues."""
        with mock.patch('subprocess.run', side_effect=FileNotFoundError):
            result = await _evolution_mod.run_tests()
            assert "success" in result
            assert "error" in result
