@echo off
rem DSH doctor - diagnose only (read only). ASCII on purpose: cmd parses this file in the OEM codepage.
setlocal EnableExtensions
chcp 65001 >nul
set "HERE=%~dp0"

set "NODE_EXE="
if defined DSH_DOCTOR_NODE set "NODE_EXE=%DSH_DOCTOR_NODE%"
if not defined NODE_EXE if exist "D:\AAA\AI\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=D:\AAA\AI\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "D:\AAA\AI1\nodejs\node.exe" set "NODE_EXE=D:\AAA\AI1\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do set "NODE_EXE=%%N"

if not defined NODE_EXE (
  echo [doctor] Node.js was not found. Set DSH_DOCTOR_NODE to a node.exe and run again.
  echo [doctor] Fallback: powershell -ExecutionPolicy Bypass -File "C:\Users\Administrator\.dsh\qq-agent\dsh-rescue.ps1"
  pause
  exit /b 2
)

"%NODE_EXE%" "%HERE%bin\cli.mjs" status %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
