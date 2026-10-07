@echo off
title AI AutomationHubs - LeadFlow Pro Server
cd /d "%~dp0"
echo ========================================================
echo   Starting AI AutomationHubs - LeadFlow Pro Server...
echo ========================================================
echo.
start http://localhost:3001
node --use-system-ca server.js
pause
