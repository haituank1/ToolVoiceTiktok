@echo off
chcp 65001 >nul
title ToolVoiceTikTok - Doc comment TikTok LIVE
cd /d "%~dp0"

echo ============================================================
echo   ToolVoiceTikTok - Doc comment TikTok LIVE thanh giong noi
echo ============================================================
echo.

rem --- Tim Python (py launcher hoac python) ---
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [LOI] May chua co Python.
  echo Hay tai Python tai https://www.python.org/downloads/
  echo Khi cai nho tich o "Add python.exe to PATH" roi chay lai file nay.
  pause
  exit /b 1
)

rem --- Tao moi truong ao lan dau ---
if not exist ".venv\Scripts\python.exe" (
  echo Dang cai dat lan dau, cho khoang 1-2 phut...
  %PY% -m venv .venv
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [LOI] Cai thu vien that bai. Kiem tra mang roi chay lai file nay.
    pause
    exit /b 1
  )
)

rem --- Mo trinh duyet sau 3 giay, roi chay server ---
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3220"
echo Tool dang chay tai http://localhost:3220
echo Giu nguyen cua so nay khi dang live. Dong cua so = tat tool.
echo.
".venv\Scripts\python.exe" server.py
pause
