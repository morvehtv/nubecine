@echo off
REM Arranca rclone (Jottacloud) y la web en Windows.
REM Requisitos: Node.js 18+ y rclone.exe en esta carpeta o en el PATH.
cd /d "%~dp0"
start "rclone" /min rclone rcd --rc-serve --rc-no-auth --rc-addr 127.0.0.1:5572 --buffer-size 32M
timeout /t 2 >nul
node src\server.js
pause
