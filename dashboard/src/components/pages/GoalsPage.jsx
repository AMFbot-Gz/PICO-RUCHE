/**
 * GoalsPage.jsx — Gestion des objectifs LaRuche avec planning temporel
 * CRUD complet : créer, mettre à jour, supprimer. Schedule de la prochaine mission.
 */
import { useEffect, useState } from 'react';

const STATUS_META = {
  pending:   { label: 'En attente',  color: 'var(--ctp-yellow,#f9e2af)',  bg: 'rgba(249,226,175,0.12)' },
  active:    { label: 'Actif',       color: 'var(--ctp-blue,#89b4fa)',    bg: 'rgba(137,180,250,0.12)' },
  completed: { label: 'Terminé',     color: 'var(--ctp-green,#a6e3a1)',   bg: 'rgba(166,227,161,0.12)' },
  failed:    { label: 'Échoué',      color: 'var(--ctp-red,#f38ba8)',     bg: 'rgba(243,139,168,0.12)' },
};

function Badge({ status }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: m.bg, color: m.color,
    }}>{m.label}</span>
  );
}

function PriorityBar({ value = 5 }) {
  const pct = (value / 10) * 100;
  const color = value >= 8 ? 'var(--ctp-red,#f38ba8)'
    : value >= 5 ? 'var(--ctp-yellow,#f9e2af)'
    : 'var(--ctp-green,#a6e3a1)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600 }}>P{value}</span>
    </div>
  );
}

function GoalRow({ goal, onDelete, onStatus }) {
  const [expanded, setExpanded] = useState(false);
  const isTerminal = ['completed', 'failed'].includes(goal.status);
  const hasDeadline = goal.deadline;
  const isOverdue = hasDeadline && new Date(goal.deadline) < new Date() && !isTerminal;

  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 10,
      border: `1px solid ${isOverdue ? 'rgba(243,139,168,0.4)' : 'var(--border)'}`,
      overflow: 'hidden',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        {/* Chevron */}
        <span style={{ color: 'var(--text-3)', fontSize: 11, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>

        {/* Description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 500, color: isTerminal ? 'var(--text-3)' : 'var(--text)',
            textDecoration: goal.status === 'completed' ? 'line-through' : 'none',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{goal.description}</div>
          {hasDeadline && (
            <div style={{ fontSize: 11, color: isOverdue ? 'var(--ctp-red,#f38ba8)' : 'var(--text-3)', marginTop: 2 }}>
              {isOverdue ? '⚠️ ' : '📅 '}Deadline : {new Date(goal.deadline).toLocaleDateString('fr-FR')}
            </div>
          )}
        </div>

        <PriorityBar value={goal.priority} />
        <Badge status={goal.status} />
      </div>

      {/* Panneau détail */}
      {expanded && (
        <div style={{
          padding: '12px 16px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          {/* Métadonnées */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 11, color: 'var(--text-3)' }}>
            <div>ID : <code style={{ color: 'var(--text-2)' }}>{goal.id}</code></div>
            <div>Créé : {new Date(goal.createdAt).toLocaleString('fr-FR')}</div>
            {goal.completedAt && <div>Terminé : {new Date(goal.completedAt).toLocaleString('fr-FR')}</div>}
            {goal.subgoals?.length > 0 && <div>Sous-objectifs : {goal.subgoals.length}</div>}
          </div>

          {/* Actions statut */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['pending', 'active', 'completed', 'failed'].map(s => (
              <button
                key={s}
                disabled={goal.status === s}
                onClick={() => onStatus(goal.id, s)}
                style={{
                  fontSize: 11, padding: '4px 12px', borderRadius: 6, border: 'none',
                  background: goal.status === s ? STATUS_META[s].bg : 'var(--surface-2)',
                  color: goal.status === s ? STATUS_META[s].color : 'var(--text-3)',
                  cursor: goal.status === s ? 'default' : 'pointer', fontWeight: 500,
                }}
              >{STATUS_META[s].label}</button>
            ))}
            <button
              onClick={() => onDelete(goal.id)}
              style={{
                marginLeft: 'auto', fontSize: 11, padding: '4px 12px', borderRadius: 6,
                border: 'none', background: 'rgba(243,139,168,0.1)', color: 'var(--ctp-red,#f38ba8)',
                cursor: 'pointer', fontWeight: 500,
              }}
            >Supprimer</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NextMissionCard({ next }) {
  if (!next) return null;
  return (
    <div style={{
      background: 'rgba(137,180,250,0.08)', border: '1px solid rgba(137,180,250,0.2)',
      borderRadius: 10, padding: '12px 16px', marginBottom: 20,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ fontSize: 22 }}>🚀</span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ctp-blue,#89b4fa)', marginBottom: 2 }}>
          Prochaine mission planifiée
        </div>
        <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{next.description}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
          Priorité {next.priority} · {next.status}
          {next.deadline && ` · Deadline : ${new Date(next.deadline).toLocaleDateString('fr-FR')}`}
        </div>
      </div>
    </div>
  );
}

export default function GoalsPage() {
  const [goals, setGoals]     = useState([]);
  const [schedule, setSchedule] = useState(null);
  const [next, setNext]       = useState(null);
  const [input, setInput]     = useState('');
  const [priority, setPriority] = useState(5);
  const [deadline, setDeadline] = useState('');
  const [filter, setFilter]   = useState('all');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    try {
      const [gRes, sRes] = await Promise.all([
        fetch('/api/goals').then(r => r.json()),
        fetch('/api/goals/schedule').then(r => r.json()).catch(() => null),
      ]);
      setGoals(gRes.goals || []);
      if (sRes) {
        setSchedule(sRes.schedule || []);
        setNext(sRes.next || null);
      }
    } catch { /* silencieux */ }
  };

  useEffect(() => { load(); }, []);

  const addGoal = async () => {
    if (!input.trim()) return;
    setLoading(true);
    await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: input, priority, deadline: deadline || null }),
    });
    setInput(''); setDeadline('');
    await load();
    setLoading(false);
  };

  const deleteGoal = async (id) => {
    await fetch(`/api/goals/${id}`, { method: 'DELETE' });
    load();
  };

  const updateStatus = async (id, status) => {
    await fetch(`/api/goals/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    load();
  };

  const filtered = goals.filter(g => filter === 'all' || g.status === filter);

  const counts = goals.reduce((acc, g) => { acc[g.status] = (acc[g.status] || 0) + 1; return acc; }, {});

  return (
    <div style={{ padding: '24px', maxWidth: 800, overflowY: 'auto' }}>
      {/* En-tête */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>🏆 Objectifs</h2>
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0 }}>
          Planification temporelle des missions LaRuche
        </p>
      </div>

      {/* Prochaine mission */}
      <NextMissionCard next={next} />

      {/* Formulaire ajout */}
      <div style={{
        background: 'var(--surface-2)', borderRadius: 10, padding: 16,
        marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Ajouter un objectif</div>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addGoal()}
          placeholder="Description de l'objectif..."
          style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '8px 12px', color: 'var(--text)', fontSize: 13, width: '100%',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-3)' }}>Priorité</label>
            <input
              type="number" value={priority} onChange={e => setPriority(+e.target.value)}
              min={1} max={10}
              style={{
                width: 50, background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', color: 'var(--text)', fontSize: 12, textAlign: 'center',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-3)' }}>Deadline</label>
            <input
              type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', color: 'var(--text)', fontSize: 12,
              }}
            />
          </div>
          <button
            onClick={addGoal}
            disabled={loading || !input.trim()}
            style={{
              marginLeft: 'auto', background: 'var(--primary)', color: 'white',
              border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13,
              fontWeight: 600, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              opacity: loading || !input.trim() ? 0.6 : 1,
            }}
          >{loading ? '...' : 'Ajouter'}</button>
        </div>
      </div>

      {/* Filtres + compteurs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['all', 'Tous', goals.length], ...Object.entries(STATUS_META).map(([k, v]) => [k, v.label, counts[k] || 0])].map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              fontSize: 11, padding: '4px 12px', borderRadius: 20, border: 'none', cursor: 'pointer',
              background: filter === key ? 'var(--primary)' : 'var(--surface-2)',
              color: filter === key ? 'white' : 'var(--text-3)',
              fontWeight: filter === key ? 600 : 400,
            }}
          >{label} ({count})</button>
        ))}
      </div>

      {/* Liste */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.length === 0 && (
          <div style={{
            background: 'var(--surface-2)', borderRadius: 10, padding: 32,
            textAlign: 'center', color: 'var(--text-3)', fontSize: 13,
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🏁</div>
            {filter === 'all' ? 'Aucun objectif défini.' : `Aucun objectif en statut "${STATUS_META[filter]?.label}".`}
          </div>
        )}
        {filtered.map(g => (
          <GoalRow key={g.id} goal={g} onDelete={deleteGoal} onStatus={updateStatus} />
        ))}
      </div>
    </div>
  );
}
