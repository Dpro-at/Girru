@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker\open-electron.ps1"
if errorlevel 1 pause
