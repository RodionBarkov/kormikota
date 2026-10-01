@echo off
chcp 65001 >nul
title КормиКота
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python не найден. Установите его с https://www.python.org/downloads/
  echo   ^(при установке поставьте галочку "Add python.exe to PATH"^)
  echo.
  pause
  exit /b 1
)

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8000"
python app.py
pause
