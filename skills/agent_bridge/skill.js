// Skill: agent_bridge — Pont vers les couches Python de PICO-RUCHE
// Supporte deux modes : 'mission' (queen port 8001) et 'think' (brain port 8003)

const PYTHON_LAYERS = {
  mission: { host: "http://localhost:8001", path: "/mission" },
  think:   { host: "http://localhost:8003", path: "/think"   },
};

/**
 * Appelle une couche Python de l'agent PICO-RUCHE.
 *
 * @param {object} params
 * @param {string} params.command  - Texte de la mission ou du prompt de réflexion
 * @param {string} [params.type]   - "mission" (défaut) ou "think"
 * @returns {Promise<{success: boolean, result?: any, error?: string, layer: string}>}
 */
export async function run({ command, type = "mission" } = {}) {
  if (!command) {
    return { success: false, error: "Le paramètre 'command' est requis", layer: type };
  }

  const layer = PYTHON_LAYERS[type];
  if (!layer) {
    return {
      success: false,
      error: `Type inconnu : "${type}". Valeurs valides : "mission", "think"`,
      layer: type,
    };
  }

  const url = `${layer.host}${layer.path}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: command }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        success: false,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        layer: type,
      };
    }

    const data = await response.json();
    return { success: true, result: data, layer: type };

  } catch (err) {
    // Couche Python non démarrée ou inaccessible — dégradation gracieuse
    const isNetworkError = err.name === "TypeError" || err.code === "ECONNREFUSED";
    return {
      success: false,
      error: isNetworkError
        ? `Couche Python "${type}" non disponible (${layer.host} inaccessible)`
        : err.message,
      layer: type,
      offline: isNetworkError,
    };
  }
}
