# Contexte domaine — Automation macOS M2
## APIs disponibles
- mcp-os-control : moveMouse click typeText screenshot
- PyAutoGUI : click(x/2, y/2) — TOUJOURS diviser par 2 pour Retina
- Permissions : System Preferences > Privacy > Accessibility

## Séquences communes
- Screenshot région : screencapture -x -R "x,y,w,h" /tmp/capture.png
- Cliquer : pyautogui.click(x/2, y/2)
- Copier : robot.keyTap('c', 'command')
