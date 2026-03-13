"""
SKILL: pico_browser_task
DESCRIPTION: Exécute n'importe quelle tâche web via Playwright — formulaires, scraping, navigation
VERSION: 1.0.0
CREATED: 2026-03-09
TRIGGER_KEYWORDS: [web, site, url, google, formulaire, scrape, extrait, navigue, cherche en ligne, télécharge, connecte, login, recherche, http, https]
"""

import asyncio
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))


def execute(params: dict) -> dict:
    """
    Exécute une tâche web via BrowserEngine.
    params:
      action    : "navigate" | "search" | "extract" | "fill_form" | "login" | "click" | "fill"
      url       : URL cible (pour navigate, extract, fill_form, login)
      query     : requête (pour search)
      instruction : ce qu'on veut extraire (pour extract)
      fields    : {description: value, ...} (pour fill_form)
      username  : (pour login)
      password  : (pour login)
      description : description de l'élément (pour click, fill)
      value     : valeur à saisir (pour fill)
    """
    try:
        from core.browser_agent import BrowserEngine

        browser = BrowserEngine()
        loop    = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def run():
            await browser.init(headless=False)
            action = params.get("action", "navigate")

            if action == "navigate":
                return await browser.navigate(params.get("url", "https://google.com"))

            elif action == "search":
                return await browser.search(
                    params.get("query", ""),
                    engine=params.get("engine", "google"),
                )

            elif action == "extract":
                if "url" in params:
                    await browser.navigate(params["url"])
                return await browser.extract(params.get("instruction", "extrais le contenu principal"))

            elif action == "fill_form":
                if "url" in params:
                    await browser.navigate(params["url"])
                return await browser.fill_form(params.get("fields", {}))

            elif action == "login":
                return await browser.login(
                    params.get("url", ""),
                    params.get("username", ""),
                    params.get("password", ""),
                )

            elif action == "click":
                if "url" in params:
                    await browser.navigate(params["url"])
                return await browser.click(params.get("description", ""))

            elif action == "fill":
                if "url" in params:
                    await browser.navigate(params["url"])
                return await browser.fill(
                    params.get("description", ""),
                    params.get("value", ""),
                )

            else:
                return {"success": False, "error": f"Action inconnue : {action}"}

        result = loop.run_until_complete(run())
        loop.close()

        return {
            "success": result.get("success", True),
            "result":  str(result),
            "error":   result.get("error"),
        }

    except Exception as e:
        return {"success": False, "result": "", "error": str(e)}


if __name__ == "__main__":
    result = execute({"action": "navigate", "url": "https://example.com"})
    print(f"{'✅' if result['success'] else '❌'} {result['result'][:100]}")
