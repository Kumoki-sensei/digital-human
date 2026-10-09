@echo off
REM ===========================================================================
REM  Digital Human - one-click launcher (Windows)
REM
REM  Double-click this file. It will:
REM    1. prepare the environment, sync dependencies, start the backend
REM    2. open http://127.0.0.1:8000/ in your default browser automatically
REM    3. keep this window open so you can read output and stop with Ctrl+C
REM
REM  Usage:
REM    start.bat             normal launch on port 8000
REM    start.bat 8010        launch on another port (first arg = port)
REM
REM  Hot reload is ON by default (the dev script enables it). To turn it off,
REM  call the PowerShell script directly instead of this launcher:
REM      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1 -Reload:$false
REM  Reason: cmd.exe mangles the "-Name:Value" switch syntax when forwarding
REM  arguments, so the boolean switch cannot be passed reliably from a .bat.
REM
REM  NOTE: this file is ASCII-only ON PURPOSE. A .bat containing Chinese text is
REM  parsed with the OEM code page and breaks on a Chinese Windows (observed: a
REM  comment line got executed as a command). All Chinese prose lives in dev.ps1.
REM
REM  NOTE 2: do not test "%ERRORLEVEL%" inside an "if (...)" block - it expands at
REM  parse time, not run time. The short-circuit form below avoids that trap.
REM ===========================================================================

chcp 65001 >nul 2>&1

REM %~dp0 already IS the project root (this file sits in it) - do NOT append ".."
set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

REM Pick PowerShell: pwsh 7 first, then Windows PowerShell 5.1.
set "PS_EXE="
where pwsh >nul 2>&1 && set "PS_EXE=pwsh"
if defined PS_EXE goto :have_ps
where powershell >nul 2>&1 && set "PS_EXE=powershell"

:have_ps
if not defined PS_EXE (
  echo.
  echo   [ERROR] PowerShell not found. Windows normally ships version 5.1.
  echo.
  pause
  exit /b 1
)

set "DEV_PS=%PROJECT_ROOT%scripts\dev.ps1"
if not exist "%DEV_PS%" (
  echo.
  echo   [ERROR] not found: %DEV_PS%
  echo   [ERROR] keep this launcher inside the project folder.
  echo.
  pause
  exit /b 1
)

echo.
echo   Digital Human launcher
echo   ----------------------
echo   project  : %PROJECT_ROOT%
echo   backend  : started with hot reload
echo   browser  : opens automatically once the server is up
echo   stop     : press Ctrl+C in this window
echo.

REM Positional argument: port. It is typed as [int] in dev.ps1, so conversion
REM from a forwarded string is reliable (that is why port is positional here
REM while the boolean switch is not forwarded at all).
if "%~1"=="" (
  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%DEV_PS%" -Open
) else (
  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%DEV_PS%" -Open "%~1"
)
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [FAILED] exit code %RC%
  echo   diagnose with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1 -Check
) else (
  echo   Server stopped.
)
echo.
pause
exit /b %RC%
