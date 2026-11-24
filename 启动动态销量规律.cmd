@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title 动态销量规律
set "patternsEntry=dynamic\serve_sales_patterns.py"
"%~dp0core\launch.cmd" %*
