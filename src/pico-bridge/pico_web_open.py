"""
SKILL: pico_web_open
DESCRIPTION: Ouvre une URL dans le navigateur par défaut macOS
VERSION: 1.0.0
CREATED: 2026-03-09
TRIGGER_KEYWORDS: [ouvre, url, site, navigateur, http, www, browser, lien, visite, accède]
"""

import re
import subprocess
import time


def execute(params: dict) -> dict:
    """
    Ouvre une URL dans le navigateur par défaut.
    params:
      - url (str)  : URL à ouvrir (http/https)
      - app (str, optionnel) : "Safari"|"Chrome"|"Firefox" (sinon navigateur par défaut)
      - wait (float, défaut 1.5) : secondes d'attente après ouverture
    """
    try:
        url = params.get("url", "")

        # Extrait l'URL depuis du texte libre si nécessaire
        if not url.startswith(("http://", "https://")):
            match = re.search(r"https?://\S+", url)
            if match:
                url = match.group()
            elif url and not url.startswith("http"):
                url = "https://" + url.lstrip("/")

        if not url:
            return {"success": False, "result": "", "error": "URL manquante"}

        app  = params.get("app", "")
        wait = float(params.get("wait", 1.5))

        if app:
            cmd = ["open", "-a", app, url]
        else:
            cmd = ["open", url]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        time.sleep(wait)

        success = result.returncode == 0
        return {
            "success": success,
            "result":  f"Ouverture de {url}" if success else "",
            "error":   result.stderr.strip() if not success else None,
            "url":     url,
        }

    except subprocess.TimeoutExpired:
        return {"success": False, "result": "", "error": "Timeout (>15s)", "url": ""}
    except Exception as e:
        return {"success": False, "result": "", "error": str(e), "url": ""}


if __name__ == "__main__":
    result = execute({"url": "https://www.google.com"})
    print(f"{'✅' if result['success'] else '❌'} {result['result'] or result['error']}")
