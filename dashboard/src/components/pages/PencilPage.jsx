/**
 * PencilPage.jsx — Contrôle complet de Pencil.app via MCP
 * Sections : Status · Actions rapides · Ouvrir fichier · Clic menu · Fenêtres · Log
 */
import { useState, useEffect, useCallback, useRef } from 'react';

const API = window.QUEEN_API || 'http://localhost:3000';

async function pencilTool(tool, params = {}) {
  const r = await fetch(`${API}/mcp/pencil`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, params }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Items par menu Pencil
const MENU_ITEMS = {
  File:   ['New', 'Open', 'Save', 'Save As', 'Export', 'Close', 'Quit'],
  Edit:   ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All'],
  View:   ['Zoom In', 'Zoom Out', 'Fit Page', 'Full Screen'],
  Insert: ['Page', 'Shape', 'Text', 'Image', 'Line', 'Group'],
  Format: ['Font', 'Paragraph', 'Align Left', 'Align Center', 'Align Right', 'Bold', 'Italic'],
  Tools:  ['Inspector', 'Grids', 'Rulers', 'Guides', 'Snap to Grid'],
  Window: ['Minimize', 'Zoom', 'Bring All to Front', 'Close All'],
  Help:   ['Pencil Help', 'Release Notes', 'Check for Updates', 'Report a Bug'],
};

const MENUS = Object.keys(MENU_ITEMS);

// Spinner inline
function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: 12, height: 12,
      border: '2px solid rgba(255,255,255,0.3)',
      borderTopColor: 'white',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      marginRight: 6,
      flexShrink: 0,
    }} />
  );
}

// Badge de statut (dot + label)
function StatusDot({ online }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 12, fontWeight: 600,
      color: online ? 'var(--green)' : 'var(--red)',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: online ? 'var(--green)' : 'var(--red)',
        boxShadow: online
          ? '0 0 6px var(--green)'
          : '0 0 6px var(--red)',
        animation: online ? 'pulse 2s ease-in-out infinite' : 'none',
        display: 'inline-block',
      }} />
      {online ? 'Ouvert' : 'Fermé'}
    </span>
  );
}

// Toast message flottant
function Toast({ message, onDismiss }) {
  if (!message) return null;
  const isErr = message.type === 'error';
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', bottom: 28, right: 28, zIndex: 9999,
        background: isErr ? 'rgba(248,113,113,0.15)' : 'rgba(74,222,128,0.12)',
        border: `1px solid ${isErr ? 'rgba(248,113,113,0.4)' : 'rgba(74,222,128,0.3)'}`,
        color: isErr ? 'var(--red)' : 'var(--green)',
        borderRadius: 10, padding: '10px 16px',
        fontSize: 13, fontWeight: 500,
        boxShadow: 'var(--shadow-lg)',
        cursor: 'pointer',
        animation: 'slideUp 0.2s ease both',
        maxWidth: 340,
        display: 'flex', alignItems: 'center', gap: 8,
      }}
    >
      <span>{isErr ? '✕' : '✓'}</span>
      <span>{message.text}</span>
    </div>
  );
}

// Bouton générique avec état loading
function ActionBtn({
  label, icon, onClick, danger = false,
  disabled = false, loading = false, small = false,
}) {
  const [hovered, setHovered] = useState(false);
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: 6, border: 'none', borderRadius: 8, cursor: disabled || loading ? 'not-allowed' : 'pointer',
    fontWeight: 600, transition: 'all 0.15s',
    opacity: disabled ? 0.5 : 1,
    fontSize: small ? 12 : 13,
    padding: small ? '6px 12px' : '8px 16px',
  };
  const colors = danger
    ? {
        background: hovered ? 'rgba(248,113,113,0.25)' : 'rgba(248,113,113,0.12)',
        color: 'var(--red)',
      }
    : {
        background: hovered ? 'var(--primary-hover)' : 'var(--primary)',
        color: 'white',
      };

  return (
    <button
      style={{ ...base, ...colors }}
      onClick={onClick}
      disabled={disabled || loading}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {loading && <Spinner />}
      {!loading && icon && <span>{icon}</span>}
      {label}
    </button>
  );
}

// Carte d'action rapide
function QuickCard({ icon, label, onClick, loading, danger = false }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={!loading ? onClick : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered
          ? (danger ? 'rgba(248,113,113,0.1)' : 'var(--surface-3)')
          : 'var(--surface-2)',
        border: `1px solid ${hovered
          ? (danger ? 'rgba(248,113,113,0.35)' : 'var(--border-2)')
          : 'var(--border)'}`,
        borderRadius: 10, padding: '18px 14px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        cursor: loading ? 'not-allowed' : 'pointer',
        transition: 'all 0.15s',
        opacity: loading ? 0.7 : 1,
        userSelect: 'none',
        minHeight: 88,
        justifyContent: 'center',
      }}
    >
      {loading
        ? <span style={{ fontSize: 24, lineHeight: 1 }}><Spinner /></span>
        : <span style={{ fontSize: 24, lineHeight: 1 }}>{icon}</span>
      }
      <span style={{
        fontSize: 12, fontWeight: 600, textAlign: 'center',
        color: danger ? 'var(--red)' : 'var(--text)',
        lineHeight: 1.3,
      }}>{label}</span>
    </div>
  );
}

// Section wrapper avec titre
function Section({ title, children, extra }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </h3>
        {extra}
      </div>
      {children}
    </div>
  );
}

// Ligne de log
function LogRow({ entry }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '6px 0',
      borderBottom: '1px solid var(--border)',
      animation: 'slideUp 0.15s ease both',
    }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'monospace', flexShrink: 0, marginTop: 1 }}>
        {entry.ts}
      </span>
      <span style={{
        fontSize: 12, fontWeight: 600, flexShrink: 0,
        color: entry.ok ? 'var(--green)' : 'var(--red)',
      }}>
        {entry.ok ? '✓' : '✕'}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, lineHeight: 1.4 }}>
        <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{entry.tool}</span>
        {entry.detail && <span style={{ color: 'var(--text-3)' }}> — {entry.detail}</span>}
      </span>
    </div>
  );
}

export default function PencilPage() {
  // -- État global
  const [pencilOnline, setPencilOnline] = useState(false);
  const [windows, setWindows]           = useState([]);
  const [docCount, setDocCount]         = useState(0);
  const [lastRefresh, setLastRefresh]   = useState(null);
  const [toast, setToast]               = useState(null);
  const [logs, setLogs]                 = useState([]);

  // -- États loading par action
  const [loadingMap, setLoadingMap]     = useState({});

  // -- Section 3 : Ouvrir fichier
  const [filePath, setFilePath]         = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // -- Section 4 : Menu
  const [selectedMenu, setSelectedMenu] = useState('File');
  const [selectedItem, setSelectedItem] = useState(MENU_ITEMS['File'][0]);

  // -- Ref pour le screenshot
  const [screenshotUrl, setScreenshotUrl] = useState(null);

  // Toast auto-dismiss
  const toastTimer = useRef(null);
  const showToast = useCallback((text, type = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ text, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  // Ajout au log des actions
  const addLog = useCallback((tool, ok, detail = '') => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [{ ts, tool, ok, detail }, ...prev].slice(0, 20));
  }, []);

  // Wrapper générique pour les appels MCP avec gestion loading
  const run = useCallback(async (key, tool, params = {}, opts = {}) => {
    setLoadingMap(m => ({ ...m, [key]: true }));
    try {
      const res = await pencilTool(tool, params);
      const ok = !res?.error;
      const detail = opts.detail?.(res) ?? (res?.error || '');
      addLog(tool, ok, detail);
      if (ok) {
        showToast(opts.successMsg || `${tool} exécuté avec succès`, 'success');
      } else {
        showToast(res?.error || `Erreur : ${tool}`, 'error');
      }
      return res;
    } catch (err) {
      addLog(tool, false, err.message);
      showToast(err.message, 'error');
      return null;
    } finally {
      setLoadingMap(m => ({ ...m, [key]: false }));
    }
  }, [addLog, showToast]);

  // Rafraîchissement du statut (get_windows)
  const refresh = useCallback(async (silent = false) => {
    try {
      const res = await pencilTool('get_windows', {});
      const wins = Array.isArray(res?.windows) ? res.windows : [];
      setWindows(wins);
      setDocCount(wins.length);
      setPencilOnline(wins.length > 0 || res?.running === true);
      setLastRefresh(new Date().toLocaleTimeString('fr-FR'));
      if (!silent) addLog('get_windows', true, `${wins.length} fenêtre(s)`);
    } catch {
      setPencilOnline(false);
      setWindows([]);
      setDocCount(0);
      if (!silent) addLog('get_windows', false, 'Impossible de contacter le MCP');
    }
  }, [addLog]);

  // Auto-refresh toutes les 10s
  useEffect(() => {
    refresh(true);
    const t = setInterval(() => refresh(true), 10000);
    return () => clearInterval(t);
  }, [refresh]);

  // Changer le menu principal réinitialise l'item
  const handleMenuChange = (menu) => {
    setSelectedMenu(menu);
    setSelectedItem(MENU_ITEMS[menu][0]);
  };

  // Actions rapides
  const handleScreenshot = async () => {
    const res = await run('screenshot', 'screenshot', {}, {
      successMsg: 'Screenshot capturé',
      detail: (r) => r?.path || '',
    });
    if (res?.imageBase64) {
      setScreenshotUrl(`data:image/png;base64,${res.imageBase64}`);
    } else if (res?.path) {
      setScreenshotUrl(res.path);
    }
  };

  const handleFocusWindow = async (windowId) => {
    const key = windowId ? `focus_${windowId}` : 'focus_window';
    await run(key, 'focus_window', windowId ? { windowId } : {}, {
      successMsg: 'Fenêtre focalisée',
    });
    refresh(true);
  };

  const handleOpenFile = async () => {
    if (!filePath.trim()) return;
    await run('open_file', 'open_file', { path: filePath.trim() }, {
      successMsg: `Fichier ouvert : ${filePath}`,
      detail: () => filePath,
    });
    setShowSuggestions(false);
    refresh(true);
  };

  const handleClickMenu = async () => {
    await run('click_menu', 'click_menu', { menu: selectedMenu, item: selectedItem }, {
      successMsg: `${selectedMenu} › ${selectedItem} exécuté`,
      detail: () => `${selectedMenu} › ${selectedItem}`,
    });
  };

  // Input style partagé
  const inputStyle = {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '8px 12px',
    color: 'var(--text)', fontSize: 13, outline: 'none',
    transition: 'border-color 0.15s',
  };

  const selectStyle = {
    ...inputStyle,
    cursor: 'pointer',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23A09C94'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 10px center',
    paddingRight: 28,
  };

  return (
    <div style={{
      padding: '24px',
      maxWidth: 900,
      display: 'flex',
      flexDirection: 'column',
      gap: 20,
      overflowY: 'auto',
      paddingBottom: 60,
    }}>

      {/* ── SECTION 1 : Status Bar ─────────────────────────────── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'linear-gradient(180deg, var(--bg) 80%, transparent 100%)',
        paddingBottom: 8,
      }}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '14px 20px',
          display: 'flex', alignItems: 'center', gap: 16,
          boxShadow: 'var(--shadow)',
          flexWrap: 'wrap',
        }}>
          {/* Logo + nom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>✏️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2 }}>
                Pencil.app
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                MCP Control
              </div>
            </div>
          </div>

          {/* Séparateur */}
          <div style={{ width: 1, height: 32, background: 'var(--border)', flexShrink: 0 }} />

          {/* Status dot */}
          <StatusDot online={pencilOnline} />

          {/* Badge documents */}
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
            background: 'var(--primary-dim)', color: 'var(--primary)',
          }}>
            {docCount} document{docCount !== 1 ? 's' : ''}
          </span>

          {/* Dernière mise à jour */}
          {lastRefresh && (
            <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
              Rafraîchi à {lastRefresh}
            </span>
          )}

          {/* Boutons principaux */}
          <div style={{ display: 'flex', gap: 8, marginLeft: lastRefresh ? 0 : 'auto' }}>
            <ActionBtn
              label="Rafraîchir"
              icon="↻"
              small
              loading={loadingMap['refresh_btn']}
              onClick={async () => {
                setLoadingMap(m => ({ ...m, refresh_btn: true }));
                await refresh(false);
                setLoadingMap(m => ({ ...m, refresh_btn: false }));
              }}
            />
            <ActionBtn
              label="Ouvrir Pencil"
              icon="▶"
              small
              loading={loadingMap['open_app']}
              onClick={() => run('open_app', 'open_app', {}, {
                successMsg: 'Pencil.app lancé',
                detail: () => 'open_app',
              }).then(() => refresh(true))}
            />
            <ActionBtn
              label="Fermer"
              icon="✕"
              small
              danger
              loading={loadingMap['close_header']}
              onClick={() => run('close_header', 'close_app', { force: false }, {
                successMsg: 'Pencil.app fermé',
              }).then(() => refresh(true))}
            />
          </div>
        </div>
      </div>

      {/* ── SECTION 2 : Actions rapides ───────────────────────── */}
      <Section title="Actions rapides">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          <QuickCard
            icon="📄" label="Nouveau document"
            loading={!!loadingMap['new_document']}
            onClick={() => run('new_document', 'new_document', {}, {
              successMsg: 'Nouveau document créé',
            }).then(() => refresh(true))}
          />
          <QuickCard
            icon="🖼️" label="Exporter PNG"
            loading={!!loadingMap['export_png']}
            onClick={() => run('export_png', 'export_png', {}, {
              successMsg: 'Export PNG lancé',
              detail: (r) => r?.path || '',
            })}
          />
          <QuickCard
            icon="🎯" label="Focus fenêtre"
            loading={!!loadingMap['focus_window']}
            onClick={() => handleFocusWindow(null)}
          />
          <QuickCard
            icon="📸" label="Screenshot"
            loading={!!loadingMap['screenshot']}
            onClick={handleScreenshot}
          />
          <QuickCard
            icon="🛑" label="Fermer (safe)"
            loading={!!loadingMap['close_safe']}
            onClick={() => run('close_safe', 'close_app', { force: false }, {
              successMsg: 'Fermeture gracieuse lancée',
            }).then(() => refresh(true))}
          />
          <QuickCard
            icon="⚡" label="Fermer (force)"
            danger
            loading={!!loadingMap['close_force']}
            onClick={() => run('close_force', 'close_app', { force: true }, {
              successMsg: 'Fermeture forcée exécutée',
            }).then(() => refresh(true))}
          />
        </div>

        {/* Screenshot preview */}
        {screenshotUrl && (
          <div style={{ marginTop: 4 }}>
            <div style={{
              fontSize: 11, color: 'var(--text-3)', marginBottom: 8,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Aperçu du dernier screenshot</span>
              <button
                onClick={() => setScreenshotUrl(null)}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-3)',
                  cursor: 'pointer', fontSize: 12, padding: '2px 6px',
                }}
              >✕ Fermer</button>
            </div>
            <div style={{
              borderRadius: 8, overflow: 'hidden',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
            }}>
              <img
                src={screenshotUrl}
                alt="Screenshot Pencil"
                style={{ width: '100%', display: 'block', maxHeight: 360, objectFit: 'contain' }}
                onError={() => setScreenshotUrl(null)}
              />
            </div>
          </div>
        )}
      </Section>

      {/* ── SECTION 3 : Ouvrir un fichier ────────────────────── */}
      <Section title="Ouvrir un fichier">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                value={filePath}
                onChange={e => setFilePath(e.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                onKeyDown={e => e.key === 'Enter' && handleOpenFile()}
                placeholder="Chemin du fichier, ex : ~/Desktop/diagram.epgz"
                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
              />
              {/* Suggestions dropdown */}
              {showSuggestions && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                  background: 'var(--surface-2)', border: '1px solid var(--border-2)',
                  borderRadius: 8, marginTop: 4, overflow: 'hidden',
                  boxShadow: 'var(--shadow-lg)',
                }}>
                  {['~/Desktop', '~/Documents', '~/Downloads', '~/Projects'].map(s => (
                    <div
                      key={s}
                      onMouseDown={() => setFilePath(s + '/')}
                      style={{
                        padding: '8px 12px', fontSize: 12, cursor: 'pointer',
                        color: 'var(--text-2)',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-3)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      📁 {s}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <ActionBtn
              label="Ouvrir"
              icon="📂"
              loading={!!loadingMap['open_file']}
              disabled={!filePath.trim()}
              onClick={handleOpenFile}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Formats supportés : .epgz · .svg · .png · .pdf — Cliquez dans le champ pour voir les suggestions
          </div>
        </div>
      </Section>

      {/* ── SECTION 4 : Clic menu ─────────────────────────────── */}
      <Section title="Clic menu Pencil">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>Menu</label>
            <select
              value={selectedMenu}
              onChange={e => handleMenuChange(e.target.value)}
              style={{ ...selectStyle, minWidth: 120 }}
            >
              {MENUS.map(m => (
                <option key={m} value={m} style={{ background: 'var(--surface-2)' }}>{m}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>Item</label>
            <select
              value={selectedItem}
              onChange={e => setSelectedItem(e.target.value)}
              style={{ ...selectStyle, minWidth: 160 }}
            >
              {(MENU_ITEMS[selectedMenu] || []).map(item => (
                <option key={item} value={item} style={{ background: 'var(--surface-2)' }}>{item}</option>
              ))}
            </select>
          </div>
          <ActionBtn
            label="Exécuter"
            icon="▶"
            loading={!!loadingMap['click_menu']}
            onClick={handleClickMenu}
          />
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text-3)',
          padding: '6px 10px', background: 'var(--surface-2)',
          borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ color: 'var(--primary)', fontWeight: 600 }}>›</span>
          Commande sélectionnée :{' '}
          <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>
            {selectedMenu} › {selectedItem}
          </span>
        </div>
      </Section>

      {/* ── SECTION 5 : Fenêtres ouvertes ────────────────────── */}
      <Section
        title="Fenêtres ouvertes"
        extra={
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
            background: windows.length > 0 ? 'var(--primary-dim)' : 'var(--surface-2)',
            color: windows.length > 0 ? 'var(--primary)' : 'var(--text-3)',
          }}>
            {windows.length} fenêtre{windows.length !== 1 ? 's' : ''}
          </span>
        }
      >
        {windows.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '28px 0',
            color: 'var(--text-3)', fontSize: 13,
          }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🪟</div>
            Aucune fenêtre Pencil détectée.
            <div style={{ fontSize: 11, marginTop: 6 }}>
              Ouvrez Pencil via le bouton ci-dessus, puis rafraîchissez.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {windows.map((win, idx) => {
              const winId = win.id ?? win.windowId ?? idx;
              const key = `focus_win_${winId}`;
              return (
                <div
                  key={winId}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 14px', borderRadius: 8,
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <span style={{ fontSize: 16, flexShrink: 0 }}>🪟</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 500, color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {win.title || win.name || `Fenêtre ${idx + 1}`}
                    </div>
                    {win.id && (
                      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>
                        ID : {win.id}
                      </div>
                    )}
                  </div>
                  <ActionBtn
                    label="Focus"
                    icon="🎯"
                    small
                    loading={!!loadingMap[key]}
                    onClick={() => {
                      setLoadingMap(m => ({ ...m, [key]: true }));
                      run(key, 'focus_window', { windowId: winId }, {
                        successMsg: `Fenêtre "${win.title || winId}" focalisée`,
                      }).finally(() => setLoadingMap(m => ({ ...m, [key]: false })));
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── SECTION 6 : Log des actions ──────────────────────── */}
      <Section
        title="Journal des actions"
        extra={
          logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              style={{
                background: 'none', border: 'none',
                color: 'var(--text-3)', fontSize: 11,
                cursor: 'pointer', padding: '2px 6px',
                borderRadius: 4, transition: 'color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-3)'}
            >
              Effacer
            </button>
          )
        }
      >
        {logs.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '24px 0',
            color: 'var(--text-3)', fontSize: 12,
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
            Aucune action enregistrée pour l'instant.
          </div>
        ) : (
          <div style={{
            maxHeight: 280, overflowY: 'auto',
            display: 'flex', flexDirection: 'column',
            paddingRight: 4,
          }}>
            {logs.map((entry, i) => (
              <LogRow key={i} entry={entry} />
            ))}
          </div>
        )}
      </Section>

      {/* Toast flottant */}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
