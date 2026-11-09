@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m http.server 8173 --bind 127.0.0.1 --directory dist
  exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
  python -m http.server 8173 --bind 127.0.0.1 --directory dist
  exit /b
)
echo Python 3.12 or newer is required. Install it from https://www.python.org/downloads/
pause
