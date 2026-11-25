@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Node.js 18+ not found. Please install from https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0cli.js" --from-bat
if %ERRORLEVEL% NEQ 0 pause
