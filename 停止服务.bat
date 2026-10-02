@echo off
title UniTally Stop
color 0C
cd /d "%~dp0"

echo ==================================================
echo           UniTally Stop Script
echo ==================================================
echo.

REM Determine backend port from .env (backend/.env preferred, else ./.env)
set "PORT=5000"
for /f "tokens=1,* delims==" %%i in ('findstr /b "PORT=" backend\.env 2^>nul') do set "PORT=%%j"
if "%PORT%"=="5000" (
  for /f "tokens=1,* delims==" %%i in ('findstr /b "PORT=" .env 2^>nul') do set "PORT=%%j"
)

echo Closing UniTally windows...
taskkill /F /FI "WINDOWTITLE eq UniTally Backend*" >nul 2>nul
taskkill /F /FI "WINDOWTITLE eq UniTally Frontend*" >nul 2>nul

echo Killing processes on port %PORT% (backend) and 8080 (frontend)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>nul
for /f "tokens=5" %%b in ('netstat -ano ^| findstr ":8080 " ^| findstr "LISTENING"') do taskkill /F /PID %%b >nul 2>nul

echo.
echo All UniTally processes stopped.
pause
