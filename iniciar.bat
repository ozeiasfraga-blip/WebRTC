@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias (npm install)...
  call npm install
)

rem abre o navegador 2 segundos depois, quando o servidor ja subiu
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8090'"

node server.js
pause
