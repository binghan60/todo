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

start "" /b cmd /c "cd /d ""%~dp0server"" && npm.cmd run dev"
start "" /b cmd /c "cd /d ""%~dp0client"" && npm.cmd run dev"

echo Started API and frontend in this window (logs will interleave below).
echo Close this window to stop both servers.
pause >nul