@echo off
REM ============================================================
REM  Launch Excubitor in PLAIN MODE (safe mode).
REM  PLAIN MODE = Excubitor itself starts, but NO service is
REM  auto-launched (autostart and saved launch set are skipped).
REM  Monitoring / scan / Web GUI / control API all run normally;
REM  start services manually from the Launch / Monitor tab.
REM  backend  : http://localhost:17332  (EXCUBITOR_PORT default)
REM  frontend : http://localhost:17333  (/api/* proxies to 17332)
REM  NOTE: 17331 is taken by Concordia's Vite WebUI; do not use it.
REM ============================================================

echo Starting Excubitor backend (:17332) in PLAIN MODE...
start "Excubitor backend :17332 [PLAIN]" /d "%~dp0" cmd /k "npm run dev:safe"

echo Starting Excubitor frontend (:17333)...
start "Excubitor frontend :17333" /d "%~dp0frontend" cmd /k "npm run dev"

echo Opening Excubitor in browser in 12s...
timeout /t 12 /nobreak >nul
start "" "http://localhost:17333"

echo.
echo Started in PLAIN MODE. Nothing is auto-launched.
echo Open the Launch tab to start services manually.
