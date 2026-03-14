/**
 * AnalyticsPage.jsx — Tableau de bord analytique PICO-RUCHE
 * 5 sections : KPIs · Bar chart · Statuts · Épisodes mémoire · Providers LLM
 */

import React, { useState, useEffect, useCallback } from "react";

const QUEEN_API   = import.meta.env.VITE_QUEEN_API || "http://localhost:3000";
const BRAIN_API   = "http://localhost:8003";
const MEMORY_API  = "http://localhost:8006";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtAgo(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)     return `il y a ${Math.floor(diff / 1000)}s`;
  if (diff < 3600000)   return `il y a ${Math.floor(diff / 60000)}min`;
  if (diff < 86400000)  return `il y a ${Math.floor(diff / 3600000)}h`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

function fmtNumber(n) {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Dernier jour YYYY-MM-DD
function dayKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

// Libellé court du jour (lun, mar, …)
function shortDay(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("fr-FR", { weekday: "short" }).slice(0, 3);
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ w = "100%", h = 16, radius = 6 }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: radius,
      background: "linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%)",
      backgroundSize: "400px 100%",
      animation: "shimmer 1.5s infinite",
    }} />
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionTitle({ title, sub }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
        {title}
      </h2>
      {sub && <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{sub}</p>}
    </div>
  );
}

// ─── Section 1 — KPI Card ─────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color, icon, loading, trend }) {
  return (
    <div style={{
      background: "var(--surface-2)",
      border: "1px solid var(--border-2)",
      borderRadius: "var(--radius-lg)",
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
      flex: 1,
      minWidth: 160,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{
          fontSize: 11,
          color: "var(--text-3)",
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}>{label}</span>
        <span style={{ fontSize: 18 }}>{icon}</span>
      </div>

      {loading ? (
        <Skeleton h={34} radius={6} />
      ) : (
        <div style={{
          fontSize: 30,
          fontWeight: 700,
          color: color || "var(--text)",
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
        }}>{value}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {sub && !loading && (
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</span>
        )}
        {loading && <Skeleton w="60%" h={11} />}
        {trend !== undefined && !loading && (
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: trend >= 0 ? "var(--green)" : "var(--red)",
            marginLeft: "auto",
          }}>
            {trend >= 0 ? `↑ +${trend}%` : `↓ ${trend}%`}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Section 2 — Bar Chart CSS pur ────────────────────────────────────────────

function BarChart({ data }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120, padding: "0 4px" }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div style={{
            width: "100%",
            height: `${(d.value / max) * 100}%`,
            minHeight: d.value > 0 ? 4 : 0,
            background: "var(--primary)",
            borderRadius: "3px 3px 0 0",
            transition: "height 0.3s ease",
            opacity: d.value === 0 ? 0.25 : 1,
          }} title={`${d.label} : ${d.value}`} />
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Section 3 — Status Bar ───────────────────────────────────────────────────

function StatusBar({ label, count, total, color }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "var(--text-2)", fontSize: 13 }}>{label}</span>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>
          {count}{" "}
          <span style={{ color: "var(--text-3)", fontWeight: 400 }}>({pct}%)</span>
        </span>
      </div>
      <div style={{ height: 6, background: "var(--surface-4)", borderRadius: 3 }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: 3,
          transition: "width 0.5s ease",
        }} />
      </div>
    </div>
  );
}

// ─── Section 4 — Badge rôle épisode ───────────────────────────────────────────

function RoleBadge({ role }) {
  const cfg = {
    user:      { color: "var(--blue)",    bg: "rgba(96,165,250,0.12)" },
    assistant: { color: "var(--primary)", bg: "var(--primary-dim)"    },
    system:    { color: "var(--yellow)",  bg: "rgba(251,178,76,0.12)" },
    tool:      { color: "var(--green)",   bg: "rgba(74,222,128,0.12)" },
  }[role?.toLowerCase()] || { color: "var(--text-3)", bg: "var(--surface-3)" };

  return (
    <span style={{
      background: cfg.bg,
      color: cfg.color,
      border: `1px solid ${cfg.color}30`,
      borderRadius: 20,
      padding: "1px 9px",
      fontSize: 10,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      whiteSpace: "nowrap",
      flexShrink: 0,
    }}>
      {role || "unknown"}
    </span>
  );
}

// ─── Section 5 — Provider card ────────────────────────────────────────────────

function ProviderCard({ name, cb }) {
  const isOpen   = cb?.state === "open";
  const failures = cb?.failure_count ?? 0;
  const maxFail  = cb?.max_failures ?? 5;
  const resets   = cb?.reset_count ?? 0;
  const pct      = maxFail > 0 ? Math.min((failures / maxFail) * 100, 100) : 0;

  return (
    <div style={{
      background: "var(--surface-3)",
      border: `1px solid ${isOpen ? "rgba(248,113,113,0.25)" : "var(--border)"}`,
      borderRadius: "var(--radius)",
      padding: "14px 16px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textTransform: "capitalize" }}>
          {name}
        </span>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          padding: "2px 9px",
          borderRadius: 20,
          background: isOpen ? "rgba(248,113,113,0.12)" : "rgba(74,222,128,0.12)",
          color: isOpen ? "var(--red)" : "var(--green)",
          border: `1px solid ${isOpen ? "rgba(248,113,113,0.3)" : "rgba(74,222,128,0.3)"}`,
        }}>
          {isOpen ? "circuit ouvert" : "actif"}
        </span>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>
        Échecs : {failures} / {maxFail}
      </div>
      <div style={{ height: 4, background: "var(--surface-4)", borderRadius: 2, marginBottom: 8 }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: isOpen ? "var(--red)" : pct > 60 ? "var(--yellow)" : "var(--green)",
          borderRadius: 2,
          transition: "width 0.4s ease",
        }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)" }}>
        Resets : {resets}
      </div>
    </div>
  );
}

// ─── AnalyticsPage ────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [missions,   setMissions]   = useState([]);
  const [brainHealth, setBrainHealth] = useState(null);
  const [episodes,   setEpisodes]   = useState([]);
  const [memoryOk,   setMemoryOk]   = useState(true);
  const [loading,    setLoading]    = useState(true);
  const [lastFetch,  setLastFetch]  = useState(null);

  // ── Fetch de toutes les données ────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [missRes, brainRes, episRes] = await Promise.allSettled([
        fetch(`${QUEEN_API}/api/missions?limit=200`),
        fetch(`${BRAIN_API}/health`),
        fetch(`${MEMORY_API}/episodes?limit=10`),
      ]);

      // Missions
      if (missRes.status === "fulfilled" && missRes.value.ok) {
        const d = await missRes.value.json();
        setMissions(d.missions || []);
      }

      // Brain health (circuit breakers + tokens)
      if (brainRes.status === "fulfilled" && brainRes.value.ok) {
        setBrainHealth(await brainRes.value.json());
      } else {
        setBrainHealth(null);
      }

      // Épisodes mémoire
      if (episRes.status === "fulfilled" && episRes.value.ok) {
        const d = await episRes.value.json();
        setEpisodes(d.episodes || d || []);
        setMemoryOk(true);
      } else {
        setMemoryOk(false);
      }
    } catch {
      // silencieux — chaque section gère l'absence de données
    } finally {
      setLoading(false);
      setLastFetch(new Date());
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 20000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // ── Calculs KPIs ───────────────────────────────────────────────────────────
  const total        = missions.length;
  const successes    = missions.filter(m => m.status === "success").length;
  const failures     = missions.filter(m => m.status === "error").length;
  const running      = missions.filter(m => m.status === "running").length;
  const pending      = missions.filter(m => m.status === "pending").length;
  const successRate  = total > 0 ? Math.round((successes / total) * 100) : 0;

  // Temps moyen d'exécution (missions terminées avec durée)
  const withDuration = missions.filter(m => m.duration && m.duration > 0);
  const avgDuration  = withDuration.length > 0
    ? Math.round(withDuration.reduce((s, m) => s + m.duration, 0) / withDuration.length)
    : 0;

  // Tokens LLM depuis brain /health
  const tokensTotal = brainHealth?.tokens_used ?? brainHealth?.total_tokens ?? null;

  // Trend fictif basé sur ratio dernière 24h vs 48h (faute d'historique)
  const now   = Date.now();
  const last24 = missions.filter(m => now - new Date(m.startedAt || m.ts || 0).getTime() < 86400000).length;
  const prev24 = missions.filter(m => {
    const age = now - new Date(m.startedAt || m.ts || 0).getTime();
    return age >= 86400000 && age < 172800000;
  }).length;
  const trendPct = prev24 > 0 ? Math.round(((last24 - prev24) / prev24) * 100) : null;

  // ── Bar chart — 7 derniers jours ──────────────────────────────────────────
  const barData = (() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, label: shortDay(key) });
    }
    const counts = {};
    missions.forEach(m => {
      const k = dayKey(m.startedAt || m.ts || new Date().toISOString());
      counts[k] = (counts[k] || 0) + 1;
    });
    return days.map(d => ({ label: d.label, value: counts[d.key] || 0 }));
  })();

  // ── Circuit breakers ───────────────────────────────────────────────────────
  const circuitBreakers = brainHealth?.circuit_breakers || {};
  const providerNames   = Object.keys(circuitBreakers).length > 0
    ? Object.keys(circuitBreakers)
    : ["claude", "kimi", "openai"];

  return (
    <div style={{
      flex: 1,
      overflowY: "auto",
      padding: "28px 32px",
      display: "flex",
      flexDirection: "column",
      gap: 28,
    }}>

      {/* ── En-tête ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", marginBottom: 4 }}>
            Analytics
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-3)" }}>
            Performance et métriques de l'essaim PICO-RUCHE
          </p>
        </div>
        {lastFetch && (
          <span style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>
            Mis à jour {fmtAgo(lastFetch.toISOString())}
          </span>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 1 — KPIs
      ════════════════════════════════════════════════════════════════ */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <KpiCard
          label="Missions totales"
          value={loading ? "" : fmtNumber(total)}
          sub={`${last24} aujourd'hui`}
          color="var(--text)"
          icon="🎯"
          loading={loading}
          trend={trendPct}
        />
        <KpiCard
          label="Taux de succès"
          value={loading ? "" : `${successRate}%`}
          sub={`${successes} réussies · ${failures} échouées`}
          color={successRate >= 80 ? "var(--green)" : successRate >= 50 ? "var(--yellow)" : "var(--red)"}
          icon="✅"
          loading={loading}
        />
        <KpiCard
          label="Durée moyenne"
          value={loading ? "" : avgDuration > 0 ? `${fmtNumber(avgDuration)}ms` : "—"}
          sub={withDuration.length > 0 ? `sur ${withDuration.length} missions` : "Pas encore de données"}
          color="var(--blue)"
          icon="⚡"
          loading={loading}
        />
        <KpiCard
          label="Tokens LLM"
          value={loading ? "" : tokensTotal !== null ? fmtNumber(tokensTotal) : "—"}
          sub={brainHealth ? "Brain :8003 actif" : "Brain :8003 hors ligne"}
          color="var(--violet)"
          icon="🧠"
          loading={loading}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 2 — Bar chart 7 jours
      ════════════════════════════════════════════════════════════════ */}
      <div style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border-2)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
      }}>
        <SectionTitle
          title="Missions par jour"
          sub="7 derniers jours · basé sur date de lancement"
        />
        {loading ? (
          <Skeleton h={120} radius={6} />
        ) : (
          <BarChart data={barData} />
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 3 — Distribution des statuts
      ════════════════════════════════════════════════════════════════ */}
      <div style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border-2)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
      }}>
        <SectionTitle
          title="Distribution des statuts"
          sub={`${total} missions au total`}
        />
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...Array(4)].map((_, i) => <Skeleton key={i} h={28} radius={4} />)}
          </div>
        ) : (
          <div>
            <StatusBar label="Succès"    count={successes} total={total} color="var(--green)"   />
            <StatusBar label="Erreurs"   count={failures}  total={total} color="var(--red)"     />
            <StatusBar label="En cours"  count={running}   total={total} color="var(--blue)"    />
            <StatusBar label="En attente" count={pending}  total={total} color="var(--yellow)"  />
          </div>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 4 — Épisodes mémoire
      ════════════════════════════════════════════════════════════════ */}
      <div style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border-2)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
      }}>
        <SectionTitle
          title="Derniers épisodes mémoire"
          sub="Memory layer :8006 · 10 épisodes récents"
        />

        {!memoryOk ? (
          <div style={{
            padding: "20px",
            textAlign: "center",
            color: "var(--text-3)",
            background: "var(--surface-3)",
            borderRadius: "var(--radius)",
            fontSize: 13,
          }}>
            Memory layer offline — :8006 inaccessible
          </div>
        ) : loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...Array(5)].map((_, i) => <Skeleton key={i} h={52} radius={8} />)}
          </div>
        ) : episodes.length === 0 ? (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>
            Aucun épisode enregistré
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {episodes.map((ep, i) => {
              const content = ep.content || ep.summary || ep.text || ep.message || "";
              const truncated = content.length > 150 ? content.slice(0, 150) + "…" : content;
              const role = ep.role || ep.type || "unknown";
              const ts   = ep.timestamp || ep.created_at || ep.ts;
              const dur  = ep.duration_ms ?? ep.duration ?? null;

              return (
                <div key={ep.id || i} style={{
                  background: "var(--surface-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <RoleBadge role={role} />
                    <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: "auto" }}>
                      {ts ? fmtAgo(ts) : "—"}
                    </span>
                    {dur !== null && (
                      <span style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>
                        {dur}ms
                      </span>
                    )}
                  </div>
                  {truncated && (
                    <p style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5, margin: 0 }}>
                      {truncated}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 5 — Performance providers LLM
      ════════════════════════════════════════════════════════════════ */}
      <div style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border-2)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
        marginBottom: 8,
      }}>
        <SectionTitle
          title="Performance des providers LLM"
          sub="Circuit breakers · Brain :8003"
        />

        {!brainHealth ? (
          <div style={{
            padding: "20px",
            textAlign: "center",
            color: "var(--text-3)",
            background: "var(--surface-3)",
            borderRadius: "var(--radius)",
            fontSize: 13,
          }}>
            Brain :8003 inaccessible — données indisponibles
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            {providerNames.map(name => (
              <ProviderCard
                key={name}
                name={name}
                cb={circuitBreakers[name] || null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
