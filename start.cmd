@echo off
chcp 65001 >nul
title OpenCode Bridge (free / Go)
cd /d "%~dp0"
node bin.mjs start %*
if errorlevel 1 if not errorlevel 130 pause
