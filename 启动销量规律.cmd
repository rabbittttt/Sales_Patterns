@echo off
chcp 65001 >nul
call "%~dp0启动静态销量规律.cmd" %*
exit /b %errorlevel%
