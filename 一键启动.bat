@echo off
title UniTally Launcher
color 0A
cd /d "%~dp0"

echo ==================================================
echo            UniTally One-Click Start
echo ==================================================
echo.

REM ---------- Check Node.js ----------
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

REM ---------- Install root dependencies ----------
echo [1/4] Checking root dependencies...
if not exist "node_modules" (
    echo Installing...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Root npm install failed.
        pause
        exit /b 1
    )
    echo Done.
) else (
    echo Already installed.
)
echo.

REM ---------- Install backend dependencies ----------
echo [2/4] Checking backend dependencies...
if not exist "backend\node_modules" (
    echo Installing...
    pushd "backend"
    call npm install
    if %errorlevel% neq 0 (
        popd
        echo [ERROR] Backend npm install failed.
        pause
        exit /b 1
    )
    popd
    echo Done.
) else (
    echo Already installed.
)
echo.

REM ---------- Start backend (port from backend/.env or .env, default 5000) ----------
echo [3/4] Starting backend (http://localhost:5000) ...
start "UniTally-Backend" /d "%~dp0backend" cmd /k "title UniTally Backend & color 0B & node server.js"

REM ---------- Start frontend (Vite, default 8080) ----------
echo [4/4] Starting frontend (http://localhost:8080) ...
start "UniTally-Frontend" /d "%~dp0" cmd /k "title UniTally Frontend & color 0E & npm run dev"

echo.
echo ==================================================
echo   Ready:
echo     Frontend: http://localhost:8080
echo     Backend:  http://localhost:5000
echo   Closing this window does NOT stop the servers.
echo ==================================================

REM Wait a few seconds, then open the browser
ping -n 7 127.0.0.1 >nul
start "" http://localhost:8080

echo.
echo Tip: run stop.bat (停止服务.bat) to stop both servers.
ping -n 9 127.0.0.1 >nul
exit
