@echo off
REM Windows — double-click or run from cmd/PowerShell
cd /d "%~dp0"

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3 start.py
  exit /b %ERRORLEVEL%
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  python start.py
  exit /b %ERRORLEVEL%
)

echo Python 3 is required. Install from https://www.python.org/downloads/
echo Make sure "Add python.exe to PATH" is checked during install.
exit /b 1
