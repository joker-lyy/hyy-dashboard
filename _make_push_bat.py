import os

SELF_DIR = os.path.dirname(os.path.abspath(__file__))

# 使用 chcp 65001 (UTF-8) + 文件写入 UTF-8 + BOM 头让 cmd 正确显示中文
# 但其实最干净是用英文 + 不带 BOM，bat 里的中文 echo 会按 GBK 解码
# → 改用纯 ASCII 输出，避免任何编码问题

lines = [
    "@echo off",
    "chcp 65001 >nul 2>&1",
    "title HYQ Dashboard - One-Click Push",
    "cd /d \"" + SELF_DIR + "\"",
    "",
    "echo ========================================",
    "echo   HYQ Dashboard - One-Click Push",
    "echo   (auto-retry until success)",
    "echo ========================================",
    "echo.",
    "echo [1/4] Checking uncommitted changes...",
    "git add -A",
    "for /f \"delims=\" %%i in ('git status --porcelain') do (",
    "    echo   Found uncommitted changes, auto-committing...",
    "    git -c user.name=\"hyy-bot\" -c user.email=\"hyy@bot.local\" commit -m \"auto: quick fix push\"",
    "    goto :has_commits",
    ")",
    "echo   Working tree clean.",
    "",
    ":has_commits",
    "echo.",
    "echo [2/4] Last 3 local commits:",
    "git log --oneline -3",
    "echo.",
    "",
    "set /a RETRY=0",
    "",
    ":push_loop",
    "set /a RETRY+=1",
    "echo [3/4] Pushing to GitHub (attempt #%RETRY%)...",
    "git push origin main",
    "if %errorlevel% equ 0 goto :push_ok",
    "",
    "echo.",
    "echo   Attempt #%RETRY% failed. Retrying in 5 seconds...",
    "echo   (Press Ctrl+C to abort)",
    "timeout /t 5 /nobreak >nul 2>&1",
    "goto :push_loop",
    "",
    ":push_ok",
    "echo.",
    "echo ========================================",
    "echo   Push OK! (Total attempts: %RETRY%)",
    "echo ========================================",
    "echo.",
    "echo [4/4] Verifying remote HEAD:",
    "git log origin/main --oneline -1",
    "echo.",
    "echo GitHub Pages will rebuild in 1-2 min.",
    "echo Refresh: https://joker-lyy.github.io/hyy-dashboard/v2/index.html",
    "echo.",
    "pause",
]

bat_path = os.path.join(SELF_DIR, "一键推送.bat")
content = "\r\n".join(lines) + "\r\n"
# 写入 ASCII 文件，bat 自己用 chcp 65001 不影响英文输出
with open(bat_path, "wb") as f:
    f.write(content.encode("gbk", errors="replace"))

print("regenerated:", bat_path)