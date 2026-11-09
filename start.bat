@echo off
cd /d "%~dp0"

REM Honour PORT from the environment or .env, default 3001
if "%PORT%"=="" (
  for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "PORT=" .env 2^>nul`) do set PORT=%%b
)
if "%PORT%"=="" set PORT=3001

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Starting Sentinel Node Tester ^(Solana^) on http://localhost:%PORT%
node server.js
pause
