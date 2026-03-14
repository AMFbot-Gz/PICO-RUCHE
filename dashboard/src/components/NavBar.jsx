/**
 * NavBar.jsx — Navigation latérale SaaS
 */
import React from "react";

const NAV_ITEMS = [
  { id: "overview",  icon: "🏠", label: "Vue d'ensemble" },
  { id: "analytics", icon: "📈", label: "Analytics" },
  { id: "missions",  icon: "🎯", label: "Missions" },
  { id: "agents",    icon: "🤖", label: "Agents" },
  { id: "skills",    icon: "🔧", label: "Skills" },
  { id: "swarm",     icon: "🌐", label: "Swarm" },
  { id: "goals",     icon: "🏆", label: "Objectifs" },
  { id: "system",    icon: "📊", label: "Système" },
  { id: "logs",      icon: "📜", label: "Logs" },
  { id: "settings",  icon: "⚙️",  label: "Réglages" },
  { id: "config",    icon: "🔧", label: "Config" },
  { id: "pencil",    icon: "✏️",  label: "Pencil" },
];

export default function NavBar({ activePage, onNavigate, missionCount = 0 }) {
  return (
    <nav style={{
      width: "var(--sidebar-w, 220px)", flexShrink: 0,
      background: "var(--surface)", borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      padding: "16px 10px", gap: 2, overflowY: "auto",
    }}>
      {/* Logo */}
      <div style={{ padding: "8px 12px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🐝</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>LaRuche</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>v4.1.0 · Standalone</div>
        </div>
      </div>

      {/* Nav items */}
      {NAV_ITEMS.map(item => {
        const isActive = activePage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 12px", borderRadius: 8, border: "none",
              background: isActive ? "var(--primary-dim, rgba(224,123,84,0.12))" : "transparent",
              color: isActive ? "var(--primary)" : "var(--text-2)",
              cursor: "pointer", fontSize: 13, fontWeight: isActive ? 600 : 400,
              textAlign: "left", width: "100%", transition: "all 0.12s",
              borderLeft: isActive ? "2px solid var(--primary)" : "2px solid transparent",
            }}
            onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--surface-2)"; }}
            onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ fontSize: 16, width: 20, textAlign: "center" }}>{item.icon}</span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.id === "missions" && missionCount > 0 && (
              <span style={{
                background: "var(--primary)", color: "white",
                borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: 600,
              }}>{missionCount}</span>
            )}
          </button>
        );
      })}

      {/* Footer status */}
      <div style={{ marginTop: "auto", padding: "12px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>API · port 3000</div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>WS · port 9001</div>
      </div>
    </nav>
  );
}
