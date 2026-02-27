' play.vbs — Instant MP3 playback via Windows Media Player COM
' Usage: cscript //nologo play.vbs "C:\path\to\sound.mp3" [volume 0-100]
If WScript.Arguments.Count < 1 Then WScript.Quit

Dim soundPath, vol
soundPath = WScript.Arguments(0)
vol = 70
If WScript.Arguments.Count >= 2 Then vol = CInt(WScript.Arguments(1))

Set player = CreateObject("WMPlayer.OCX")
player.settings.volume = vol
player.URL = soundPath
player.controls.play

' Wait for playback to begin, then wait until it finishes
WScript.Sleep 150
Do While player.playState = 3 Or player.playState = 6
    WScript.Sleep 50
Loop

player.controls.stop
player.close
Set player = Nothing
