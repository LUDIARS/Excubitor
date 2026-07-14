@echo off
setlocal
cd /d "%~dp0"

echo Installing Excubitor dependencies...
call npm install
if errorlevel 1 (
  echo Excubitor dependency install failed. 1>&2
  exit /b 1
)

call npm --prefix frontend install
if errorlevel 1 (
  echo Excubitor frontend dependency install failed. 1>&2
  exit /b 1
)

echo Building Excubitor backend and WebUI...
call npm run build
if errorlevel 1 (
  echo Excubitor backend build failed. 1>&2
  exit /b 1
)

call npm --prefix frontend run build
if errorlevel 1 (
  echo Excubitor WebUI build failed. 1>&2
  exit /b 1
)

echo Requesting Excubitor start from the local supervisor...
call npm run ctl -- excubitor start --json
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo Local supervisor request failed. Ensure the persistent supervisor is installed and running. 1>&2
  echo Install on Windows: powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 1>&2
  echo Development supervisor command: npm run service 1>&2
)

exit /b %EXIT_CODE%
