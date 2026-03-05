Set ws = CreateObject("Wscript.Shell")

' 以隐藏窗口模式(参数0)启动 LiveKit
ws.Run "livekit-server.exe --dev --bind 0.0.0.0 --node-ip 10.126.126.10", 0, False

' 睡 2 秒，等底层引擎启动完毕
WScript.Sleep 2000

' 以隐藏窗口模式(参数0)启动 Flask 后端
ws.Run "app.exe", 0, False

' 弹出一个友好的提示框，告诉你启动成功了
MsgBox "局域网会议系统已在后台静默运行！" & vbCrLf & vbCrLf & "请通过浏览器访问: http://10.126.126.10:5000", 64, "启动成功"