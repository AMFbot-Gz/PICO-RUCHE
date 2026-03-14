/**
 * App.jsx — LaRuche HQ Dashboard SaaS
 * Navigation multi-pages, toast notifications, contrôle total sans terminal
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { ToastProvider, useToast } from "./components/Toast.jsx";
import NavBar from "./components/NavBar.jsx";
import Overview  from "./components/pages/Overview.jsx";
import Missions  from "./components/pages/Missions.jsx";
import Agents    from "./components/pages/Agents.jsx";
import Skills    from "./components/pages/Skills.jsx";
import System    from "./components/pages/System.jsx";
import Logs      from "./components/pages/Logs.jsx";
import Settings  from "./components/pages/Settings.jsx";
import SwarmPage from "./components/pages/SwarmPage.jsx";
import GoalsPage from "./components/pages/GoalsPage.jsx";
import PencilPage from "./components/pages/PencilPage.jsx";
import ConfigPage from "./components/pages/ConfigPage.jsx";
import AnalyticsPage from "./components/pages/AnalyticsPage.jsx";

const QUEEN_API = import.meta.env.VITE_QUEEN_API || "http://localhost:3000";
const WS_URL    = import.meta.env.VITE_WS_URL    || "ws://localhost:9001";

function useWebSocket(url, onMessage) {
  const wsRef = useRef(null);
  const reconnRef = useRef(null);
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;
  useEffect(() => {
    let alive = true;
    const connect = () => {
      if (!alive) return;
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onmessage = e => { try { cbRef.current(JSON.parse(e.data)); } catch {} };
        ws.onclose = () => { if (alive) reconnRef.current = setTimeout(connect, 3000); };
        ws.onerror = () => ws.close();
      } catch {}
    };
    connect();
    return () => { alive = false; clearTimeout(reconnRef.current); wsRef.current?.close(); };
  }, [url]);
}

// TopBar globale
function TopBar({ status, onRestart }) {
  const isOnline = status?.status === "online";
  const { toast } = useToast() || {};
  const handleRestart = async () => {
    if (!confirm("Redémarrer LaRuche ?")) return;
    try {
      await fetch(`${QUEEN_API}/api/process/restart`, { method: "POST" });
      toast?.("Redémarrage en cours...", "warn");
    } catch { toast?.("Erreur de redémarrage", "error"); }
  };
  return (
    <div style={{
      height: 52, background: "var(--surface)", borderBottom: "1px solid var(--border)",
      display: "flex", alignItems: "center", paddingInline: 20, gap: 16, flexShrink: 0,
    }}>
      <div style={{ flex: 1, fontSize: 13, color: "var(--text-3)" }}>
        {status?.ollama?.ok && <span style={{ color: "var(--text-3)" }}>Ollama {status.ollama.latencyMs}ms · </span>}
        <span style={{ color: "var(--text-3)" }}>{status?.missions?.total || 0} missions · </span>
        <span style={{ color: "var(--text-3)" }}>uptime {Math.floor((status?.uptime || 0) / 60)}m</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: isOnline ? "var(--green)" : "var(--red)",
          boxShadow: isOnline ? "0 0 8px var(--green)" : "none",
          display: "inline-block",
        }} />
        <span style={{ fontSize: 12, color: isOnline ? "var(--green)" : "var(--red)", fontWeight: 500 }}>
          {isOnline ? "Online" : "Offline"}
        </span>
        <button
          onClick={handleRestart}
          title="Redémarrer LaRuche"
          style={{
            background: "var(--surface-3)", border: "1px solid var(--border-2)",
            borderRadius: 6, padding: "5px 12px", color: "var(--text-2)",
            fontSize: 12, cursor: "pointer", marginLeft: 8,
          }}
        >↺ Restart</button>
      </div>
    </div>
  );
}

// Pages map
const PAGES = { overview: Overview, missions: Missions, agents: Agents, skills: Skills, system: System, logs: Logs, settings: Settings, swarm: SwarmPage, goals: GoalsPage, pencil: PencilPage, config: ConfigPage, analytics: AnalyticsPage };

function AppInner() {
  const [page, setPage] = useState("overview");
  const [status, setStatus] = useState({});
  const [wsEvents, setWsEvents] = useState([]);
  const [missionCount, setMissionCount] = useState(0);
  const { toast } = useToast() || {};

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(`${QUEEN_API}/api/status`);
      if (r.ok) {
        const d = await r.json();
        setStatus(d);
        setMissionCount(d.missions?.total || 0);
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 8000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useWebSocket(WS_URL, useCallback(event => {
    setWsEvents(prev => [...prev.slice(-200), event]);
    if (event.type === "mission_complete") {
      toast?.(`Mission terminée en ${((event.mission?.duration || 0) / 1000).toFixed(1)}s`, "success");
      loadStatus();
    }
    if (event.type === "mission_error") {
      toast?.(`Mission échouée: ${event.error?.substring(0, 60)}`, "error");
    }
    if (event.type === "mission_start") {
      toast?.(`Mission démarrée`, "info", 2000);
    }
  }, [toast, loadStatus]));

  const PageComponent = PAGES[page] || Overview;
  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", overflow: "hidden" }}>
      <NavBar activePage={page} onNavigate={setPage} missionCount={missionCount} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <TopBar status={status} />
        <main style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          <PageComponent status={status} wsEvents={wsEvents} onNavigate={setPage} />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
