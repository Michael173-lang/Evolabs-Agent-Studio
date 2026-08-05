@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title Evolabs - Build and Test

echo =====================================================
echo Evolabs - 1. Build and Test

echo =====================================================
echo This runs the complete local Windows quality gate and
echo creates the NSIS installer, updater signature and hash.
echo It does not publish anything to GitHub.
echo.
call "%~dp0BUILD_WINDOWS.bat"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" exit /b %CODE%
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "(Get-Content -Raw -Encoding UTF8 '%~dp0package.json' | ConvertFrom-Json).version"`) do set "EVOLABS_VERSION=%%V"
echo.
echo [SUCCESS] Build files are in:
echo   %~dp0release\v%EVOLABS_VERSION%
echo.
pause
exit /b 0
