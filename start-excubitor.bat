@echo off
REM ============================================================
REM  Launch Excubitor in normal mode.
REM  Normal mode runs Excubitor and auto-starts catalog autostart
REM  services plus the saved launch set when auto launch is enabled.
REM  backend  : http://localhost:17332  (EXCUBITOR_PORT default)
REM  frontend : http://localhost:17333  (/api/* proxies to 17332)
REM  NOTE: 17331 is taken by Concordia's Vite WebUI; do not use it.
REM ============================================================

echo Starting Excubitor backend (:17332)...
start "Excubitor backend :17332" /d "%~dp0" cmd /k "npm run dev"

echo Starting Excubitor frontend (:17333)...
start "Excubitor frontend :17333" /d "%~dp0frontend" cmd /k "npm run dev"

echo Opening Excubitor in browser in 12s...
timeout /t 12 /nobreak >nul
start "" "http://localhost:17333"

echo.
echo Started Excubitor in normal mode.
echo Autostart services and the saved launch set will start automatically when configured.
