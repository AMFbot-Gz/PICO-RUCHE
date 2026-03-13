"""
SKILL: pico_applescript
DESCRIPTION: Exécute des commandes AppleScript macOS natives (Finder, Dock, notifications, dialogues)
VERSION: 1.0.0
CREATED: 2026-03-09
TRIGGER_KEYWORDS: [applescript, osascript, finder, dock, notification, dialogue, alerte, macOS natif]
"""

import subprocess


def execute(params: dict) -> dict:
    """
    Exécute un script AppleScript.
    params:
      - script (str) : code AppleScript à exécuter
      - preset (str, optionnel) : "notify"|"dialog"|"open_app"|"volume"
      - message (str) : texte pour les presets
      - app (str)     : nom de l'app pour "open_app"
      - level (int)   : volume 0-100 pour "volume"
    """
    try:
        script = params.get("script", "")

        # Presets pratiques si pas de script brut
        if not script:
            preset  = params.get("preset", "")
            message = params.get("message", "PICO")

            if preset == "notify":
                script = (
                    f'display notification "{message}" '
                    f'with title "PICO" sound name "Glass"'
                )
            elif preset == "dialog":
                script = f'display dialog "{message}" buttons {{"OK"}} default button "OK"'
            elif preset == "open_app":
                app    = params.get("app", "Finder")
                script = f'tell application "{app}" to activate'
            elif preset == "volume":
                level  = int(params.get("level", 50))
                script = f"set volume output volume {level}"
            else:
                return {"success": False, "result": "", "error": "Paramètre 'script' ou 'preset' requis"}

        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=30,
        )

        success = result.returncode == 0
        output  = result.stdout.strip() or ("OK" if success else "")
        error   = result.stderr.strip() if not success else None

        return {"success": success, "result": output, "error": error}

    except subprocess.TimeoutExpired:
        return {"success": False, "result": "", "error": "Timeout AppleScript (>30s)"}
    except Exception as e:
        return {"success": False, "result": "", "error": str(e)}


if __name__ == "__main__":
    result = execute({"preset": "notify", "message": "PICO AppleScript OK"})
    print(f"{'✅' if result['success'] else '❌'} {result['result'] or result['error']}")
