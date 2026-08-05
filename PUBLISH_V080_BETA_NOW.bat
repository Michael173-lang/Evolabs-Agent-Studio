@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Publish Evolabs v0.8.0-beta.1
chcp 65001 >nul 2>&1

echo =====================================================
echo Evolabs v0.8.0-beta.1 - verified one-click publisher
echo =====================================================
echo This will push the reviewed source, run the full Windows
echo quality gate, merge it, build, sign, and publish the Beta.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-v080-beta-now.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [SUCCESS] Evolabs v0.8.0-beta.1 was published.
) else (
  echo [FAILED] Publishing stopped safely with exit code %CODE%.
)
echo.
pause
exit /b %CODE%
