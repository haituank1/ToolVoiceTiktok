@echo off
chcp 65001 >nul
title ToolVoiceTikTok - Doc comment TikTok LIVE
cd /d "%~dp0"

echo ============================================================
echo   ToolVoiceTikTok - Doc comment TikTok LIVE thanh giong noi
echo ============================================================
echo.

rem --- Kiem tra Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] May chua co Node.js.
  echo Hay tai ban LTS tai https://nodejs.org/ , cai xong chay lai file nay.
  pause
  exit /b 1
)

rem --- Cai thu vien lan dau ---
if not exist "node_modules" (
  echo Dang cai dat thu vien lan dau, cho khoang 1-2 phut...
  call npm install
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
node server.js
pause
