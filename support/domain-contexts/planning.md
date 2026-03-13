# Contexte domaine — Planification
## Architecture v5.0.0
- src/temporal/ : goal graph DAG, scheduler
- src/simulation/ : risk estimator avant exec
- src/market/ : enchères + réputation

## Patterns
- Vision avant automation
- Test après repair (npm run test:unit)
- Snapshot rollback avant modifs critiques

## Anti-patterns
- Sous-tâches vagues → échec
- Plus de 5 en parallèle → saturation M2
