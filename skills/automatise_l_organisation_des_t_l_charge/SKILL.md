---
name: automatise_l_organisation_des_t_l_charge
description: Automatise l'organisation des téléchargements par type de fichier et date
version: 1.0.0
tier: Community
tags: [auto-generated, ghost-os-v7]
---

# automatise_l_organisation_des_t_l_charge

Automatise l'organisation des téléchargements par type de fichier et date

## Pipeline CASCU (Perceive → Plan → Act → Verify → Update)

### C — Capture (Perceive)
Collecte les inputs et l'état UI/système avant d'agir.
```
Input: params.* (voir contracts.accepts dans manifest.yaml)
World Model check: GET http://localhost:8002/scan
```

### A — Analyse (Plan)
Évalue les conditions d'exécution et sélectionne la stratégie.
```
- Vérifier que les pré-conditions sont remplies
- Sélectionner l'outil approprié (voir mcp_tools dans manifest)
- Estimer le risque (low/medium/high)
```

### S — Synthèse / Exécute (Act)
Exécute l'action via toolRouter.
```
execute(params) → skill.js → toolRouter → résultat brut
```

### C — Contrôle (Verify)
Vérifie le résultat et le compare à l'attendu.
```
- result.success === true
- Durée < 5000ms (100ms si osascript avec cache SHA-256)
- Output conforme à contracts.produces
```

### U — Update
Met à jour le World Model et les métriques.
```
POST http://localhost:8006/experience {skill: "automatise_l_organisation_des_t_l_charge", outcome: ...}
```

## Prompt Interne Agent

```
Tu exécutes le skill "automatise_l_organisation_des_t_l_charge".
Mission: Automatise l'organisation des téléchargements par type de fichier et date
Règles:
1. Toujours vérifier l'état World Model avant d'agir
2. Retourner { success: true/false, result/error, duration_ms }
3. Timeout max: 5000ms (osascript: 100ms via cache SHA-256)
4. En cas d'échec, logger dans src/evolution/failureDetector
```

## Exemples

```javascript
// Appel standard
const result = await execute({});
// { success: true, result: "...", duration_ms: 42 }

// Avec params
const result = await execute({ target: "fichier.txt" });
```
