@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Evolabs Automatic Update Setup

echo =====================================================
echo Evolabs one-time signed updater setup
echo =====================================================
echo This creates or connects a PUBLIC GitHub repository,
echo stores the signing key as a GitHub Actions secret,
echo and starts the first signed installer build.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-auto-update.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [SUCCESS] Automatic updates are configured.
) else (
  echo [FAILED] Setup stopped with exit code %CODE%.
)
echo.
pause
exit /b %CODE%
