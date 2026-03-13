# Contexte domaine — Code PICO-RUCHE
## Stack technique v5.0.0
- Runtime : Node.js 20+ · Python 3.9+
- Architecture : 10 couches cognitives (perception worldmodel temporal simulation evolution memory swarm market selfdev hud)
- MCP : mcp-os-control mcp-terminal mcp-vision mcp-vault mcp-rollback mcp-skill-factory mcp-janitor mcp-compressor mcp-context-manager
- Tests : 153 tests — npm run test:unit doit rester vert

## Conventions
- ESM imports dans .js
- Logs préfixés : [NomModule] message
- Erreurs : TRANSIENT vs FATAL

## Erreurs courantes
- ECONNREFUSED 11434 → ollama serve
- MODULE_NOT_FOUND → npm install
