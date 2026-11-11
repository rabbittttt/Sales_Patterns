@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 动态销量规律
cd /d "%~dp0"

rem An explicit relative interpreter is anchored to this project.
set "patternsPython=%SALES_PATTERNS_PYTHON%"
if defined patternsPython (
    for %%I in ("%patternsPython%") do set "patternsPython=%%~fI"
) else (
    set "workspaceDir=%~dp0"
    goto find_workspace
)
goto python_selected

:find_workspace
for %%I in ("%workspaceDir%\.") do set "workspaceDir=%%~fI"
for %%I in ("%workspaceDir%") do if /I "%%~nxI"=="Project" goto workspace_found
for %%I in ("%workspaceDir%\..") do set "workspaceParent=%%~fI"
if /I "%workspaceParent%"=="%workspaceDir%" goto missing_workspace
set "workspaceDir=%workspaceParent%"
goto find_workspace

:workspace_found
set "patternsPython=%workspaceDir%\.venv\Scripts\python.exe"

:python_selected
if not defined patternsPython goto missing_python
if not exist "%patternsPython%" goto missing_python
if exist "%patternsPython%\" goto missing_python
for %%I in ("%patternsPython%") do set "launcherPythonDir=%%~dpI"
set "PATH=%launcherPythonDir%;%PATH%"
for %%I in ("%launcherPythonDir%..") do set "launcherEnvironment=%%~fI"
set "VIRTUAL_ENV="
if exist "%launcherEnvironment%\pyvenv.cfg" set "VIRTUAL_ENV=%launcherEnvironment%"
echo Python: "%patternsPython%"
"%patternsPython%" -c "import importlib.util, sys; sys.exit(1 if sys.version_info < (3, 10) or importlib.util.find_spec('openpyxl') is None else 0)" >nul 2>nul
if errorlevel 1 goto missing_dependencies
"%patternsPython%" serve_sales_patterns.py %*
set "launcherExitCode=%errorlevel%"
if not "%launcherExitCode%"=="0" pause
exit /b %launcherExitCode%

:missing_python
echo [ERROR] 找不到共享 Python。请在 Project 目录运行“初始化共享环境.cmd”，重建 Project\.venv。
if defined patternsPython echo 所选的路径："%patternsPython%"
echo 也可通过 SALES_PATTERNS_PYTHON 指定有效的 Python 文件路径。
pause
exit /b 1

:missing_workspace
echo [ERROR] 找不到名为 Project 的父目录。请将本项目放在 Project 目录下，或显式设置 SALES_PATTERNS_PYTHON。
pause
exit /b 1

:missing_dependencies
echo [ERROR] 所选 Python 需要 3.10 或更新版本，并安装本项目 requirements.txt 中的依赖。
echo 请执行："%patternsPython%" -m pip install -r requirements.txt
pause
exit /b 1
