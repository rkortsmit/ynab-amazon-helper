@echo off
title YNAB Amazon Helper
cd /d "%~dp0"

rem --- 0. Make sure this launcher is inside the helper folder ---
if exist "package.json" if exist "gui\server.ts" goto in_folder
echo This launcher needs to stay inside the YNAB Amazon Helper folder, next to package.json.
echo It is running from: %CD%
echo.
echo Open the helper folder and double-click Start GUI.bat there. For a Desktop icon,
echo right-click Start GUI.bat in the helper folder and choose Send to - Desktop - create shortcut.
echo If you opened it from inside a ZIP file, extract the whole ZIP first.
pause
exit /b 1
:in_folder

rem --- 1. Bun: the small program that runs this helper ---
where bun >nul 2>nul
if not errorlevel 1 goto have_bun
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%" & goto have_bun
echo Bun is not installed yet. It is the free program that runs this helper - see https://bun.sh
choice /C YN /M "Install Bun now"
if errorlevel 2 goto no_bun
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
where bun >nul 2>nul
if errorlevel 1 goto no_bun
:have_bun

rem --- 2. The helper's components (first run only) ---
if exist "node_modules\playwright\lib\program.js" if exist "node_modules\playwright-core\cli.js" goto start
echo Installing the helper's components. This happens once, or again if an earlier install was incomplete...
call bun install --force
if errorlevel 1 goto install_failed

:start
bun gui\server.ts
pause
exit /b 0

:no_bun
echo.
echo Bun is needed to run the helper. Install it from https://bun.sh and run this file again.
pause
exit /b 1

:install_failed
echo.
echo Installing the components failed. Check your internet connection and run this file again.
pause
exit /b 1
