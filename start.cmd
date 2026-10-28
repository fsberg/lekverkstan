@echo off
cd /d %~dp0
start "Lekverkstan" /min node server.js
timeout /t 2 >nul
start http://localhost:8793/
