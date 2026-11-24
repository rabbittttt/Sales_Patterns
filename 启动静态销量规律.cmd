@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title 静态销量规律
set "patternsEntry=static\analyze_sales_patterns.py"
"%~dp0core\launch.cmd" %*
