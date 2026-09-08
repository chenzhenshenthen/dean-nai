@echo off
setlocal
cd /d "%~dp0"
title Local deanai Studio
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. See the message above.
  pause
)
