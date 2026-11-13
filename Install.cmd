@echo off
rem One-time setup: installs Electron, builds the app, and starts it.
rem After this it starts with Windows and waits quietly for Arena.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo Installing Electron. This can take a few minutes...
call npm install --no-fund --no-audit
if errorlevel 1 goto failed
call node node_modules\electron\install.js
if errorlevel 1 goto failed
call node scripts\build-app.mjs
if errorlevel 1 goto failed
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
echo.
echo Done. Look for the small gold square in your system tray.
pause
exit /b 0
:failed
echo.
echo Setup failed. Send Claude the messages above.
pause
exit /b 1
