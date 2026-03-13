export async function run(params) {
  // params: { last_mission: string, frontmost_app: string, safari_status?: string }
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const path = await import('path');
  
  const wsPath = path.join(process.env.HOME, 'world_state.json');
  
  // Lire l'état existant
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
  } catch(e) {
    state = { mission_count: 0, notes: [] };
  }
  
  // Date UTC
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  
  // Top processes
  let topProcs = [];
  try {
    const psOut = execSync('ps aux -m | head -8').toString();
    const lines = psOut.trim().split('\n').slice(1);
    topProcs = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      return { name: parts.slice(10).join(' ').substring(0, 40), mem_percent: parseFloat(parts[3]) };
    }).filter(p => p.mem_percent > 1);
  } catch(e) {}
  
  // Frontmost app
  let frontmost = params.frontmost_app || 'unknown';
  try {
    frontmost = execSync("osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true'").toString().trim();
  } catch(e) {}
  
  // Mise à jour
  state.last_updated = now;
  state.mission_count = (state.mission_count || 0) + 1;
  state.last_mission = params.last_mission || 'unknown';
  state.active_app = {
    frontmost: frontmost,
    safari_status: params.safari_status || state.active_app?.safari_status || 'inactive'
  };
  if (topProcs.length > 0) state.top_processes = topProcs;
  
  fs.writeFileSync(wsPath, JSON.stringify(state, null, 2));
  return { success: true, path: wsPath, state };
}