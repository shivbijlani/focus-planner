@echo off
:: Planner Services - auto-start backend (3001) + frontend (5173)
cd /d C:\Users\shivb\planner-app
start /min "Planner Services" cmd /c npm start
