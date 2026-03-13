"""
skills/mac_apps.py — Contrôle des applications macOS

Skills pour ouvrir, fermer, switcher entre apps.
Utilise AppleScript + pyautogui + subprocess.
"""

import asyncio
import subprocess
import time


async def open_app(name: str, wait: float = 1.5) -> dict:
    """Ouvre une application macOS par son nom."""
    try:
        subprocess.run(
            ["osascript", "-e", f'tell application "{name}" to activate'],
            check=True, capture_output=True
        )
        await asyncio.sleep(wait)
        return {"success": True, "app": name}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def quit_app(name: str) -> dict:
    """Quitte une application proprement."""
    try:
        subprocess.run(
            ["osascript", "-e", f'tell application "{name}" to quit'],
            capture_output=True
        )
        return {"success": True, "app": name}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_frontmost() -> str:
    """Retourne le nom de l'app au premier plan."""
    result = subprocess.run(
        ["osascript", "-e",
         'tell application "System Events" to get name of first application process whose frontmost is true'],
        capture_output=True, text=True
    )
    return result.stdout.strip()


async def open_safari_url(url: str) -> dict:
    """Ouvre une URL dans Safari."""
    if not url.startswith("http"):
        url = "https://" + url
    try:
        subprocess.run(
            ["osascript", "-e",
             f'tell application "Safari" to open location "{url}"'],
            check=True, capture_output=True
        )
        await asyncio.sleep(2.0)
        return {"success": True, "url": url}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def open_chrome_url(url: str) -> dict:
    """Ouvre une URL dans Chrome."""
    if not url.startswith("http"):
        url = "https://" + url
    try:
        subprocess.run(["open", "-a", "Google Chrome", url], check=True)
        await asyncio.sleep(2.0)
        return {"success": True, "url": url}
    except Exception as e:
        # Fallback : Safari
        return await open_safari_url(url)


async def new_terminal(command: str = "") -> dict:
    """Ouvre un nouveau terminal (avec commande optionnelle)."""
    script = 'tell application "Terminal" to activate\n'
    if command:
        script += f'tell application "Terminal" to do script "{command}"'
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def spotlight_open(query: str) -> dict:
    """Utilise Spotlight pour ouvrir quelque chose."""
    import pyautogui
    pyautogui.hotkey("command", "space")
    await asyncio.sleep(0.5)
    pyautogui.typewrite(query, interval=0.05)
    await asyncio.sleep(0.8)
    pyautogui.press("return")
    await asyncio.sleep(1.5)
    return {"success": True, "query": query}
