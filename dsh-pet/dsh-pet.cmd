@echo off
rem ============================================================
rem  dsh-pet local app launcher (Windows)
rem  Double-click this file to start the desktop pet without DSH.
rem  First run: installs deps + builds (needs Node.js 22.12+).
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-pet] Node.js 22.12+ is required: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [dsh-pet] Installing dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

if not exist "lib\app-main.cjs" (
  echo [dsh-pet] Building...
  call npm run bundle
  if errorlevel 1 goto :failed
  call npm run build:desktop-core
  if errorlevel 1 goto :failed
)

node lib\app-launch.js %*
exit /b %errorlevel%

:failed
echo [dsh-pet] Startup failed. See messages above.
pause
exit /b 1
