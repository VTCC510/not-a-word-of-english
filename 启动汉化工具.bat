@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js ^(18 及以上版本^): https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0cli.js"
echo.
pause
