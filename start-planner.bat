@echo off
title Planner App Launcher

echo Starting Planner App...
echo.

:: Start the servers in a new window
start "Planner Servers" cmd /k "cd /d C:\Users\shivb\planner-app && npm start"

:: Wait for servers to start
timeout /t 3 /nobreak > nul

:: Open browser
start http://localhost:5173

echo.
echo Planner app is starting...
echo - Backend: http://localhost:3001
echo - Frontend: http://localhost:5173
echo.
echo To use with Copilot CLI, open a new terminal and run: ghcs
echo.
pause
