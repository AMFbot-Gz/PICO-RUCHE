"""
Tests pour agent/brain.py.

Couvre :
- Validité syntaxique du fichier
- Présence des fonctions de fallback LLM (call_openai, call_kimi, call_claude)
- claude_available() / mlx_available() en fonction des variables d'env
- estimate_tokens() — logique de comptage
- Chaîne de fallback llm() via mocks httpx
"""
import pytest
import sys
import os
import subprocess
import unittest.mock as mock

_ROOT = os.path.join(os.path.dirname(__file__), '..')
_BRAIN_PATH = os.path.join(_ROOT, 'agent', 'brain.py')

# ─────────────────────────────────────────────────────────────────────────────
# Tests syntaxe (sans import)
# ─────────────────────────────────────────────────────────────────────────────

class TestBrainSyntax:
    def test_brain_syntax_valid(self):
        """brain.py doit être syntaxiquement valide."""
        result = subprocess.run(
            ['python3', '-m', 'py_compile', _BRAIN_PATH],
            capture_output=True, text=True
        )
        assert result.returncode == 0, (
            f"Erreur syntaxe brain.py:\n{result.stderr}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests de présence des symboles clés (analyse statique)
# ─────────────────────────────────────────────────────────────────────────────

class TestBrainStaticAnalysis:
    """Vérifie la présence des fonctions et variables attendues dans brain.py."""

    @pytest.fixture(autouse=True)
    def read_content(self):
        with open(_BRAIN_PATH, encoding='utf-8') as f:
            self.content = f.read()

    def test_call_openai_defined(self):
        """call_openai() doit être défini dans brain.py."""
        assert 'call_openai' in self.content, (
            "call_openai() non trouvé dans brain.py"
        )

    def test_openai_api_key_referenced(self):
        """OPENAI_API_KEY doit être référencé dans brain.py."""
        assert 'OPENAI_API_KEY' in self.content, (
            "OPENAI_API_KEY non référencé dans brain.py"
        )

    def test_call_kimi_defined(self):
        """call_kimi() doit être défini (fallback Kimi/Moonshot)."""
        assert 'call_kimi' in self.content, (
            "call_kimi() non trouvé dans brain.py"
        )

    def test_call_claude_defined(self):
        """call_claude() doit être défini (provider prioritaire)."""
        assert 'call_claude' in self.content, (
            "call_claude() non trouvé dans brain.py"
        )

    def test_call_ollama_defined(self):
        """call_ollama() doit être défini (provider local)."""
        assert 'call_ollama' in self.content, (
            "call_ollama() non trouvé dans brain.py"
        )

    def test_call_mlx_defined(self):
        """call_mlx() doit être défini (GPU local Apple Silicon)."""
        assert 'call_mlx' in self.content, (
            "call_mlx() non trouvé dans brain.py"
        )

    def test_llm_routing_function(self):
        """llm() doit être défini — c'est le routeur principal."""
        assert 'async def llm(' in self.content, (
            "llm() non trouvé dans brain.py"
        )

    def test_fallback_chain_order(self):
        """La chaîne de fallback dans llm() doit respecter Claude→Kimi→OpenAI.
        MLX et Ollama sont disponibles comme fonctions mais pas dans le routing principal
        (Claude API est le provider prioritaire, fallback cloud uniquement).
        """
        llm_start = self.content.find('async def llm(')
        assert llm_start != -1, "Fonction llm() non trouvée"
        llm_body = self.content[llm_start:]

        claude_pos  = llm_body.find('call_claude')
        kimi_pos    = llm_body.find('call_kimi')
        openai_pos  = llm_body.find('call_openai')

        assert all(p != -1 for p in [claude_pos, kimi_pos, openai_pos]), \
            "Providers manquants dans llm() : claude, kimi ou openai introuvable"
        assert claude_pos < kimi_pos < openai_pos, (
            f"Ordre incorrect dans llm(): claude={claude_pos} kimi={kimi_pos} openai={openai_pos}"
        )
        # Les fonctions call_mlx et call_ollama doivent exister (utilisables directement)
        assert 'async def call_mlx(' in self.content, "call_mlx() doit être défini"
        assert 'async def call_ollama(' in self.content, "call_ollama() doit être défini"

    def test_compress_context_defined(self):
        """compress_context() doit être défini."""
        assert 'async def compress_context(' in self.content

    def test_estimate_tokens_defined(self):
        """estimate_tokens() doit être défini."""
        assert 'def estimate_tokens(' in self.content

    def test_anthropic_api_key_referenced(self):
        """ANTHROPIC_API_KEY doit être référencé."""
        assert 'ANTHROPIC_API_KEY' in self.content

    def test_kimi_api_key_referenced(self):
        """KIMI_API_KEY doit être référencé."""
        assert 'KIMI_API_KEY' in self.content

    def test_think_endpoint_defined(self):
        """/think endpoint doit être présent."""
        assert '"/think"' in self.content or "'/think'" in self.content

    def test_health_endpoint_defined(self):
        """/health endpoint doit être présent."""
        assert '"/health"' in self.content or "'/health'" in self.content


# ─────────────────────────────────────────────────────────────────────────────
# Tests importés de brain.py (avec mocks)
# ─────────────────────────────────────────────────────────────────────────────

BRAIN_AVAILABLE = False
_brain_mod = None

# Config mock alignée avec agent_config.yml
MOCK_CONFIG = {
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
    "mlx": {
        "enabled": False,
        "server_url": "http://127.0.0.1:8080/v1",
        "fallback_to_ollama": True,
    },
    "brain": {
        "max_context_tokens": 8000,
        "compress_threshold": 6000,
        "max_subtasks": 5,
        "risk_levels": ["low", "medium", "high"],
    },
    "ports": {
        "queen": 8001,
        "perception": 8002,
        "brain": 8003,
        "executor": 8004,
        "memory": 8006,
    },
    "memory": {
        "max_episodes": 500,
        "episode_file": "agent/memory/episodes.jsonl",
        "persistent_file": "agent/memory/persistent.md",
        "world_state_file": "agent/memory/world_state.json",
    },
    "perception": {"interval_seconds": 30},
    "telegram": {"hitl_timeout_seconds": 120},
}

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))
    with mock.patch('builtins.open', mock.mock_open(read_data="")), \
         mock.patch('yaml.safe_load', return_value=MOCK_CONFIG):
        if 'brain' in sys.modules:
            del sys.modules['brain']
        import brain as _brain_mod
    BRAIN_AVAILABLE = True
except Exception as _brain_err:
    print(f"[test] brain non importable: {_brain_err}")


@pytest.mark.skipif(not BRAIN_AVAILABLE, reason="brain non importable")
class TestBrainFunctions:
    """Teste les fonctions utilitaires de brain.py."""

    def test_estimate_tokens_empty(self):
        """Texte vide → 0 tokens."""
        result = _brain_mod.estimate_tokens("")
        assert result == 0

    def test_estimate_tokens_basic(self):
        """Texte de 400 chars → ~100 tokens (len // 4)."""
        text = "a" * 400
        result = _brain_mod.estimate_tokens(text)
        assert result == 100

    def test_estimate_tokens_proportional(self):
        """estimate_tokens croît avec la longueur du texte (division entière len // 4)."""
        # estimate_tokens utilise len(text) // 4 — la proportionnalité exacte
        # n'est garantie que si len(text) est un multiple de 4.
        # On utilise des textes dont la longueur est un multiple de 4.
        short = _brain_mod.estimate_tokens("abcd")          # 4 chars → 1 token
        long = _brain_mod.estimate_tokens("abcd" * 10)      # 40 chars → 10 tokens
        assert long == short * 10

    def test_claude_available_no_key(self):
        """claude_available() retourne False si ANTHROPIC_API_KEY absent."""
        with mock.patch.dict(os.environ, {'ANTHROPIC_API_KEY': ''}, clear=False):
            result = _brain_mod.claude_available()
            assert result is False

    def test_claude_available_with_key(self):
        """claude_available() retourne True si ANTHROPIC_API_KEY présent."""
        with mock.patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'sk-test-key'}, clear=False):
            result = _brain_mod.claude_available()
            assert result is True

    def test_claude_available_whitespace_only(self):
        """claude_available() retourne False si clé = espaces seulement."""
        with mock.patch.dict(os.environ, {'ANTHROPIC_API_KEY': '   '}, clear=False):
            result = _brain_mod.claude_available()
            assert result is False

    def test_mlx_available_disabled(self):
        """mlx_available() retourne False si mlx.enabled=False dans config."""
        # La config mockée a mlx.enabled=False
        result = _brain_mod.mlx_available()
        assert result is False

    def test_claude_model_set(self):
        """CLAUDE_MODEL doit pointer vers claude-opus-4-6."""
        assert _brain_mod.CLAUDE_MODEL == "claude-opus-4-6"


@pytest.mark.skipif(not BRAIN_AVAILABLE, reason="brain non importable")
class TestBrainCallOpenAI:
    """Teste call_openai() en isolation."""

    @pytest.mark.asyncio
    async def test_call_openai_no_key_raises(self):
        """call_openai() lève ValueError si OPENAI_API_KEY absent."""
        with mock.patch.dict(os.environ, {'OPENAI_API_KEY': ''}, clear=False):
            with pytest.raises(ValueError, match="OPENAI_API_KEY"):
                await _brain_mod.call_openai(
                    [{"role": "user", "content": "test"}]
                )

    @pytest.mark.asyncio
    async def test_call_kimi_no_key_raises(self):
        """call_kimi() lève ValueError si KIMI_API_KEY absent."""
        with mock.patch.dict(os.environ, {'KIMI_API_KEY': ''}, clear=False):
            with pytest.raises(ValueError, match="KIMI_API_KEY"):
                await _brain_mod.call_kimi(
                    [{"role": "user", "content": "test"}]
                )

    @pytest.mark.asyncio
    async def test_call_claude_no_key_raises(self):
        """call_claude() lève ValueError si ANTHROPIC_API_KEY absent."""
        with mock.patch.dict(os.environ, {'ANTHROPIC_API_KEY': ''}, clear=False):
            with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
                await _brain_mod.call_claude(
                    [{"role": "user", "content": "test"}]
                )
