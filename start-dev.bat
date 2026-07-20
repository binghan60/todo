@echo off
setlocal
cd /d "%~dp0"

echo Starting Gemini Screenshot Todo...
echo Project: %CD%
echo Frontend: http://localhost:1420
echo API:      http://localhost:8787/api/health
echo.

if not exist ".env" (
  echo [WARN] .env not found.
  echo Create .env with: GEMINI_API_KEY=your_gemini_api_key_here
  echo.
)

start "Gemini Todo API" cmd /k "cd /d ""%~dp0server"" && npm.cmd run dev"
start "Gemini Todo Frontend" cmd /k "cd /d ""%~dp0client"" && npm.cmd run dev"

echo Started API and frontend in separate windows.
echo Close those windows to stop the servers.
pause