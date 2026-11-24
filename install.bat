@echo off
setlocal
rem Run from the complete CallScope distribution, as an administrator.
where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo Windows PowerShell was not found. Install Windows PowerShell 5.1 and try again.
    pause
    exit /b 1
)
if not exist "%~dp0tools\install-windows.ps1" (
    echo Installer support files are missing. Keep this file in the complete CallScope distribution.
    pause
    exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-windows.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Installation did not complete. See the message above; existing runtime data was not intentionally removed.
if "%RESULT%"=="0" echo Installer finished. Review the verification steps above before using the app.
pause
exit /b %RESULT%
