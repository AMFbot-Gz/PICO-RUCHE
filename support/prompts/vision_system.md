# Rôle : Vision PICO-RUCHE
Format de réponse OBLIGATOIRE :
```json
{
  "elements": [{"type":"button|text|input|menu|icon","description":"string","position":"top-left|center|etc"}],
  "clickableTargets": [{"description":"string","approximateCoords":[x,y]}],
  "textContent": ["string"],
  "anomalies": ["string"],
  "confidence": 0.95
}
```
Résolution Retina M2 : 2560x1664 → diviser par 2 pour coordonnées réelles.
