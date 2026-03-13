/**
 * SwarmPage.jsx — Vue complète du swarm distribué LaRuche
 * Affiche les nœuds Ollama, leur statut, modèles, latence et charge.
 */
import { useEffect, useState } from 'react';

const STATUS_COLOR = {
  up:      { bg: 'var(--green-dim,rgba(166,227,161,0.12))', text: 'var(--ctp-green,#a6e3a1)',  label: 'En ligne' },
  down:    { bg: 'var(--red-dim,rgba(243,139,168,0.12))',   text: 'var(--ctp-red,#f38ba8)',    label: 'Hors ligne' },
  unknown: { bg: 'var(--yellow-dim,rgba(249,226,175,0.12))',text: 'var(--ctp-yellow,#f9e2af)', label: 'Inconnu' },
};

// Couches Python internes toujours présentes dans LaRuche
const PYTHON_LAYERS = [
  { id: 'queen-py',    port: 8001, role: 'Orchestrateur',   emoji: '👑' },
  { id: 'perception',  port: 8002, role: 'Perception',      emoji: '👁️' },
  { id: 'brain',       port: 8003, role: 'Brain / LLM',     emoji: '🧠' },
  { id: 'executor',    port: 8004, role: 'Exécuteur Shell',  emoji: '⚙️' },
  { id: 'evolution',   port: 8005, role: 'Évolution Skills', emoji: '🧬' },
  { id: 'memory',      port: 8006, role: 'Mémoire',         emoji: '💾' },
  { id: 'mcp-bridge',  port: 8007, role: 'MCP Bridge',      emoji: '🌉' },
];

function StatCard({ label, value, color = 'var(--text)', sub }) {
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 10, padding: '16px 20px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 500 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function NodeCard({ node }) {
  const s = STATUS_COLOR[node.status] || STATUS_COLOR.unknown;
  const load = node.maxConcurrency > 0
    ? Math.round((node.activeJobs / node.maxConcurrency) * 100)
    : 0;

  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 10, padding: '16px',
      display: 'flex', flexDirection: 'column', gap: 10,
      border: `1px solid ${node.status === 'up' ? 'var(--border)' : 'rgba(243,139,168,0.3)'}`,
    }}>
      {/* En-tête */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{node.id}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{node.url}</div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
          background: s.bg, color: s.text,
        }}>{s.label}</span>
      </div>

      {/* Rôle + modèles */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 4,
          background: 'var(--primary-dim,rgba(224,123,84,0.12))', color: 'var(--primary)',
          fontWeight: 500,
        }}>{node.role || 'worker'}</span>
        {(node.models || []).map(m => (
          <span key={m} style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: 'var(--surface)', color: 'var(--text-2)',
          }}>{m}</span>
        ))}
      </div>

      {/* Charge */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Charge</span>
          <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500 }}>
            {node.activeJobs}/{node.maxConcurrency} jobs ({load}%)
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'var(--surface)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${load}%`,
            background: load > 80 ? 'var(--ctp-red,#f38ba8)' : load > 50 ? 'var(--ctp-yellow,#f9e2af)' : 'var(--ctp-green,#a6e3a1)',
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Latence */}
      {node.latencyMs != null && (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Latence: <span style={{ color: node.latencyMs < 200 ? 'var(--ctp-green,#a6e3a1)' : 'var(--ctp-yellow,#f9e2af)', fontWeight: 600 }}>
            {node.latencyMs}ms
          </span>
        </div>
      )}
    </div>
  );
}

function LayerRow({ layer, health }) {
  const ok = health?.[layer.port];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 8,
      background: 'var(--surface-2)',
    }}>
      <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{layer.emoji}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{layer.role}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>:{layer.port}</div>
      </div>
      <span style={{
        fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
        background: ok ? 'var(--green-dim,rgba(166,227,161,0.12))' : 'var(--red-dim,rgba(243,139,168,0.12))',
        color: ok ? 'var(--ctp-green,#a6e3a1)' : 'var(--ctp-red,#f38ba8)',
      }}>{ok ? 'OK' : 'Down'}</span>
    </div>
  );
}

export default function SwarmPage() {
  const [stats, setStats]   = useState(null);
  const [nodes, setNodes]   = useState([]);
  const [health, setHealth] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchData = async () => {
    // Swarm Ollama nodes
    try {
      const [s, n] = await Promise.all([
        fetch('/api/swarm/stats').then(r => r.json()),
        fetch('/api/swarm/nodes').then(r => r.json()),
      ]);
      setStats(s);
      setNodes(n.nodes || []);
    } catch { /* silencieux */ }

    // Santé couches Python
    const results = {};
    await Promise.all(
      PYTHON_LAYERS.map(async (l) => {
        try {
          const r = await fetch(`http://localhost:${l.port}/health`);
          results[l.port] = r.ok;
        } catch { results[l.port] = false; }
      })
    );
    setHealth(results);
    setLastUpdate(new Date().toLocaleTimeString('fr-FR'));
  };

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 5000);
    return () => clearInterval(t);
  }, []);

  const pythonOk = PYTHON_LAYERS.filter(l => health[l.port]).length;

  return (
    <div style={{ padding: '24px', maxWidth: 1100, overflowY: 'auto' }}>
      {/* En-tête */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: 0 }}>🌐 Swarm LaRuche</h2>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '4px 0 0' }}>
            Couches Python + Nœuds Ollama distribués
          </p>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {lastUpdate ? `Mis à jour : ${lastUpdate}` : 'Chargement...'}
        </div>
      </div>

      {/* Stats globales */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 28 }}>
        <StatCard label="Couches Python" value={`${pythonOk}/7`}
          color={pythonOk === 7 ? 'var(--ctp-green,#a6e3a1)' : 'var(--ctp-yellow,#f9e2af)'}
          sub="actives" />
        <StatCard label="Nœuds Ollama" value={stats?.total ?? 0} color="var(--text)" sub="configurés" />
        <StatCard label="En ligne" value={stats?.up ?? 0} color="var(--ctp-green,#a6e3a1)" sub="nœuds UP" />
        <StatCard label="Hors ligne" value={stats?.down ?? 0} color="var(--ctp-red,#f38ba8)" sub="nœuds DOWN" />
        <StatCard label="Jobs actifs" value={stats?.activeJobs ?? 0} color="var(--ctp-blue,#89b4fa)"
          sub={`/ ${stats?.totalCapacity ?? 0} cap.`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Couches Python internes */}
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginBottom: 12, marginTop: 0 }}>
            Couches Python FastAPI
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PYTHON_LAYERS.map(l => (
              <LayerRow key={l.id} layer={l} health={health} />
            ))}
          </div>
        </div>

        {/* Nœuds Ollama distants */}
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginBottom: 12, marginTop: 0 }}>
            Nœuds Ollama distribués
          </h3>
          {nodes.length === 0 ? (
            <div style={{
              background: 'var(--surface-2)', borderRadius: 10, padding: 24,
              textAlign: 'center', color: 'var(--text-3)', fontSize: 13,
            }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🔌</div>
              Aucun nœud Ollama configuré.
              <div style={{ fontSize: 11, marginTop: 6 }}>
                Éditez <code>config/swarm_nodes.yml</code> pour ajouter des nœuds.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {nodes.map(n => <NodeCard key={n.id} node={n} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
