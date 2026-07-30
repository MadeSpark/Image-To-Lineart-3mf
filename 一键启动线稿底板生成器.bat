@echo off
setlocal
title Lineart Generator Launcher

set "ROOT_DIR=%~dp0"
set "WEBAPP_DIR=%ROOT_DIR%webapp"
set "NODE_EXE="
set "NODE_DIR="
set "NPM_CMD="
set "EXIT_CODE=0"

if not exist "%WEBAPP_DIR%\package.json" (
  echo [ERROR] Project folder not found:
  echo %WEBAPP_DIR%
  pause
  exit /b 1
)

call :find_node
if not defined NODE_EXE (
  echo [ERROR] Node.js was not found.
  echo Install Node.js first, then run this file again.
  pause
  exit /b 1
)

if not exist "%NPM_CMD%" (
  echo [ERROR] npm.cmd was not found:
  echo %NPM_CMD%
  pause
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"

echo.
echo [1/3] Node:
echo %NODE_EXE%

if not exist "%WEBAPP_DIR%\node_modules" (
  echo [2/3] Installing dependencies...
  pushd "%WEBAPP_DIR%"
  call "%NPM_CMD%" install
  set "EXIT_CODE=%ERRORLEVEL%"
  popd
  if not "%EXIT_CODE%"=="0" (
    echo [ERROR] npm install failed. Exit code: %EXIT_CODE%
    pause
    exit /b %EXIT_CODE%
  )
) else (
  echo [2/3] node_modules already exists. Skip install.
)

echo [3/3] Starting local web app...
echo Keep this window open while using the app.
echo.

pushd "%WEBAPP_DIR%"
call "%NPM_CMD%" run dev -- --host 127.0.0.1 --open
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Startup failed. Exit code: %EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

exit /b 0

:find_node
for /f "delims=" %%I in ('where node 2^>nul') do (
  set "NODE_EXE=%%I"
  goto set_npm
)

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
  set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
  goto set_npm
)

if exist "%USERPROFILE%\Desktop\????\runtime\node-v24.18.0-win-x64\node.exe" (
  set "NODE_EXE=%USERPROFILE%\Desktop\????\runtime\node-v24.18.0-win-x64\node.exe"
  goto set_npm
)

goto :eof

:set_npm
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "NPM_CMD=%NODE_DIR%npm.cmd"
goto :eof
