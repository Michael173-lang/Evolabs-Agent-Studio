@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Publish Evolabs Update

echo =====================================================
echo Evolabs one-command update publisher
echo =====================================================
echo No local EXE rebuild is required. GitHub Actions will
echo build, test, sign and publish the update.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-update.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [SUCCESS] The update was submitted to GitHub Actions.
) else (
  echo [FAILED] Publishing stopped with exit code %CODE%.
)
echo.
pause
exit /b %CODE%
