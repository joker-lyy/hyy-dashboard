@echo off
chcp 65001 >nul 2>&1
title HYQ Dashboard - One-Click Push
cd /d "E:\我的\WORKBUDDY\WorkBuddy\工具搭建\hyy-dashboard-ghpages"

echo ========================================
echo   HYQ Dashboard - One-Click Push
echo   (auto-retry until success)
echo ========================================
echo.
echo [1/4] Checking uncommitted changes...
git add -A
for /f "delims=" %%i in ('git status --porcelain') do (
    echo   Found uncommitted changes, auto-committing...
    git -c user.name="hyy-bot" -c user.email="hyy@bot.local" commit -m "auto: quick fix push"
    goto :has_commits
)
echo   Working tree clean.

:has_commits
echo.
echo [2/4] Last 3 local commits:
git log --oneline -3
echo.

set /a RETRY=0

:push_loop
set /a RETRY+=1
echo [3/4] Pushing to GitHub (attempt #%RETRY%)...
git push origin main
if %errorlevel% equ 0 goto :push_ok

echo.
echo   Attempt #%RETRY% failed. Retrying in 5 seconds...
echo   (Press Ctrl+C to abort)
timeout /t 5 /nobreak >nul 2>&1
goto :push_loop

:push_ok
echo.
echo ========================================
echo   Push OK! (Total attempts: %RETRY%)
echo ========================================
echo.
echo [4/4] Verifying remote HEAD:
git log origin/main --oneline -1
echo.
echo GitHub Pages will rebuild in 1-2 min.
echo Refresh: https://joker-lyy.github.io/hyy-dashboard/v2/index.html
echo.
pause
