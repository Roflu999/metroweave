@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24, then run this launcher again.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  if not exist "node_modules" (
    call npm.cmd ci
    if errorlevel 1 exit /b 1
  )
  call npm.cmd run build
  if errorlevel 1 exit /b 1
)
echo Open http://127.0.0.1:5173 in your browser.
node scripts\serve.mjs
