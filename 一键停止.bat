@echo off
chcp 65001 >nul
title 停止会议服务
echo 🛑 正在强制结束后台音视频引擎...
taskkill /F /IM livekit-server.exe /T 2>nul

echo 🛑 正在强制结束后台业务后端...
taskkill /F /IM app.exe /T 2>nul

echo.
echo ✅ 所有后台服务已彻底关闭！
echo.
pause