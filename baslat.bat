@echo off
title Agent Isleri
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 2 >nul & start http://127.0.0.1:4545"
node server.js
pause
