@echo off
rem Startar en tillfällig Cloudflare-tunnel till Lekverkstan. Stäng fönstret "Lekverkstan-tunnel" för att stänga av.
cd /d %~dp0
if exist data\tunnel.log del data\tunnel.log
start "Lekverkstan-tunnel" /min tools\cloudflared.exe tunnel --no-autoupdate --url http://localhost:8793 --logfile data\tunnel.log
node tools\lank.js
pause
