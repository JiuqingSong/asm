@echo off
rem Releases AsmPerfect 86 (commit and push first): the family server pulls from GitHub,
rem rebuilds and restarts the page (http://192.168.0.120:8075/). See release.ps1.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1"
if errorlevel 1 (
    echo.
    echo The release failed, see above.
) else (
    echo.
    echo Released.
)
pause
