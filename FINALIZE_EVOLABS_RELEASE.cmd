@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Evolabs Final GitHub Release

set "REPO=Michael173-lang/Evolabs-Agent-Studio"
set "REMOTE=https://github.com/%REPO%.git"
set "TAG=v0.6.0"

echo =====================================================
echo Evolabs Final GitHub Release
echo =====================================================
echo Repository: %REPO%
echo Tag: %TAG%
echo.

where git.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git is not installed.
  pause
  exit /b 1
)

where gh.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] GitHub CLI is not installed.
  pause
  exit /b 1
)

gh auth status --hostname github.com
if errorlevel 1 (
  echo [ERROR] GitHub CLI is not logged in.
  echo Run: gh auth login
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] Put this file beside package.json.
  pause
  exit /b 1
)

if not exist ".git" (
  git init
  if errorlevel 1 goto failed
)

git config user.name "Michael173-lang"
git config user.email "Michael173-lang@users.noreply.github.com"

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "%REMOTE%"
) else (
  git remote set-url origin "%REMOTE%"
)
if errorlevel 1 goto failed

git add -A
if errorlevel 1 goto failed

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Release Evolabs Agent Studio v0.6.0"
  if errorlevel 1 goto failed
)

git branch -M main
if errorlevel 1 goto failed

echo.
echo [1/3] Uploading source...
git push -u origin main
if errorlevel 1 goto failed

git rev-parse "%TAG%" >nul 2>&1
if errorlevel 1 (
  git tag -a "%TAG%" -m "Evolabs Agent Studio %TAG%"
  if errorlevel 1 goto failed
)

echo.
echo [2/3] Starting signed Windows build...
git push origin "%TAG%"
if errorlevel 1 (
  git ls-remote --exit-code --tags origin "refs/tags/%TAG%" >nul 2>&1
  if errorlevel 1 goto failed
  echo Tag already exists on GitHub. Continuing.
)

echo.
echo [3/3] Opening GitHub Actions...
start "" "https://github.com/%REPO%/actions"

echo.
echo =====================================================
echo [SUCCESS] Source and release tag were uploaded.
echo GitHub Actions is now building the signed Setup.exe.
echo =====================================================
echo.
echo You can close this window.
pause
exit /b 0

:failed
echo.
echo =====================================================
echo [FAILED] The command directly above failed.
echo =====================================================
pause
exit /b 1
