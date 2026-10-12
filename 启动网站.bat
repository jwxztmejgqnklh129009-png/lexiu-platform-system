@echo off
setlocal
title 乐秀内部管理平台
cd /d "%~dp0"
set "LEXIU_RUNTIME="
if defined LEXIU_PYTHON set "LEXIU_RUNTIME=%LEXIU_PYTHON%"
if not defined LEXIU_PYTHON if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -c "import flask; import PIL" >nul 2>&1
    if errorlevel 1 (
        echo 项目虚拟环境依赖不完整，将尝试现有 WorkBuddy 环境。修复方法见 README。
    ) else (
        set "LEXIU_RUNTIME=%~dp0.venv\Scripts\python.exe"
    )
)
if not defined LEXIU_RUNTIME if exist "C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe" (
    set "LEXIU_RUNTIME=C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
)
if not defined LEXIU_RUNTIME (
    echo 未找到 Python。请按 README 创建项目虚拟环境，或设置 LEXIU_PYTHON。
    exit /b 1
)
if not exist "%LEXIU_RUNTIME%" (
    echo 指定的 Python 不存在，请检查 LEXIU_PYTHON。
    exit /b 1
)
echo Python： %LEXIU_RUNTIME%
"%LEXIU_RUNTIME%" -c "import flask; import PIL"
if errorlevel 1 (
    echo 当前解释器缺少应用依赖，请按 README 安装 requirements.txt。
    exit /b 1
)
if not defined PORT set "PORT=5001"
set "HOST=127.0.0.1"
echo.
echo 乐秀平台： http://127.0.0.1:%PORT%
if /i "%~1"=="--check" (
    echo 环境检查通过，未启动业务应用。
    exit /b 0
)
echo 运行时请保留本窗口；停止时按 Ctrl+C。
echo.
"%LEXIU_RUNTIME%" app.py
set "LEXIU_EXIT=%ERRORLEVEL%"
pause
exit /b %LEXIU_EXIT%
