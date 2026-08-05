@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title Evolabs - Publish Built Release

echo =====================================================
echo Evolabs - 2. Publish Built Release

echo =====================================================
echo This uploads the already-built EXE, updater signature,
echo SHA-256 file and latest.json. It does not rebuild.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-built-release.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [SUCCESS] Release publishing completed.
) else (
  echo [FAILED] Publishing stopped with exit code %CODE%.
)
echo.
pause
exit /b %CODE%
