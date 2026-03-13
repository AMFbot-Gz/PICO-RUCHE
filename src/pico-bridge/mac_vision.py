"""
skills/mac_vision.py — Vision et analyse d'écran

Capture, OCR, détection d'éléments UI.
Utilise Claude Vision pour analyser ce qui est à l'écran.
"""

import asyncio
import base64
import hashlib
import io
import os

from PIL import Image


async def capture_full() -> str:
    """Capture l'écran entier → base64 PNG 1536×960."""
    from tools.screen import capture_screen
    return await capture_screen()


async def capture_region(x: int, y: int, w: int, h: int) -> str:
    """
    Capture une région spécifique.
    Coordonnées logiques → multiplie ×2 pour Retina.
    """
    import pyautogui
    # pyautogui screenshot(region=) prend des coords physiques
    screenshot = pyautogui.screenshot(region=(x * 2, y * 2, w * 2, h * 2))
    screenshot = screenshot.resize((w, h), Image.LANCZOS)
    buf = io.BytesIO()
    screenshot.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


async def get_screen_hash() -> str:
    """Hash MD5 du screenshot actuel — pour détecter les changements."""
    img_b64 = await capture_full()
    return hashlib.md5(base64.b64decode(img_b64)).hexdigest()


async def wait_for_change(timeout: float = 5.0) -> bool:
    """
    Attend jusqu'à ce que l'écran change.
    Retourne True si changement détecté, False si timeout.
    """
    before_hash = await get_screen_hash()
    deadline    = asyncio.get_event_loop().time() + timeout

    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.4)
        current_hash = await get_screen_hash()
        if current_hash != before_hash:
            return True
    return False


async def find_text_on_screen(target_text: str) -> dict:
    """
    Cherche un texte à l'écran via OCR (tesseract si dispo, sinon Claude).
    Retourne les coordonnées approximatives ou None.
    """
    try:
        import pytesseract
        import pyautogui
        screenshot = pyautogui.screenshot()
        # Resize à la moitié pour OCR (logique)
        screenshot = screenshot.resize((1536, 960), Image.LANCZOS)
        text_data  = pytesseract.image_to_data(screenshot, output_type=pytesseract.Output.DICT)

        for i, word in enumerate(text_data["text"]):
            if target_text.lower() in str(word).lower():
                x = text_data["left"][i] + text_data["width"][i] // 2
                y = text_data["top"][i]  + text_data["height"][i] // 2
                return {"found": True, "x": x, "y": y, "text": word}
        return {"found": False}

    except ImportError:
        # Pas de tesseract → utilise Claude Vision
        return {"found": False, "note": "OCR non disponible (installe tesseract)"}


async def ask_claude_about_screen(question: str, client=None, model: str = "claude-sonnet-4-5") -> str:
    """
    Pose une question à Claude sur l'écran actuel.
    Utile pour : 'Où est le bouton X ?', 'Quel est le texte dans ce champ ?'
    """
    if not client:
        import anthropic, os
        client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    img_b64 = await capture_full()

    resp = client.messages.create(
        model=model,
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": img_b64},
                },
                {"type": "text", "text": question},
            ],
        }],
    )
    return resp.content[0].text


async def get_window_bounds(app_name: str) -> dict:
    """Retourne les bounds (x, y, w, h) d'une fenêtre d'application."""
    import subprocess
    script = f'''
    tell application "System Events"
      tell process "{app_name}"
        set w to front window
        set pos to position of w
        set sz to size of w
        return (item 1 of pos & "," & item 2 of pos & "," & item 1 of sz & "," & item 2 of sz)
      end tell
    end tell
    '''
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode == 0:
        parts = result.stdout.strip().split(",")
        if len(parts) == 4:
            try:
                return {
                    "success": True,
                    "x": int(parts[0]), "y": int(parts[1]),
                    "w": int(parts[2]), "h": int(parts[3]),
                }
            except ValueError:
                pass
    return {"success": False, "error": result.stderr}
