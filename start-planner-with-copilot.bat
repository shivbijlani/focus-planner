@echo off
title Planner + Copilot Launcher

echo Starting Planner App with Copilot CLI...
echo.

:: Start the servers in a new window
start "Planner Servers" cmd /k "cd /d C:\Users\shivb\planner-app && npm start"

:: Wait for servers to start
timeout /t 3 /nobreak > nul

:: Open browser
start http://localhost:5173

:: Start Copilot CLI in a new window
start "GitHub Copilot CLI" cmd /k "ghcs"

echo.
echo Setup complete!
echo - Planner App: http://localhost:5173 (opened in browser)
echo - Copilot CLI: New terminal window
echo.
echo Arrange windows side-by-side for best experience.
echo.
