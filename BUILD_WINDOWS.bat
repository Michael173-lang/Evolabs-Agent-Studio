@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0" 2>nul
if errorlevel 1 goto bad_folder

title Evolabs v0.6.0 Windows Source Builder
set "EVOLABS_ROOT=%CD%"
set "EVOLABS_SCRIPT=%EVOLABS_ROOT%\scripts\build-windows.ps1"
set "EVOLABS_LOGDIR=%EVOLABS_ROOT%\.build\launcher-logs"

if not exist "%EVOLABS_LOGDIR%" mkdir "%EVOLABS_LOGDIR%" >nul 2>&1
set "EVOLABS_STAMP=%RANDOM%-%RANDOM%"
set "EVOLABS_LOG=%EVOLABS_LOGDIR%\launcher-%EVOLABS_STAMP%.log"

call :banner
if not exist "%EVOLABS_SCRIPT%" goto missing_script
where powershell.exe >nul 2>&1
if errorlevel 1 goto missing_powershell

>"%EVOLABS_LOG%" echo [%date% %time%] Launcher started.
>>"%EVOLABS_LOG%" echo Root: %EVOLABS_ROOT%
>>"%EVOLABS_LOG%" echo Script: %EVOLABS_SCRIPT%
>>"%EVOLABS_LOG%" echo Arguments: %*

echo [Evolabs] Starting the Windows build process...
echo [Evolabs] Launcher log: %EVOLABS_LOG%
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EVOLABS_SCRIPT%" -InstallMissing %*
set "EVOLABS_EXIT=%ERRORLEVEL%"
>>"%EVOLABS_LOG%" echo [%date% %time%] PowerShell exit code: %EVOLABS_EXIT%

if not "%EVOLABS_EXIT%"=="0" goto build_failed

echo.
echo =====================================================
echo [SUCCESS] Evolabs build and validation completed.
echo =====================================================
goto finish_ok

:banner
echo =====================================================
echo Evolabs v0.6.0 Windows Source Builder
echo =====================================================
echo Evolabs Windows 來源碼建置器
echo 這不是一般使用者安裝程式。
echo This builds the Windows NSIS installer from source.
echo Missing official tools will be installed when possible.
echo Some installers may display UAC prompts or require reboot.
echo.
exit /b 0

:bad_folder
echo.
echo [ERROR] Cannot enter the folder containing BUILD_WINDOWS.bat.
echo Fully extract the ZIP first. Do not run this file inside the ZIP.
goto finish_error

:missing_script
echo.
echo [ERROR] Required script was not found:
echo %EVOLABS_SCRIPT%
echo The archive may not have been fully extracted.
goto finish_error

:missing_powershell
echo.
echo [ERROR] powershell.exe was not found.
echo Repair Windows PowerShell 5.1 or the system PATH.
goto finish_error

:build_failed
echo.
echo =====================================================
echo [FAILED] Evolabs stopped with exit code %EVOLABS_EXIT%.
echo =====================================================
echo Read the final red PowerShell message above.
echo Build logs:
echo   %EVOLABS_ROOT%\.build\logs
echo Launcher log:
echo   %EVOLABS_LOG%
echo.
echo You may run this BAT again after installation or reboot.
goto finish_error_code

:finish_ok
echo.
echo Press any key to close this window...
pause >nul
endlocal
exit /b 0

:finish_error_code
echo.
echo This window will stay open. Press any key to exit...
pause >nul
endlocal & exit /b %EVOLABS_EXIT%

:finish_error
echo.
echo This window will stay open. Press any key to exit...
pause >nul
endlocal
exit /b 1
