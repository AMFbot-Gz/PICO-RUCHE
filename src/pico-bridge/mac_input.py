"""
skills/mac_input.py — Saisie clavier/souris précise

Tous les inputs avec retour position réelle + screenshot.
Coordonnées LOGIQUES (1536×960) directement.
"""

import asyncio
import time

import pyautogui

# Sécurité
pyautogui.FAILSAFE = True
pyautogui.PAUSE    = 0.03


async def click(x: int, y: int, button: str = "left", double: bool = False) -> dict:
    """Clic à la position logique (x, y)."""
    try:
        if double:
            pyautogui.doubleClick(x, y, button=button)
        else:
            pyautogui.click(x, y, button=button)
        await asyncio.sleep(0.1)
        pos = pyautogui.position()
        return {"success": True, "landed": (pos.x, pos.y)}
    except pyautogui.FailSafeException:
        return {"success": False, "error": "FAILSAFE: souris coin gauche"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def type_text(text: str, interval: float = 0.03) -> dict:
    """Tape du texte (ASCII + unicode)."""
    try:
        if any(ord(c) > 127 for c in text):
            # Unicode via pbpaste + AppleScript
            import subprocess
            safe = text.replace('"', '\\"')
            subprocess.run(
                ["osascript", "-e",
                 f'tell application "System Events" to keystroke "{safe}"'],
                check=False
            )
        else:
            pyautogui.typewrite(text, interval=interval)
        return {"success": True, "chars": len(text)}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def key(combo: str) -> dict:
    """
    Appuie sur une touche ou combinaison.
    Ex: 'return', 'escape', 'cmd+l', 'ctrl+a'
    """
    _map = {
        "return": "return", "enter": "return",
        "escape": "escape", "esc": "escape",
        "tab": "tab", "space": "space",
        "backspace": "backspace", "delete": "delete",
        "up": "up", "down": "down", "left": "left", "right": "right",
        "cmd+l": ["command", "l"],
        "cmd+r": ["command", "r"],
        "cmd+t": ["command", "t"],
        "cmd+w": ["command", "w"],
        "cmd+q": ["command", "q"],
        "cmd+a": ["command", "a"],
        "cmd+c": ["command", "c"],
        "cmd+v": ["command", "v"],
        "cmd+z": ["command", "z"],
        "cmd+space": ["command", "space"],
        "cmd+tab": ["command", "tab"],
        "ctrl+a": ["ctrl", "a"],
        "ctrl+c": ["ctrl", "c"],
        "ctrl+v": ["ctrl", "v"],
    }
    try:
        mapped = _map.get(combo, combo)
        if isinstance(mapped, list):
            pyautogui.hotkey(*mapped)
        else:
            pyautogui.press(mapped)
        await asyncio.sleep(0.1)
        return {"success": True, "key": combo}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def scroll(x: int, y: int, direction: str = "down", amount: int = 3) -> dict:
    """Scroll à la position (x, y)."""
    try:
        dy = -amount if direction == "down" else amount
        pyautogui.scroll(dy, x=x, y=y)
        await asyncio.sleep(0.1)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def move(x: int, y: int, duration: float = 0.2) -> dict:
    """Déplace la souris vers (x, y)."""
    try:
        pyautogui.moveTo(x, y, duration=duration)
        pos = pyautogui.position()
        return {"success": True, "position": (pos.x, pos.y)}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def drag(x1: int, y1: int, x2: int, y2: int, duration: float = 0.4) -> dict:
    """Drag de (x1,y1) vers (x2,y2)."""
    try:
        pyautogui.moveTo(x1, y1)
        pyautogui.dragTo(x2, y2, duration=duration, button="left")
        await asyncio.sleep(0.2)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def click_and_type(x: int, y: int, text: str) -> dict:
    """Clique sur un champ puis tape du texte."""
    r = await click(x, y)
    if not r["success"]:
        return r
    await asyncio.sleep(0.2)
    return await type_text(text)


async def select_all_and_type(x: int, y: int, text: str) -> dict:
    """Clique, sélectionne tout, remplace le texte."""
    await click(x, y)
    await asyncio.sleep(0.1)
    pyautogui.hotkey("command", "a")
    await asyncio.sleep(0.1)
    return await type_text(text)
