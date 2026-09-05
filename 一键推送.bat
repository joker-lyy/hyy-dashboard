@echo off
chcp 65001 >nul 2>&1
title 慧运营看板 - 一键推送(重试到成功)
cd /d "E:\我的\WORKBUDDY\WorkBuddy\工具搭建\hyy-dashboard-ghpages"

echo ========================================
echo   慧运营看板 GitHub Pages 一键推送
echo   (自动重试直到成功)
echo ========================================
echo.
echo [1/4] 检查未提交的改动...
git add -A
for /f "delims=" %%i in ('git status --porcelain') do (
    echo   发现有未提交改动，自动提交...
    git -c user.name="hyy-bot" -c user.email="hyy@bot.local" commit -m "auto: quick fix push"
    goto :has_commits
)
echo   工作区干净，无需自动提交。

:has_commits
echo.
echo [2/4] 本地最近 3 条 commit:
git log --oneline -3
echo.

set /a RETRY=0

:push_loop
set /a RETRY+=1
echo [3/4] 推送到 GitHub (第 %RETRY% 次尝试)...
git push origin main
if %errorlevel% equ 0 goto :push_ok

echo.
echo   第 %RETRY% 次推送失败，5 秒后自动重试...
echo   (按 Ctrl+C 可中断)
timeout /t 5 /nobreak >nul 2>&1
goto :push_loop

:push_ok
echo.
echo ========================================
echo   推送成功！(共尝试 %RETRY% 次)
echo ========================================
echo.
echo [4/4] 验证远端最新 commit:
git log origin/main --oneline -1
echo.
echo GitHub Pages 将在 1-2 分钟内自动构建。
echo 刷新页面: https://joker-lyy.github.io/hyy-dashboard/v2/index.html
echo.
pause
