"""
Tests pour agent/mcp_bridge.py.

Couvre :
- Validité syntaxique du fichier
- Présence des endpoints et groupes de routes (analyse statique)
- Tests unitaires sur call_mcp() avec mocks (outil inconnu, ConnectError)
- Vérification du mapping _TOOL_ENDPOINTS
"""
import pytest
import sys
import os
import subprocess
import unittest.mock as mock

_ROOT = os.path.join(os.path.dirname(__file__), '..')
_FILE_PATH = os.path.join(_ROOT, 'agent', 'mcp_bridge.py')


# ─────────────────────────────────────────────────────────────────────────────
# Tests syntaxe (sans import)
# ─────────────────────────────────────────────────────────────────────────────

class TestMCPBridgeSyntax:
    def test_syntax_valid(self):
        """mcp_bridge.py doit être syntaxiquement valide."""
        result = subprocess.run(
            ['python3', '-m', 'py_compile', _FILE_PATH],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"Erreur syntaxe mcp_bridge.py:\n{result.stderr}"


# ─────────────────────────────────────────────────────────────────────────────
# Tests de présence des symboles clés (analyse statique)
# ─────────────────────────────────────────────────────────────────────────────

class TestMCPBridgeStaticAnalysis:
    """Vérifie la présence des endpoints et groupes de routes attendus dans mcp_bridge.py."""

    @pytest.fixture(autouse=True)
    def read_content(self):
        with open(_FILE_PATH, encoding='utf-8') as f:
            self.content = f.read()

    def test_health_endpoint(self):
        """/health endpoint doit être présent."""
        assert '"/health"' in self.content or "'/health'" in self.content

    def test_call_endpoint(self):
        """/call endpoint générique doit être présent."""
        assert '"/call"' in self.content or "'/call'" in self.content

    def test_tools_endpoint(self):
        """/tools endpoint doit être présent (liste des outils disponibles)."""
        assert '"/tools"' in self.content or "'/tools'" in self.content

    # ── Groupes OS Control ────────────────────────────────────────────────

    def test_os_click_endpoint(self):
        """/os/click endpoint doit être présent."""
        assert '"/os/click"' in self.content or "'/os/click'" in self.content

    def test_os_screenshot_endpoint(self):
        """/os/screenshot endpoint doit être présent."""
        assert '"/os/screenshot"' in self.content or "'/os/screenshot'" in self.content

    def test_os_type_endpoint(self):
        """/os/type endpoint doit être présent."""
        assert '"/os/type"' in self.content or "'/os/type'" in self.content

    # ── Terminal ──────────────────────────────────────────────────────────

    def test_terminal_exec_endpoint(self):
        """/terminal/exec endpoint doit être présent."""
        assert '"/terminal/exec"' in self.content or "'/terminal/exec'" in self.content

    def test_terminal_exec_safe_endpoint(self):
        """/terminal/exec-safe endpoint doit être présent."""
        assert '"/terminal/exec-safe"' in self.content or "'/terminal/exec-safe'" in self.content

    # ── Vision ────────────────────────────────────────────────────────────

    def test_vision_analyze_endpoint(self):
        """/vision/analyze endpoint doit être présent."""
        assert '"/vision/analyze"' in self.content or "'/vision/analyze'" in self.content

    # ── Vault ─────────────────────────────────────────────────────────────

    def test_vault_store_endpoint(self):
        """/vault/store endpoint doit être présent."""
        assert '"/vault/store"' in self.content or "'/vault/store'" in self.content

    def test_vault_search_endpoint(self):
        """/vault/search endpoint doit être présent."""
        assert '"/vault/search"' in self.content or "'/vault/search'" in self.content

    # ── Rollback ──────────────────────────────────────────────────────────

    def test_rollback_snapshot_endpoint(self):
        """/rollback/snapshot endpoint doit être présent."""
        assert '"/rollback/snapshot"' in self.content or "'/rollback/snapshot'" in self.content

    def test_rollback_restore_endpoint(self):
        """/rollback/restore endpoint doit être présent."""
        assert '"/rollback/restore"' in self.content or "'/rollback/restore'" in self.content

    # ── Skill Factory ─────────────────────────────────────────────────────

    def test_skill_factory_create_endpoint(self):
        """/skill-factory/create endpoint doit être présent."""
        assert '"/skill-factory/create"' in self.content or "'/skill-factory/create'" in self.content

    def test_skill_factory_evolve_endpoint(self):
        """/skill-factory/evolve endpoint doit être présent."""
        assert '"/skill-factory/evolve"' in self.content or "'/skill-factory/evolve'" in self.content

    # ── Janitor ───────────────────────────────────────────────────────────

    def test_janitor_purge_endpoint(self):
        """/janitor/purge-temp endpoint doit être présent."""
        assert '"/janitor/purge-temp"' in self.content or "'/janitor/purge-temp'" in self.content

    # ── Architecture ──────────────────────────────────────────────────────

    def test_call_mcp_function_defined(self):
        """call_mcp() doit être défini — c'est le proxy central."""
        assert 'async def call_mcp(' in self.content

    def test_tool_endpoints_mapping_defined(self):
        """_TOOL_ENDPOINTS doit être défini — mapping outil → endpoint."""
        assert '_TOOL_ENDPOINTS' in self.content

    def test_mcp_base_url_used(self):
        """MCP_BASE doit être défini depuis la config."""
        assert 'MCP_BASE' in self.content

    def test_mcp_timeout_used(self):
        """MCP_TIMEOUT doit être défini depuis la config."""
        assert 'MCP_TIMEOUT' in self.content

    def test_httpx_used(self):
        """httpx doit être utilisé pour les appels HTTP."""
        assert 'import httpx' in self.content

    def test_connect_error_handled(self):
        """ConnectError doit être intercepté (queen Node.js non démarrée)."""
        assert 'ConnectError' in self.content

    def test_http_status_error_handled(self):
        """HTTPStatusError doit être intercepté."""
        assert 'HTTPStatusError' in self.content

    def test_mcp_request_model_defined(self):
        """MCPRequest pydantic model doit être défini."""
        assert 'class MCPRequest(' in self.content

    def test_node_base_url_config_key(self):
        """node_base_url doit être référencé depuis la config mcp."""
        assert 'node_base_url' in self.content

    def test_7_known_tools_referenced(self):
        """Les 7 outils MCP doivent être référencés (os-control, terminal, vision, vault, rollback, skill-factory, janitor)."""
        for tool in ["os-control", "terminal", "vision", "vault", "rollback", "skill-factory", "janitor"]:
            assert tool in self.content, f"Outil MCP '{tool}' non trouvé dans mcp_bridge.py"


# ─────────────────────────────────────────────────────────────────────────────
# Tests importés de mcp_bridge.py (avec mocks)
# ─────────────────────────────────────────────────────────────────────────────

MCP_BRIDGE_AVAILABLE = False
_mcp_bridge_mod = None

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
    "mcp": {
        "node_base_url": "http://localhost:3000",
        "timeout": 30,
        "tools": [
            {"name": "os-control", "endpoint": "/mcp/os-control"},
            {"name": "terminal", "endpoint": "/mcp/terminal"},
            {"name": "vision", "endpoint": "/mcp/vision"},
            {"name": "vault", "endpoint": "/mcp/vault"},
            {"name": "rollback", "endpoint": "/mcp/rollback"},
            {"name": "skill-factory", "endpoint": "/mcp/skill-factory"},
            {"name": "janitor", "endpoint": "/mcp/janitor"},
        ],
    },
}

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))
    with mock.patch('builtins.open', mock.mock_open(read_data="")), \
         mock.patch('yaml.safe_load', return_value=MOCK_CONFIG):
        if 'mcp_bridge' in sys.modules:
            del sys.modules['mcp_bridge']
        import mcp_bridge as _mcp_bridge_mod
    MCP_BRIDGE_AVAILABLE = True
except Exception as _mcp_bridge_err:
    print(f"[test] mcp_bridge non importable: {_mcp_bridge_err}")


@pytest.mark.skipif(not MCP_BRIDGE_AVAILABLE, reason="mcp_bridge non importable")
class TestToolEndpointsMapping:
    """Teste le mapping _TOOL_ENDPOINTS construit depuis la config."""

    def test_7_tools_loaded(self):
        """7 outils MCP doivent être chargés depuis la config."""
        assert len(_mcp_bridge_mod._TOOL_ENDPOINTS) == 7

    def test_os_control_mapped(self):
        """os-control doit pointer vers /mcp/os-control."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("os-control") == "/mcp/os-control"

    def test_terminal_mapped(self):
        """terminal doit pointer vers /mcp/terminal."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("terminal") == "/mcp/terminal"

    def test_vision_mapped(self):
        """vision doit pointer vers /mcp/vision."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("vision") == "/mcp/vision"

    def test_vault_mapped(self):
        """vault doit pointer vers /mcp/vault."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("vault") == "/mcp/vault"

    def test_rollback_mapped(self):
        """rollback doit pointer vers /mcp/rollback."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("rollback") == "/mcp/rollback"

    def test_skill_factory_mapped(self):
        """skill-factory doit pointer vers /mcp/skill-factory."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("skill-factory") == "/mcp/skill-factory"

    def test_janitor_mapped(self):
        """janitor doit pointer vers /mcp/janitor."""
        assert _mcp_bridge_mod._TOOL_ENDPOINTS.get("janitor") == "/mcp/janitor"

    def test_mcp_base_url_set(self):
        """MCP_BASE doit correspondre à node_base_url de la config."""
        assert _mcp_bridge_mod.MCP_BASE == "http://localhost:3000"

    def test_mcp_timeout_set(self):
        """MCP_TIMEOUT doit correspondre à timeout de la config."""
        assert _mcp_bridge_mod.MCP_TIMEOUT == 30


@pytest.mark.skipif(not MCP_BRIDGE_AVAILABLE, reason="mcp_bridge non importable")
class TestCallMCP:
    """Teste call_mcp() en isolation via mocks httpx."""

    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error(self):
        """call_mcp() avec outil inconnu doit retourner une erreur sans appel HTTP."""
        result = await _mcp_bridge_mod.call_mcp("outil-inexistant", "action", {})
        assert "error" in result
        assert "outil-inexistant" in result["error"].lower() or "inconnu" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_unknown_tool_lists_known_tools(self):
        """call_mcp() avec outil inconnu doit lister les outils connus."""
        result = await _mcp_bridge_mod.call_mcp("outil-inexistant", "action", {})
        assert "known_tools" in result
        assert isinstance(result["known_tools"], list)
        assert len(result["known_tools"]) == 7

    @pytest.mark.asyncio
    async def test_connect_error_returns_error_dict(self):
        """call_mcp() doit retourner un dict d'erreur si Node.js non démarrée."""
        import httpx

        async def mock_post(*args, **kwargs):
            raise httpx.ConnectError("connexion refusée")

        mock_client = mock.AsyncMock()
        mock_client.__aenter__ = mock.AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = mock.AsyncMock(return_value=False)
        mock_client.post = mock_post

        with mock.patch('httpx.AsyncClient', return_value=mock_client):
            result = await _mcp_bridge_mod.call_mcp("terminal", "exec", {"cmd": "ls"})
        assert "error" in result

    @pytest.mark.asyncio
    async def test_successful_call_returns_json(self):
        """call_mcp() doit retourner le JSON de la réponse si succès."""
        import httpx

        mock_response = mock.Mock()
        mock_response.status_code = 200
        mock_response.raise_for_status = mock.Mock()
        mock_response.json = mock.Mock(return_value={"result": "ok", "output": "done"})

        mock_client = mock.AsyncMock()
        mock_client.__aenter__ = mock.AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = mock.AsyncMock(return_value=False)
        mock_client.post = mock.AsyncMock(return_value=mock_response)

        with mock.patch('httpx.AsyncClient', return_value=mock_client):
            result = await _mcp_bridge_mod.call_mcp("terminal", "exec", {"cmd": "ls"})
        assert result == {"result": "ok", "output": "done"}

    @pytest.mark.asyncio
    async def test_call_builds_correct_url(self):
        """call_mcp() doit construire l'URL MCP_BASE + endpoint."""
        import httpx

        captured_url = {}

        async def mock_post(url, json=None, **kwargs):
            captured_url["url"] = url
            resp = mock.Mock()
            resp.raise_for_status = mock.Mock()
            resp.json = mock.Mock(return_value={})
            return resp

        mock_client = mock.AsyncMock()
        mock_client.__aenter__ = mock.AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = mock.AsyncMock(return_value=False)
        mock_client.post = mock_post

        with mock.patch('httpx.AsyncClient', return_value=mock_client):
            await _mcp_bridge_mod.call_mcp("terminal", "exec", {"cmd": "ls"})

        assert captured_url.get("url") == "http://localhost:3000/mcp/terminal"

    @pytest.mark.asyncio
    async def test_call_sends_correct_payload(self):
        """call_mcp() doit envoyer {action, params} dans le body."""
        captured_payload = {}

        async def mock_post(url, json=None, **kwargs):
            captured_payload.update(json or {})
            resp = mock.Mock()
            resp.raise_for_status = mock.Mock()
            resp.json = mock.Mock(return_value={})
            return resp

        mock_client = mock.AsyncMock()
        mock_client.__aenter__ = mock.AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = mock.AsyncMock(return_value=False)
        mock_client.post = mock_post

        with mock.patch('httpx.AsyncClient', return_value=mock_client):
            await _mcp_bridge_mod.call_mcp("vault", "storeExperience", {"key": "val"})

        assert captured_payload.get("action") == "storeExperience"
        assert captured_payload.get("params") == {"key": "val"}
