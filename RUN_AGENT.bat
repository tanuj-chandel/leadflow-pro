@echo off
title LeadFlow Pro — Agent Launcher
cd /d "%~dp0"
echo ========================================================
echo         LEADFLOW PRO — STARTING AGENT SERVER
echo ========================================================
echo.
echo Launching Agent Dashboard in your browser...
start "" "run_agent.html"
echo.
echo Starting Node.js backend server on http://localhost:3000...
echo Press Ctrl+C at any time to stop the server.
echo.
npm start
pause
