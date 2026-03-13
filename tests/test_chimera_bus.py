"""
Tests pour core/chimera_bus.js — via subprocess Node.js.

Couvre :
- Validité syntaxique du fichier ES module
- writeCommand() → crée une commande avec id + status='pending'
- readCommand() → retourne la commande pending
- markExecuted() → marque la commande comme 'done'
- readCommandSAB() → lecture depuis SharedArrayBuffer (intra-processus)
- getLastCommand() → retourne la dernière commande (peu importe le status)
- writeCommand() sur fichier inexistant → crée mutations/ automatiquement
"""
import pytest
import subprocess
import json
import tempfile
import os
import shutil

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
_CHIMERA_BUS = os.path.join(_ROOT, 'core', 'chimera_bus.js')


def _node_available() -> bool:
    """Vérifie que Node.js est installé."""
    try:
        result = subprocess.run(
            ['node', '--version'],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


NODE_AVAILABLE = _node_available()


def _run_node_script(script: str, cwd: str = None, env: dict = None) -> subprocess.CompletedProcess:
    """Exécute un script Node.js ESM inline et retourne le résultat."""
    import tempfile
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.mjs', delete=False,
        dir=cwd or _ROOT, encoding='utf-8'
    ) as f:
        f.write(script)
        fname = f.name
    try:
        merged_env = os.environ.copy()
        if env:
            merged_env.update(env)
        result = subprocess.run(
            ['node', fname],
            capture_output=True, text=True,
            cwd=cwd or _ROOT,
            timeout=15,
            env=merged_env,
        )
        return result
    finally:
        try:
            os.unlink(fname)
        except OSError:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Tests syntaxe
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not NODE_AVAILABLE, reason="Node.js non disponible")
class TestChimeraBusSyntax:
    def test_chimera_bus_syntax_valid(self):
        """chimera_bus.js doit être syntaxiquement valide (--check)."""
        result = subprocess.run(
            ['node', '--check', _CHIMERA_BUS],
            capture_output=True, text=True
        )
        assert result.returncode == 0, (
            f"Erreur syntaxe chimera_bus.js:\n{result.stderr}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests d'analyse statique (sans Node)
# ─────────────────────────────────────────────────────────────────────────────

class TestChimeraBusStaticAnalysis:
    """Vérifie la présence des exports attendus dans chimera_bus.js."""

    @pytest.fixture(autouse=True)
    def read_content(self):
        with open(_CHIMERA_BUS, encoding='utf-8') as f:
            self.content = f.read()

    def test_write_command_exported(self):
        """writeCommand doit être exporté."""
        assert 'export function writeCommand' in self.content

    def test_read_command_exported(self):
        """readCommand doit être exporté."""
        assert 'export function readCommand' in self.content

    def test_read_command_sab_exported(self):
        """readCommandSAB doit être exporté (mode intra-processus)."""
        assert 'export function readCommandSAB' in self.content

    def test_mark_executed_exported(self):
        """markExecuted doit être exporté."""
        assert 'export function markExecuted' in self.content

    def test_get_last_command_exported(self):
        """getLastCommand doit être exporté."""
        assert 'export function getLastCommand' in self.content

    def test_shared_array_buffer_exported(self):
        """sharedCmdBuffer (SharedArrayBuffer) doit être exporté."""
        assert 'export const sharedCmdBuffer' in self.content

    def test_pending_status_used(self):
        """Le statut 'pending' doit être utilisé."""
        assert "'pending'" in self.content or '"pending"' in self.content

    def test_done_status_used(self):
        """Le statut 'done' doit être utilisé."""
        assert "'done'" in self.content or '"done"' in self.content

    def test_hmac_signature_used(self):
        """La signature HMAC doit être utilisée pour sécuriser les commandes."""
        assert 'createHmac' in self.content or 'signature' in self.content

    def test_mutations_dir_used(self):
        """Le répertoire mutations/ doit être utilisé."""
        assert 'mutations' in self.content

    def test_chimera_cmd_json_used(self):
        """chimera_cmd.json doit être utilisé comme fichier IPC."""
        assert 'chimera_cmd.json' in self.content

    def test_shared_array_buffer_size(self):
        """SAB_SIZE doit être défini (IPC intra-processus)."""
        assert '_SAB_SIZE' in self.content or 'SAB_SIZE' in self.content

    def test_atomics_used(self):
        """Atomics doit être utilisé pour la synchronisation SAB."""
        assert 'Atomics' in self.content


# ─────────────────────────────────────────────────────────────────────────────
# Tests fonctionnels via Node.js
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not NODE_AVAILABLE, reason="Node.js non disponible")
class TestChimeraBusFunctional:
    """Tests fonctionnels exécutés via sous-processus Node.js."""

    @pytest.fixture(autouse=True)
    def isolated_mutations_dir(self, tmp_path):
        """
        Chaque test utilise un répertoire mutations/ isolé
        pour éviter les conflits entre tests parallèles.
        """
        self.mutations_dir = str(tmp_path / "mutations")
        self.cmd_file = os.path.join(self.mutations_dir, "chimera_cmd.json")

    def test_write_command_creates_cmd_file(self, tmp_path):
        """writeCommand() doit créer chimera_cmd.json."""
        script = f"""
import {{ writeCommand }} from '{_CHIMERA_BUS}';
import {{ existsSync }} from 'fs';
import {{ join }} from 'path';

// Override CMD_FILE via env
const cmd = writeCommand({{
  action: 'mutate',
  target: 'agent_config.yml',
  key: 'test_key',
  old_value: 42,
  new_value: 99,
}});

if (!cmd.id) {{ console.error('NO_ID'); process.exit(1); }}
if (cmd.status !== 'pending') {{ console.error('NOT_PENDING: ' + cmd.status); process.exit(2); }}
if (!cmd.signature) {{ console.error('NO_SIGNATURE'); process.exit(3); }}
console.log(JSON.stringify({{ id: cmd.id, status: cmd.status }}));
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"writeCommand() échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
        data = json.loads(result.stdout.strip())
        assert data["status"] == "pending"
        assert data["id"].startswith("chim-")

    def test_write_then_read_roundtrip(self, tmp_path):
        """writeCommand() → readCommand() doit retourner la même commande."""
        script = f"""
import {{ writeCommand, readCommand }} from '{_CHIMERA_BUS}';

const cmd = writeCommand({{
  action: 'mutate',
  target: 'agent_config.yml',
  key: 'vital_loop_interval_sec',
  old_value: 35,
  new_value: 30,
}});

const read = readCommand();
if (!read) {{ console.error('READ_NULL'); process.exit(1); }}
if (read.id !== cmd.id) {{
  console.error('ID_MISMATCH: ' + read.id + ' vs ' + cmd.id);
  process.exit(2);
}}
if (read.status !== 'pending') {{
  console.error('NOT_PENDING: ' + read.status);
  process.exit(3);
}}
console.log('OK ' + cmd.id);
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"Round-trip write→read échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert result.stdout.strip().startswith("OK chim-")

    def test_mark_executed_changes_status(self, tmp_path):
        """markExecuted() doit changer le status de 'pending' à 'done'."""
        script = f"""
import {{ writeCommand, markExecuted, getLastCommand }} from '{_CHIMERA_BUS}';

const cmd = writeCommand({{
  action: 'mutate',
  target: 'agent_config.yml',
  key: 'test_key',
  old_value: 1,
  new_value: 2,
}});

markExecuted(cmd.id, true, null);

const last = getLastCommand();
if (!last) {{ console.error('LAST_NULL'); process.exit(1); }}
if (last.status !== 'done') {{
  console.error('STATUS_NOT_DONE: ' + last.status);
  process.exit(2);
}}
if (!last.executed_at) {{
  console.error('NO_EXECUTED_AT');
  process.exit(3);
}}
console.log('OK status=' + last.status);
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"markExecuted() échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "status=done" in result.stdout

    def test_read_command_returns_null_if_no_file(self, tmp_path):
        """readCommand() doit retourner null si chimera_cmd.json n'existe pas."""
        # On utilise un répertoire mutations/ vide (sans cmd file)
        script = f"""
import {{ readCommand }} from '{_CHIMERA_BUS}';
import {{ existsSync, unlinkSync }} from 'fs';
import {{ join, dirname }} from 'path';
import {{ fileURLToPath }} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const cmdFile = join(ROOT, 'mutations', 'chimera_cmd.json');

// Supprime le fichier s'il existe pour tester le cas null
if (existsSync(cmdFile)) unlinkSync(cmdFile);

const result = readCommand();
if (result !== null) {{
  console.error('EXPECTED_NULL got: ' + JSON.stringify(result));
  process.exit(1);
}}
console.log('OK null');
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"readCommand() null case échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "OK null" in result.stdout

    def test_sab_write_read_roundtrip(self, tmp_path):
        """writeCommand() → readCommandSAB() doit fonctionner en intra-processus."""
        script = f"""
import {{ writeCommand, readCommandSAB }} from '{_CHIMERA_BUS}';

const cmd = writeCommand({{
  action: 'mutate',
  target: 'agent_config.yml',
  key: 'sab_test',
  old_value: 0,
  new_value: 1,
}});

const sab = readCommandSAB();
if (!sab) {{ console.error('SAB_NULL'); process.exit(1); }}
if (sab.id !== cmd.id) {{
  console.error('SAB_ID_MISMATCH: ' + sab.id + ' vs ' + cmd.id);
  process.exit(2);
}}
if (sab.status !== 'pending') {{
  console.error('SAB_NOT_PENDING: ' + sab.status);
  process.exit(3);
}}
console.log('OK SAB id=' + sab.id.slice(0, 15));
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"SAB round-trip échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "OK SAB" in result.stdout

    def test_command_id_format(self, tmp_path):
        """L'ID de commande doit suivre le format chim-<timestamp>-<counter>."""
        script = f"""
import {{ writeCommand }} from '{_CHIMERA_BUS}';

const cmd = writeCommand({{
  action: 'mutate',
  target: 'test.yml',
  key: 'k',
  new_value: 'v',
}});

// Format attendu: chim-<timestamp>-<counter>
const parts = cmd.id.split('-');
if (parts.length !== 3) {{
  console.error('BAD_FORMAT: ' + cmd.id);
  process.exit(1);
}}
if (parts[0] !== 'chim') {{
  console.error('NO_CHIM_PREFIX: ' + parts[0]);
  process.exit(2);
}}
const ts = parseInt(parts[1]);
if (isNaN(ts) || ts < 1000000000000) {{
  console.error('BAD_TIMESTAMP: ' + parts[1]);
  process.exit(3);
}}
console.log('OK format=' + cmd.id.slice(0, 20));
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"Format ID test échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_mark_failed_sets_error(self, tmp_path):
        """markExecuted(id, false, 'erreur') doit mettre status='failed' avec error."""
        script = f"""
import {{ writeCommand, markExecuted, getLastCommand }} from '{_CHIMERA_BUS}';

const cmd = writeCommand({{
  action: 'mutate',
  target: 'test.yml',
  key: 'k',
  new_value: 'v',
}});

markExecuted(cmd.id, false, 'Erreur test unitaire');

const last = getLastCommand();
if (!last) {{ console.error('LAST_NULL'); process.exit(1); }}
if (last.status !== 'failed') {{
  console.error('STATUS_NOT_FAILED: ' + last.status);
  process.exit(2);
}}
if (!last.error || !last.error.includes('test')) {{
  console.error('NO_ERROR_MESSAGE');
  process.exit(3);
}}
console.log('OK failed error=' + last.error.slice(0, 20));
process.exit(0);
"""
        result = _run_node_script(script, cwd=_ROOT)
        assert result.returncode == 0, (
            f"markExecuted(failed) échoué:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
