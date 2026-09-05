@echo off
chcp 65001 >nul 2>&1
title HYQ Dashboard - One-Click Push
cd /d "%~dp0"

echo ========================================
echo   HYQ Dashboard - One-Click Push
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
echo [2/4] Syncing with remote (pull --rebase)...
git pull --rebase origin main
if %errorlevel% neq 0 echo   WARN: pull --rebase failed, will try push anyway
echo.
echo [3/4] Last 3 local commits:
git log --oneline -3
echo.
set /a RETRY=0

:push_loop
set /a RETRY+=1
echo [4/4] Pushing to GitHub (attempt #%RETRY%)...
git pull --rebase origin main >nul 2>&1
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
echo   PUSH OK - GitHub Pages will rebuild in 1-3 min
echo ========================================
pause