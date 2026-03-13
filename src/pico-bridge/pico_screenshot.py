"""
SKILL: pico_screenshot
DESCRIPTION: Prend une capture d'écran et la sauvegarde dans memory/screenshots/
VERSION: 1.0.0
CREATED: 2026-03-09
TRIGGER_KEYWORDS: [screenshot, capture, écran, voir, regarde, photo écran, prends]
"""

import io
from datetime import datetime
from pathlib import Path


def execute(params: dict) -> dict:
    """
    Prend une capture d'écran.
    params:
      - path (str, optionnel) : chemin de sauvegarde
      - compress (bool, défaut True) : compresse à 1280px max
    """
    try:
        from PIL import ImageGrab, Image

        img = ImageGrab.grab()

        compress = params.get("compress", True)
        if compress:
            w, h = img.size
            if w > 1280:
                img = img.resize((1280, int(h * 1280 / w)), Image.LANCZOS)

        save_path = params.get("path")
        if not save_path:
            BASE_DIR  = Path(__file__).parent.parent
            shots_dir = BASE_DIR / "memory" / "screenshots"
            shots_dir.mkdir(parents=True, exist_ok=True)
            ts        = datetime.now().strftime("%Y%m%d_%H%M%S")
            save_path = str(shots_dir / f"pico_{ts}.png")

        img.save(save_path, "PNG")
        w, h = img.size
        return {
            "success": True,
            "result":  f"Capture {w}×{h} sauvegardée → {save_path}",
            "error":   None,
            "path":    save_path,
        }
    except Exception as e:
        return {"success": False, "result": "", "error": str(e), "path": ""}


if __name__ == "__main__":
    result = execute({})
    print(f"{'✅' if result['success'] else '❌'} {result['result'] or result['error']}")
