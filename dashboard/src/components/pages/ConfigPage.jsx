/**
 * ConfigPage.jsx — Éditeur de configuration complet PICO-RUCHE
 * 7 onglets : Général · Brain · Perception · Executor · Memory · .env · Déploiement
 */
import { useState, useEffect, useCallback } from 'react';

const API = typeof window !== 'undefined' && window.QUEEN_API
  ? window.QUEEN_API
  : (import.meta.env?.VITE_QUEEN_API || 'http://localhost:3000');

const PYTHON_API = 'http://localhost:8001';

// ─── Constantes de style ─────────────────────────────────────────────────────

const TABS = [
  { id: 'general',    label: 'Général',        icon: '🐝' },
  { id: 'brain',      label: 'Brain',          icon: '🧠' },
  { id: 'perception', label: 'Perception',     icon: '👁️' },
  { id: 'executor',   label: 'Executor',       icon: '⚙️' },
  { id: 'memory',     label: 'Memory',         icon: '💾' },
  { id: 'env',        label: 'Variables .env', icon: '🔑' },
  { id: 'deploy',     label: 'Déploiement',    icon: '🚀' },
];

// ─── Composants primitifs ────────────────────────────────────────────────────

function Skeleton({ w = '100%', h = 16, radius = 6 }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: radius,
      background: 'linear-gradient(90deg,var(--surface-2) 25%,var(--surface-3) 50%,var(--surface-2) 75%)',
      backgroundSize: '400px 100%',
      animation: 'shimmer 1.5s infinite',
    }} />
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: 'var(--surface-2)',
      border: '1px solid var(--border-2)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      marginBottom: 16,
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle }) {
  return (
    <div style={{
      padding: '14px 20px',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

function CardBody({ children, style = {} }) {
  return (
    <div style={{
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      ...style,
    }}>
      {children}
    </div>
  );
}

// Slider avec valeur live
function Slider({ label, desc, value, min, max, step = 1, unit = '', onChange }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', marginBottom: 8,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
          {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
        </div>
        <div style={{
          minWidth: 62, textAlign: 'center',
          background: 'var(--surface-4)', border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-sm)', padding: '3px 10px',
          fontFamily: 'monospace', fontSize: 13, fontWeight: 600,
          color: 'var(--primary)',
        }}>
          {value}{unit}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 28 }}>{min}{unit}</span>
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: 'var(--primary)', height: 4, cursor: 'pointer' }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 38, textAlign: 'right' }}>{max}{unit}</span>
      </div>
    </div>
  );
}

// Toggle on/off
function Toggle({ label, desc, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 44, height: 24, borderRadius: 12,
          background: value ? 'var(--primary)' : 'var(--surface-4)',
          border: 'none', cursor: 'pointer', position: 'relative',
          transition: 'background 0.2s', flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute',
          top: 3, left: value ? 23 : 3,
          width: 18, height: 18, borderRadius: '50%',
          background: '#fff', transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
        }} />
      </button>
    </div>
  );
}

// Input texte
function TextInput({ label, desc, value, onChange, placeholder = '', mono = false, secret = false }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', marginBottom: 6,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
          {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
        </div>
        {secret && (
          <button
            onClick={() => setShow(s => !s)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-3)', fontSize: 12, padding: '2px 6px',
            }}
          >{show ? '🙈 Masquer' : '👁 Afficher'}</button>
        )}
      </div>
      <input
        type={secret && !show ? 'password' : 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          color: 'var(--text)',
          fontSize: 13,
          fontFamily: mono ? 'monospace' : 'inherit',
          outline: 'none',
          transition: 'border-color 0.15s',
          boxSizing: 'border-box',
        }}
        onFocus={e => { e.target.style.borderColor = 'var(--primary)'; }}
        onBlur={e => { e.target.style.borderColor = 'var(--border-2)'; }}
      />
    </div>
  );
}

// Input nombre
function NumberInput({ label, desc, value, onChange, min, max, unit = '' }) {
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number"
          value={value}
          min={min} max={max}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            width: 120,
            background: 'var(--surface-3)',
            border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 12px',
            color: 'var(--text)',
            fontSize: 13,
            fontFamily: 'monospace',
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
          onFocus={e => { e.target.style.borderColor = 'var(--primary)'; }}
          onBlur={e => { e.target.style.borderColor = 'var(--border-2)'; }}
        />
        {unit && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{unit}</span>}
      </div>
    </div>
  );
}

// Select stylé
function SelectInput({ label, desc, value, onChange, options }) {
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
      </div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--surface-3)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          color: 'var(--text)',
          fontSize: 13,
          outline: 'none',
          cursor: 'pointer',
          minWidth: 180,
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} style={{ background: 'var(--surface-3)' }}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// Tags input
function TagInput({ label, desc, tags, onChange }) {
  const [input, setInput] = useState('');

  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) { onChange([...tags, v]); setInput(''); }
  };
  const remove = tag => onChange(tags.filter(t => t !== tag));

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6,
        background: 'var(--surface-3)', border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-sm)', padding: 8, minHeight: 42,
      }}>
        {tags.map(tag => (
          <span key={tag} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: 'var(--primary-dim)', border: '1px solid rgba(224,123,84,0.3)',
            borderRadius: 4, padding: '2px 8px',
            fontSize: 12, color: 'var(--primary)', fontFamily: 'monospace',
          }}>
            {tag}
            <button
              onClick={() => remove(tag)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--primary)', padding: 0, fontSize: 14, lineHeight: 1, opacity: 0.7,
              }}
            >×</button>
          </span>
        ))}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Ajouter… (Entrée)"
          style={{
            flex: 1, minWidth: 120,
            background: 'none', border: 'none', outline: 'none',
            color: 'var(--text)', fontSize: 12, fontFamily: 'monospace', padding: '2px 4px',
          }}
        />
      </div>
      <button
        onClick={add}
        style={{
          marginTop: 6, background: 'none',
          border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
          color: 'var(--text-2)', fontSize: 12, padding: '4px 10px', cursor: 'pointer',
        }}
      >+ Ajouter</button>
    </div>
  );
}

// Radio group
function RadioGroup({ label, desc, value, options, onChange }) {
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map(opt => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              style={{
                background: active ? 'var(--primary-dim)' : 'var(--surface-3)',
                border: `1px solid ${active ? 'rgba(224,123,84,0.5)' : 'var(--border-2)'}`,
                borderRadius: 'var(--radius-sm)',
                color: active ? 'var(--primary)' : 'var(--text-2)',
                fontSize: 13, fontWeight: active ? 600 : 400,
                padding: '7px 16px', cursor: 'pointer', transition: 'all 0.15s',
              }}
            >{opt.label}</button>
          );
        })}
      </div>
    </div>
  );
}

// Ligne lecture seule
function ReadOnlyRow({ label, value }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '10px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>{label}</div>
      <div style={{
        fontFamily: 'monospace', fontSize: 12, color: 'var(--text)',
        background: 'var(--surface-3)', border: '1px solid var(--border)',
        borderRadius: 4, padding: '4px 10px',
      }}>{value}</div>
    </div>
  );
}

// Bouton sauvegarder
function SaveButton({ onSave, isDirty, loading, onReset }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
      {isDirty && (
        <span style={{
          fontSize: 11, color: 'var(--yellow)',
          background: 'rgba(251,178,76,0.1)', border: '1px solid rgba(251,178,76,0.3)',
          borderRadius: 4, padding: '3px 8px',
        }}>● Modifié</span>
      )}
      {isDirty && (
        <button
          onClick={onReset}
          disabled={loading}
          style={{
            background: 'none', border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-3)',
            fontSize: 12, padding: '7px 14px', cursor: 'pointer',
          }}
        >Annuler</button>
      )}
      <button
        onClick={onSave}
        disabled={loading || !isDirty}
        style={{
          background: isDirty ? 'var(--primary)' : 'var(--surface-3)',
          border: 'none', borderRadius: 'var(--radius-sm)',
          color: isDirty ? '#fff' : 'var(--text-3)',
          fontSize: 13, fontWeight: 600,
          padding: '8px 18px', cursor: isDirty ? 'pointer' : 'default',
          opacity: loading ? 0.6 : 1,
          transition: 'background 0.2s, color 0.2s',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        {loading && (
          <span style={{
            display: 'inline-block', width: 12, height: 12,
            border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          }} />
        )}
        Sauvegarder
      </button>
    </div>
  );
}

// Bloc de code copiable
function CodeBlock({ code, label }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>{label}</div>}
      <div style={{
        position: 'relative',
        background: 'var(--surface-4)', border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-sm)', padding: '12px 16px',
      }}>
        <pre style={{
          margin: 0, fontFamily: 'monospace', fontSize: 12,
          color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          lineHeight: 1.6, paddingRight: 60,
        }}>{code}</pre>
        <button
          onClick={copy}
          style={{
            position: 'absolute', top: 8, right: 8,
            background: copied ? 'rgba(74,222,128,0.15)' : 'var(--surface-3)',
            border: `1px solid ${copied ? 'rgba(74,222,128,0.4)' : 'var(--border-2)'}`,
            borderRadius: 'var(--radius-sm)',
            color: copied ? 'var(--green)' : 'var(--text-3)',
            fontSize: 11, padding: '3px 8px', cursor: 'pointer', transition: 'all 0.2s',
          }}
        >{copied ? '✓ Copié' : 'Copier'}</button>
      </div>
    </div>
  );
}

// Toast notifications
function Toast({ toasts }) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24,
      display: 'flex', flexDirection: 'column', gap: 8,
      zIndex: 9999, pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type === 'success' ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)',
          border: `1px solid ${t.type === 'success' ? 'rgba(74,222,128,0.4)' : 'rgba(248,113,113,0.4)'}`,
          borderRadius: 'var(--radius-sm)', padding: '10px 16px',
          fontSize: 13, color: t.type === 'success' ? 'var(--green)' : 'var(--red)',
          boxShadow: 'var(--shadow)', animation: 'slideUp 0.25s ease both',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {t.type === 'success' ? '✓' : '✕'} {t.msg}
        </div>
      ))}
    </div>
  );
}

// Modal de confirmation
function ConfirmModal({ open, title, message, onConfirm, onCancel, danger = false }) {
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10000, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-lg)', padding: 28, maxWidth: 420, width: '90%',
        boxShadow: 'var(--shadow-lg)', animation: 'slideUp 0.2s ease both',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 24, lineHeight: 1.6 }}>{message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              background: 'var(--surface-3)', border: '1px solid var(--border-2)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-2)',
              fontSize: 13, padding: '8px 18px', cursor: 'pointer',
            }}
          >Annuler</button>
          <button
            onClick={onConfirm}
            style={{
              background: danger ? 'var(--red)' : 'var(--primary)',
              border: 'none', borderRadius: 'var(--radius-sm)',
              color: '#fff', fontSize: 13, fontWeight: 600,
              padding: '8px 18px', cursor: 'pointer',
            }}
          >Confirmer</button>
        </div>
      </div>
    </div>
  );
}

// ─── Hooks utilitaires ───────────────────────────────────────────────────────

function useToast() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, type = 'success') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);
  return { toasts, toast };
}

function useDirty(initial) {
  const [value, setValue] = useState(initial);
  const [original, setOriginal] = useState(initial);
  const isDirty = JSON.stringify(value) !== JSON.stringify(original);
  const confirm = useCallback(newVal => { setOriginal(newVal); setValue(newVal); }, []);
  const reset = useCallback(() => setValue(original), [original]);
  return { value, setValue, isDirty, confirm, reset };
}

// ─── TAB 1 — Général ────────────────────────────────────────────────────────

function TabGeneral({ config }) {
  const { toasts, toast } = useToast();

  const ports = config?.config?.ports || {};
  const nodePort = config?.env?.API_PORT || 3000;
  const dashPort = config?.env?.DASHBOARD_PORT || 5173;

  const allPorts = [
    { name: 'queen_oss (Node.js)', port: nodePort, desc: 'API REST + MCP' },
    { name: 'Queen Python', port: ports.queen || 8001, desc: 'Orchestrateur + HITL' },
    { name: 'Perception', port: ports.perception || 8002, desc: 'Screenshots + Vision' },
    { name: 'Brain', port: ports.brain || 8003, desc: 'LLM → plan JSON' },
    { name: 'Executor', port: ports.executor || 8004, desc: 'Shell sandboxé' },
    { name: 'Evolution', port: ports.evolution || 8005, desc: 'Auto-amélioration skills' },
    { name: 'Memory', port: ports.memory || 8006, desc: 'Épisodes + persistance' },
    { name: 'MCP Bridge', port: ports.mcp_bridge || 8007, desc: 'Proxy Python → Node.js' },
    { name: 'Dashboard', port: dashPort, desc: 'Interface web' },
  ];

  const initOllama = {
    base_url: config?.config?.ollama?.base_url || 'http://localhost:11434',
    timeout: config?.config?.ollama?.timeout || 120,
  };
  const initLoop = { interval: config?.config?.vital_loop_interval_sec || 30 };
  const initSecurity = {
    shell_timeout: config?.config?.security?.max_shell_timeout || 30,
    output_max_chars: config?.config?.security?.output_max_chars || 10000,
  };

  const ollama = useDirty(initOllama);
  const loop = useDirty(initLoop);
  const security = useDirty(initSecurity);
  const anyDirty = ollama.isDirty || loop.isDirty || security.isDirty;
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ollama: ollama.value,
          vital_loop_interval_sec: loop.value.interval,
          security: security.value,
        }),
      });
      if (r.ok) {
        ollama.confirm(ollama.value);
        loop.confirm(loop.value);
        security.confirm(security.value);
        toast('Configuration générale sauvegardée');
      } else { toast(`Erreur ${r.status}`, 'error'); }
    } catch { toast('Erreur réseau', 'error'); }
    finally { setSaving(false); }
  };

  const handleReset = () => { ollama.reset(); loop.reset(); security.reset(); };

  return (
    <div>
      <Toast toasts={toasts} />

      <Card>
        <CardHeader title="🔌 Ports" subtitle="Architecture 8 couches — lecture seule" />
        <CardBody style={{ gap: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            {allPorts.map(p => (
              <div key={p.name} style={{ borderBottom: '1px solid var(--border)', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--primary)', minWidth: 44 }}>{p.port}</span>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{p.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🦙 Ollama" />
        <CardBody>
          <TextInput
            label="Base URL" desc="Endpoint du serveur Ollama local"
            value={ollama.value.base_url}
            onChange={v => ollama.setValue(s => ({ ...s, base_url: v }))}
            mono placeholder="http://localhost:11434"
          />
          <Slider
            label="Timeout" desc="Timeout des requêtes Ollama"
            value={ollama.value.timeout} min={10} max={300} unit="s"
            onChange={v => ollama.setValue(s => ({ ...s, timeout: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="💓 Boucle vitale" subtitle="Fréquence du cycle agent" />
        <CardBody>
          <Slider
            label="Intervalle" desc="Durée entre deux tours de la boucle vitale"
            value={loop.value.interval} min={10} max={300} unit="s"
            onChange={v => loop.setValue({ interval: v })}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🔒 Sécurité" />
        <CardBody>
          <Slider
            label="Shell timeout" desc="Durée maximale d'exécution d'une commande shell"
            value={security.value.shell_timeout} min={5} max={60} unit="s"
            onChange={v => security.setValue(s => ({ ...s, shell_timeout: v }))}
          />
          <NumberInput
            label="Output max chars" desc="Taille maximale de la sortie shell tronquée"
            value={security.value.output_max_chars} min={1000} max={100000} unit="caractères"
            onChange={v => security.setValue(s => ({ ...s, output_max_chars: v }))}
          />
        </CardBody>
      </Card>

      <SaveButton onSave={handleSave} isDirty={anyDirty} loading={saving} onReset={handleReset} />
    </div>
  );
}

// ─── TAB 2 — Brain ──────────────────────────────────────────────────────────

function TabBrain({ config }) {
  const { toasts, toast } = useToast();
  const ollama = config?.config?.ollama || {};
  const brain = config?.config?.brain || {};

  const initModels = {
    strategist: ollama.models?.strategist || 'llama3:latest',
    worker: ollama.models?.worker || 'llama3.2:3b',
    vision: ollama.models?.vision || 'moondream:latest',
    compressor: ollama.models?.compressor || 'llama3.2:3b',
  };
  const initBrain = {
    provider: 'ollama',
    max_context_tokens: brain.max_context_tokens || 8000,
    compress_threshold: brain.compress_threshold || 6000,
    max_failures: 3,
    timeout_ollama: ollama.timeout || 120,
    timeout_claude: 30,
    timeout_mlx: 60,
  };

  const models = useDirty(initModels);
  const brainCfg = useDirty(initBrain);
  const anyDirty = models.isDirty || brainCfg.isDirty;
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: models.value, brain: brainCfg.value }),
      });
      if (r.ok) {
        models.confirm(models.value);
        brainCfg.confirm(brainCfg.value);
        toast('Paramètres Brain sauvegardés');
      } else { toast(`Erreur ${r.status}`, 'error'); }
    } catch { toast('Erreur réseau', 'error'); }
    finally { setSaving(false); }
  };

  const handleReset = () => { models.reset(); brainCfg.reset(); };

  return (
    <div>
      <Toast toasts={toasts} />

      <Card>
        <CardHeader title="🔀 Provider principal" subtitle="LLM utilisé pour la stratégie et les workers" />
        <CardBody>
          <RadioGroup
            label="Provider"
            value={brainCfg.value.provider}
            options={[
              { label: '🤖 Claude (Anthropic)', value: 'claude' },
              { label: '🦙 Ollama (local)', value: 'ollama' },
              { label: '⚡ MLX (Apple Silicon)', value: 'mlx' },
            ]}
            onChange={v => brainCfg.setValue(s => ({ ...s, provider: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🎭 Modèles par rôle" subtitle="Modèles Ollama assignés à chaque rôle agent" />
        <CardBody>
          {[
            { key: 'strategist', label: 'Stratège', desc: 'Planification et décomposition des missions' },
            { key: 'worker', label: 'Worker', desc: 'Exécution des sous-tâches' },
            { key: 'vision', label: 'Vision', desc: 'Analyse des screenshots' },
            { key: 'compressor', label: 'Compresseur', desc: 'Compression du contexte mémoire' },
          ].map(({ key, label, desc }) => (
            <TextInput
              key={key} label={label} desc={desc}
              value={models.value[key]}
              onChange={v => models.setValue(s => ({ ...s, [key]: v }))}
              mono placeholder="modele:tag"
            />
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="📐 Contexte & Mémoire" />
        <CardBody>
          <Slider
            label="Max tokens contexte" desc="Taille maximale du contexte envoyé au LLM"
            value={brainCfg.value.max_context_tokens} min={1000} max={16000} step={500} unit=" tok"
            onChange={v => brainCfg.setValue(s => ({ ...s, max_context_tokens: v }))}
          />
          <Slider
            label="Seuil de compression" desc="Déclenche la compression mémoire au-delà de ce seuil"
            value={brainCfg.value.compress_threshold} min={500} max={14000} step={500} unit=" tok"
            onChange={v => brainCfg.setValue(s => ({ ...s, compress_threshold: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="⚡ Circuit breaker & Timeouts" />
        <CardBody>
          <NumberInput
            label="Max failures" desc="Nombre d'échecs consécutifs avant ouverture du circuit"
            value={brainCfg.value.max_failures} min={1} max={10}
            onChange={v => brainCfg.setValue(s => ({ ...s, max_failures: v }))}
          />
          <Slider label="Timeout Ollama" value={brainCfg.value.timeout_ollama} min={5} max={300} unit="s"
            onChange={v => brainCfg.setValue(s => ({ ...s, timeout_ollama: v }))} />
          <Slider label="Timeout Claude" value={brainCfg.value.timeout_claude} min={5} max={120} unit="s"
            onChange={v => brainCfg.setValue(s => ({ ...s, timeout_claude: v }))} />
          <Slider label="Timeout MLX" value={brainCfg.value.timeout_mlx} min={5} max={120} unit="s"
            onChange={v => brainCfg.setValue(s => ({ ...s, timeout_mlx: v }))} />
        </CardBody>
      </Card>

      <SaveButton onSave={handleSave} isDirty={anyDirty} loading={saving} onReset={handleReset} />
    </div>
  );
}

// ─── TAB 3 — Perception ─────────────────────────────────────────────────────

function TabPerception({ config }) {
  const { toasts, toast } = useToast();
  const perc = config?.config?.perception || {};

  const init = {
    interval_seconds: perc.interval_seconds || 30,
    vision_model: perc.vision_model || 'moondream',
    hash_detection: perc.hash_detection !== false,
    screenshots_max: perc.screenshots_max || 100,
    screenshots_ttl_hours: perc.screenshots_ttl_hours || 24,
  };

  const { value, setValue, isDirty, confirm, reset } = useDirty(init);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perception: value }),
      });
      if (r.ok) { confirm(value); toast('Perception sauvegardée'); }
      else toast(`Erreur ${r.status}`, 'error');
    } catch { toast('Erreur réseau', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <Toast toasts={toasts} />

      <Card>
        <CardHeader title="📸 Capture d'écran" />
        <CardBody>
          <Slider
            label="Intervalle" desc="Fréquence de capture d'écran"
            value={value.interval_seconds} min={5} max={300} unit="s"
            onChange={v => setValue(s => ({ ...s, interval_seconds: v }))}
          />
          <SelectInput
            label="Modèle de vision" desc="Modèle LLM pour l'analyse visuelle"
            value={value.vision_model}
            options={[
              { value: 'moondream', label: 'moondream (rapide, léger)' },
              { value: 'llava:7b', label: 'llava:7b (haute qualité)' },
              { value: 'auto', label: 'auto (détecté automatiquement)' },
            ]}
            onChange={v => setValue(s => ({ ...s, vision_model: v }))}
          />
          <Toggle
            label="Détection de hash" desc="Ignore les captures identiques (économise des ressources)"
            value={value.hash_detection}
            onChange={v => setValue(s => ({ ...s, hash_detection: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🗂 Rétention" subtitle="Gestion du stockage des screenshots" />
        <CardBody>
          <NumberInput
            label="Nombre maximum de screenshots" desc="Au-delà, les plus anciens sont purgés"
            value={value.screenshots_max} min={10} max={1000} unit="captures"
            onChange={v => setValue(s => ({ ...s, screenshots_max: v }))}
          />
          <NumberInput
            label="TTL des screenshots" desc="Durée de conservation avant suppression automatique"
            value={value.screenshots_ttl_hours} min={1} max={168} unit="heures"
            onChange={v => setValue(s => ({ ...s, screenshots_ttl_hours: v }))}
          />
        </CardBody>
      </Card>

      <SaveButton onSave={handleSave} isDirty={isDirty} loading={saving} onReset={reset} />
    </div>
  );
}

// ─── TAB 4 — Executor ───────────────────────────────────────────────────────

function TabExecutor({ config }) {
  const { toasts, toast } = useToast();
  const sec = config?.config?.security || {};

  const blockedPatterns = sec.blocked_shell_patterns || [
    'rm -rf /', ':(){ :|:& };:', 'dd if=/dev/zero', 'mkfs', 'shutdown', 'reboot',
  ];

  const init = {
    shell_timeout: sec.max_shell_timeout || 30,
    output_max_chars: sec.output_max_chars || 10000,
    hitl_whitelist: sec.require_confirmation_for || ['delete', 'format', 'kill', 'shutdown'],
  };

  const { value, setValue, isDirty, confirm, reset } = useDirty(init);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executor: value }),
      });
      if (r.ok) { confirm(value); toast('Executor sauvegardé'); }
      else toast(`Erreur ${r.status}`, 'error');
    } catch { toast('Erreur réseau', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <Toast toasts={toasts} />

      <Card>
        <CardHeader title="🐚 Shell" />
        <CardBody>
          <Slider
            label="Timeout shell" desc="Durée maximale d'une commande avant kill forcé"
            value={value.shell_timeout} min={5} max={60} unit="s"
            onChange={v => setValue(s => ({ ...s, shell_timeout: v }))}
          />
          <NumberInput
            label="Output max chars" desc="Sortie tronquée à cette longueur avant envoi au LLM"
            value={value.output_max_chars} min={1000} max={100000} unit="caractères"
            onChange={v => setValue(s => ({ ...s, output_max_chars: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🛑 HITL — Whitelist" subtitle="Ces mots-clés déclenchent une confirmation humaine" />
        <CardBody>
          <TagInput
            label="Commandes nécessitant confirmation"
            desc="Appuyez Entrée ou cliquez + Ajouter pour chaque mot-clé"
            tags={value.hitl_whitelist}
            onChange={v => setValue(s => ({ ...s, hitl_whitelist: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🚫 Patterns bloqués" subtitle="Lecture seule — éditer agent_config.yml directement" />
        <CardBody>
          <div style={{
            background: 'var(--surface-4)', border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-sm)', padding: '12px 16px',
          }}>
            {blockedPatterns.map((p, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                borderBottom: i < blockedPatterns.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ color: 'var(--red)', fontSize: 11 }}>✕</span>
                <code style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-2)' }}>{p}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Éditer <code style={{ fontFamily: 'monospace', color: 'var(--yellow)' }}>agent_config.yml</code> →{' '}
            <code style={{ fontFamily: 'monospace', color: 'var(--yellow)' }}>security.blocked_shell_patterns</code>
          </div>
        </CardBody>
      </Card>

      <SaveButton onSave={handleSave} isDirty={isDirty} loading={saving} onReset={reset} />
    </div>
  );
}

// ─── TAB 5 — Memory ─────────────────────────────────────────────────────────

function TabMemory({ config }) {
  const { toasts, toast } = useToast();
  const mem = config?.config?.memory || {};

  const init = {
    max_episodes: mem.max_episodes || 500,
    atomic_write: mem.atomic_write !== false,
    corruption_alert_threshold: mem.corruption_alert_threshold || 10,
  };

  const { value, setValue, isDirty, confirm, reset } = useDirty(init);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memory: value }),
      });
      if (r.ok) { confirm(value); toast('Mémoire sauvegardée'); }
      else toast(`Erreur ${r.status}`, 'error');
    } catch { toast('Erreur réseau', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <Toast toasts={toasts} />

      <Card>
        <CardHeader title="🗃 Épisodes" subtitle="Gestion de la mémoire épisodique de l'agent" />
        <CardBody>
          <Slider
            label="Max épisodes" desc="Nombre maximum d'épisodes conservés en mémoire"
            value={value.max_episodes} min={100} max={5000} step={100}
            onChange={v => setValue(s => ({ ...s, max_episodes: v }))}
          />
          <Toggle
            label="Écriture atomique" desc="Écriture sûre (temp file + rename) pour éviter la corruption"
            value={value.atomic_write}
            onChange={v => setValue(s => ({ ...s, atomic_write: v }))}
          />
          <NumberInput
            label="Seuil d'alerte corruption" desc="Nombre d'erreurs de parsing avant alerte Telegram"
            value={value.corruption_alert_threshold} min={1} max={100} unit="erreurs"
            onChange={v => setValue(s => ({ ...s, corruption_alert_threshold: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="📁 Fichiers" subtitle="Chemins de persistance — lecture seule" />
        <CardBody style={{ gap: 0 }}>
          <ReadOnlyRow label="Épisodes" value={mem.episode_file || 'agent/memory/episodes.jsonl'} />
          <ReadOnlyRow label="Persistant" value={mem.persistent_file || 'agent/memory/persistent.md'} />
          <ReadOnlyRow label="World state" value={mem.world_state_file || 'agent/memory/world_state.json'} />
        </CardBody>
      </Card>

      <SaveButton onSave={handleSave} isDirty={isDirty} loading={saving} onReset={reset} />
    </div>
  );
}

// ─── TAB 6 — Variables .env ──────────────────────────────────────────────────

function TabEnv({ config }) {
  const { toasts, toast } = useToast();
  const env = config?.env || {};

  const init = {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
    ADMIN_TELEGRAM_ID: env.ADMIN_TELEGRAM_ID || '',
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
    OLLAMA_HOST: env.OLLAMA_HOST || 'http://localhost:11434',
    HITL_TIMEOUT_SECONDS: env.HITL_TIMEOUT_SECONDS || '120',
    STANDALONE_MODE: env.STANDALONE_MODE || 'false',
  };

  const { value, setValue, isDirty, confirm, reset } = useDirty(init);
  const [saving, setSaving] = useState(false);
  const [testingClaude, setTestingClaude] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/env`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (r.ok) { confirm(value); toast('Variables .env sauvegardées'); }
      else toast(`Erreur ${r.status}`, 'error');
    } catch { toast('Erreur réseau', 'error'); }
    finally { setSaving(false); }
  };

  const testClaude = async () => {
    setTestingClaude(true);
    try {
      const r = await fetch(`${API}/api/health`);
      const data = r.ok ? await r.json() : null;
      if (data?.ok) toast('Claude API accessible ✓');
      else toast('API non disponible', 'error');
    } catch { toast('Impossible de joindre le serveur', 'error'); }
    finally { setTestingClaude(false); }
  };

  const testTelegram = async () => {
    setTestingTelegram(true);
    try {
      const r = await fetch(`${PYTHON_API}/telegram/test`, { method: 'POST' });
      if (r.ok) toast('Message Telegram envoyé ✓');
      else toast(`Erreur Telegram ${r.status}`, 'error');
    } catch { toast('Telegram non joignable', 'error'); }
    finally { setTestingTelegram(false); }
  };

  const missingKey = !value.ANTHROPIC_API_KEY;

  return (
    <div>
      <Toast toasts={toasts} />

      {missingKey && (
        <div style={{
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 16,
          fontSize: 13, color: 'var(--red)', display: 'flex', gap: 8, alignItems: 'center',
        }}>
          ⚠️ <strong>ANTHROPIC_API_KEY</strong> est vide — le mode Claude ne fonctionnera pas.
        </div>
      )}

      <Card>
        <CardHeader title="🤖 Telegram" subtitle="Bot HITL et notifications" />
        <CardBody>
          <TextInput
            label="TELEGRAM_BOT_TOKEN" desc="Token obtenu via @BotFather"
            value={value.TELEGRAM_BOT_TOKEN}
            onChange={v => setValue(s => ({ ...s, TELEGRAM_BOT_TOKEN: v }))}
            secret mono placeholder="123456789:ABCdef..."
          />
          <TextInput
            label="ADMIN_TELEGRAM_ID" desc="Votre ID Telegram (@userinfobot pour le trouver)"
            value={value.ADMIN_TELEGRAM_ID}
            onChange={v => setValue(s => ({ ...s, ADMIN_TELEGRAM_ID: v }))}
            mono placeholder="123456789"
          />
          <Toggle
            label="Mode Standalone" desc="Désactive Telegram — évite les conflits 409 en dev"
            value={value.STANDALONE_MODE === 'true'}
            onChange={v => setValue(s => ({ ...s, STANDALONE_MODE: v ? 'true' : 'false' }))}
          />
          <Slider
            label="HITL Timeout" desc="Délai avant auto-annulation d'une action en attente"
            value={Number(value.HITL_TIMEOUT_SECONDS)} min={30} max={600} step={10} unit="s"
            onChange={v => setValue(s => ({ ...s, HITL_TIMEOUT_SECONDS: String(v) }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🔑 Clés API" />
        <CardBody>
          <TextInput
            label="ANTHROPIC_API_KEY" desc="Clé Anthropic pour le mode Claude"
            value={value.ANTHROPIC_API_KEY}
            onChange={v => setValue(s => ({ ...s, ANTHROPIC_API_KEY: v }))}
            secret mono placeholder="sk-ant-..."
          />
          <TextInput
            label="OLLAMA_HOST" desc="Hôte du serveur Ollama (peut différer si distant)"
            value={value.OLLAMA_HOST}
            onChange={v => setValue(s => ({ ...s, OLLAMA_HOST: v }))}
            mono placeholder="http://localhost:11434"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="🧪 Tests de connexion" />
        <CardBody>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={testClaude} disabled={testingClaude}
              style={{
                background: 'var(--primary-dim)', border: '1px solid rgba(224,123,84,0.3)',
                borderRadius: 'var(--radius-sm)', color: 'var(--primary)',
                fontSize: 13, fontWeight: 600, padding: '9px 18px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, opacity: testingClaude ? 0.7 : 1,
              }}
            >
              {testingClaude
                ? <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(224,123,84,0.3)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                : '🤖'} Tester Claude
            </button>
            <button
              onClick={testTelegram} disabled={testingTelegram}
              style={{
                background: 'var(--surface-3)', border: '1px solid var(--border-2)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-2)',
                fontSize: 13, padding: '9px 18px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, opacity: testingTelegram ? 0.7 : 1,
              }}
            >
              {testingTelegram
                ? <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(160,156,148,0.3)', borderTopColor: 'var(--text-2)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                : '📱'} Tester Telegram
            </button>
          </div>
        </CardBody>
      </Card>

      <SaveButton onSave={handleSave} isDirty={isDirty} loading={saving} onReset={reset} />
    </div>
  );
}

// ─── TAB 7 — Déploiement ────────────────────────────────────────────────────

function TabDeploy({ config }) {
  const { toasts, toast } = useToast();
  const [systemInfo, setSystemInfo] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/system`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setSystemInfo(d))
      .catch(() => {});
  }, []);

  const doRestart = async () => {
    setConfirmState(null);
    setRestarting(true);
    try {
      const r = await fetch(`${API}/api/process/restart`, { method: 'POST' });
      if (r.ok) toast('Redémarrage lancé — attendre 10-15 secondes');
      else toast(`Erreur ${r.status}`, 'error');
    } catch { toast('Serveur non joignable', 'error'); }
    finally { setRestarting(false); }
  };

  const doStop = async () => {
    setConfirmState(null);
    try {
      const r = await fetch(`${API}/api/process/stop`, { method: 'POST' });
      if (r.ok) toast('Arrêt propre lancé');
      else toast(`Erreur ${r.status}`, 'error');
    } catch { toast('Serveur non joignable', 'error'); }
  };

  return (
    <div>
      <Toast toasts={toasts} />
      <ConfirmModal
        open={confirmState === 'restart'}
        title="Redémarrer toutes les couches ?"
        message="Toutes les 8 couches Python + Node.js vont être redémarrées. Les missions en cours seront interrompues."
        onConfirm={doRestart}
        onCancel={() => setConfirmState(null)}
      />
      <ConfirmModal
        open={confirmState === 'stop'}
        title="⚠️ Arrêt propre de l'essaim"
        message="Cela va envoyer SIGTERM à tous les processus. L'agent sera complètement arrêté jusqu'au prochain démarrage manuel."
        onConfirm={doStop}
        onCancel={() => setConfirmState(null)}
        danger
      />

      <Card>
        <CardHeader title="🚀 Commandes de lancement" subtitle="Copier-coller dans votre terminal" />
        <CardBody>
          <CodeBlock
            label="Démarrage complet (2 terminaux)"
            code={`# Terminal 1 — 7 couches Python\npython3 start_agent.py\n\n# Terminal 2 — Queen Node.js\nSTANDALONE_MODE=true node src/queen_oss.js`}
          />
          <CodeBlock
            label="Démarrage avec PM2"
            code={`pm2 start ecosystem.config.js --env production\npm2 logs --lines 50`}
          />
          <CodeBlock
            label="Pré-vérification"
            code={`make preflight\n# ou\nbash scripts/preflight_check.sh`}
          />
          <CodeBlock
            label="Status complet"
            code={`python3 scripts/status_agent.py\n# ou\nmake status`}
          />
          <CodeBlock
            label="Arrêt propre"
            code={`python3 stop_agent.py\n# ou\nmake stop`}
          />
        </CardBody>
      </Card>

      {systemInfo && (
        <Card>
          <CardHeader title="💻 Ressources système" />
          <CardBody>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {[
                { label: 'CPU', val: systemInfo.cpu, suffix: '%' },
                { label: 'RAM', val: systemInfo.ram, suffix: '%' },
                { label: 'Disque', val: systemInfo.disk, suffix: '%' },
              ].map(item => {
                const pct = item.val;
                const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)';
                return (
                  <div key={item.label} style={{
                    background: 'var(--surface-3)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: '14px 16px', textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'monospace' }}>
                      {pct !== undefined ? `${pct}${item.suffix}` : 'N/A'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{item.label}</div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="🔧 Gestion PM2" />
        <CardBody>
          <CodeBlock label="Vérifier les processus PM2" code={`pm2 list\npm2 monit`} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="⚡ Actions" />
        <CardBody>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={() => setConfirmState('restart')} disabled={restarting}
              style={{
                background: 'var(--primary-dim)', border: '1px solid rgba(224,123,84,0.3)',
                borderRadius: 'var(--radius-sm)', color: 'var(--primary)',
                fontSize: 13, fontWeight: 600, padding: '10px 20px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, opacity: restarting ? 0.7 : 1,
              }}
            >
              {restarting
                ? <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(224,123,84,0.3)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                : '🔄'} Redémarrer toutes les couches
            </button>
            <button
              onClick={() => setConfirmState('stop')}
              style={{
                background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
                borderRadius: 'var(--radius-sm)', color: 'var(--red)',
                fontSize: 13, fontWeight: 600, padding: '10px 20px', cursor: 'pointer',
              }}
            >🛑 Arrêt propre</button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// ─── COMPOSANT PRINCIPAL ─────────────────────────────────────────────────────

export default function ConfigPage() {
  const [activeTab, setActiveTab] = useState('general');
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const r = await fetch(`${API}/api/config`);
      if (r.ok) setConfig(await r.json());
      else setLoadError(true);
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const renderContent = () => {
    if (loading) return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8 }}>
        {[...Array(3)].map((_, i) => <Skeleton key={i} h={120} radius={14} />)}
      </div>
    );

    if (loadError) return (
      <div style={{
        background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
        borderRadius: 'var(--radius-lg)', padding: '32px 24px', textAlign: 'center', color: 'var(--red)',
      }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Impossible de charger la configuration</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 20 }}>
          Vérifiez que le serveur est démarré sur{' '}
          <code style={{ fontFamily: 'monospace', color: 'var(--yellow)' }}>{API}</code>
        </div>
        <button
          onClick={load}
          style={{
            background: 'var(--surface-3)', border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-2)',
            fontSize: 13, padding: '9px 20px', cursor: 'pointer',
          }}
        >↺ Réessayer</button>
      </div>
    );

    const props = { config };
    switch (activeTab) {
      case 'general':    return <TabGeneral    {...props} />;
      case 'brain':      return <TabBrain      {...props} />;
      case 'perception': return <TabPerception {...props} />;
      case 'executor':   return <TabExecutor   {...props} />;
      case 'memory':     return <TabMemory     {...props} />;
      case 'env':        return <TabEnv        {...props} />;
      case 'deploy':     return <TabDeploy     {...props} />;
      default:           return null;
    }
  };

  return (
    <div style={{ padding: '28px 32px', maxWidth: 860, margin: '0 auto', width: '100%' }}>
      {/* En-tête */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{
              fontSize: 22, fontWeight: 700, color: 'var(--text)',
              letterSpacing: '-0.02em', margin: 0,
            }}>Configuration</h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>
              Édition complète de{' '}
              <code style={{ fontFamily: 'monospace', color: 'var(--yellow)' }}>agent_config.yml</code>
              {' '}et <code style={{ fontFamily: 'monospace', color: 'var(--yellow)' }}>.env</code>
            </p>
          </div>
          <button
            onClick={load}
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--border-2)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-3)',
              fontSize: 13, padding: '8px 14px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >↺ Recharger</button>
        </div>
      </div>

      {/* Tabs horizontaux style pill */}
      <div style={{
        display: 'flex', gap: 4,
        background: 'var(--surface-2)', border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-xl)', padding: 4,
        marginBottom: 24, flexWrap: 'wrap',
      }}>
        {TABS.map(tab => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1, minWidth: 85,
                background: active ? 'var(--primary)' : 'transparent',
                border: 'none',
                borderRadius: 'calc(var(--radius-xl) - 4px)',
                color: active ? '#fff' : 'var(--text-3)',
                fontSize: 12, fontWeight: active ? 600 : 400,
                padding: '7px 10px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 5, transition: 'background 0.18s, color 0.18s',
                whiteSpace: 'nowrap',
              }}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Contenu onglet actif */}
      <div key={activeTab} style={{ animation: 'slideUp 0.2s ease both' }}>
        {renderContent()}
      </div>
    </div>
  );
}
