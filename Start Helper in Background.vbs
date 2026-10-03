' Starts the YNAB Amazon Helper in the background, with no window and without opening the browser.
' Used when Windows starts (turn that on in the helper's Setup tab). Safe to run more than once.
Option Explicit
Const OPEN_PAGE = False
Dim sh, fso, dir, dataDir, runFile, logFile, q, bun, conhost, url, attempt, w
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
dataDir = dir & "\data"
runFile = dataDir & "\gui-running.json"
logFile = dataDir & "\launcher.log"
q = Chr(34)

Sub WriteLog(msg)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine Now & "  " & WScript.ScriptName & ": " & msg
  f.Close
  On Error GoTo 0
End Sub

' Reads the address of the running helper from data\gui-running.json and checks that it answers.
Function HelperUrl()
  HelperUrl = ""
  If Not fso.FileExists(runFile) Then Exit Function
  On Error Resume Next
  Dim t, re, m, port, u, h
  t = fso.OpenTextFile(runFile, 1).ReadAll
  Set re = New RegExp
  re.Pattern = q & "port" & q & "\s*:\s*(\d+)"
  Set m = re.Execute(t)
  If m.Count = 0 Then Exit Function
  port = m(0).SubMatches(0)
  re.Pattern = q & "url" & q & "\s*:\s*" & q & "([^" & q & "]+)" & q
  Set m = re.Execute(t)
  If m.Count = 0 Then Exit Function
  u = m(0).SubMatches(0)
  Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
  h.SetTimeouts 1000, 1000, 1000, 2000
  h.Open "GET", "http://127.0.0.1:" & port & "/ping", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 And InStr(h.ResponseText, "ynab-amazon-helper") > 0 Then HelperUrl = u
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function WaitForHelper(seconds)
  Dim i
  WaitForHelper = ""
  For i = 1 To seconds * 2
    WScript.Sleep 500
    WaitForHelper = HelperUrl()
    If WaitForHelper <> "" Then Exit Function
  Next
End Function

Sub Done(u)
  If OPEN_PAGE And u <> "" Then sh.Run q & u & q, 1, False
  WScript.Quit 0
End Sub

' --- checks ---
If Not fso.FileExists(dir & "\package.json") Or Not fso.FileExists(dir & "\gui\server.ts") Then
  MsgBox "This file needs to stay inside the YNAB Amazon Helper folder." & vbCrLf & "To put it on your Desktop, right-click it and choose Send to > Desktop (create shortcut).", vbExclamation, "YNAB Amazon Helper"
  WScript.Quit 1
End If
If Not fso.FileExists(dir & "\node_modules\playwright\lib\program.js") Then
  MsgBox "The helper isn't fully set up yet. Double-click Start GUI.bat once to finish setup, then try again.", vbExclamation, "YNAB Amazon Helper"
  WScript.Quit 1
End If
If Not fso.FolderExists(dataDir) Then fso.CreateFolder(dataDir)
bun = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.bun\bin\bun.exe"
If Not fso.FileExists(bun) Then bun = "bun"
conhost = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\conhost.exe"

' --- switching from a window to the background: wait (up to 20 seconds) for the windowed copy to stop ---
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "/after" Then
    WriteLog "waiting for the windowed copy to stop"
    For w = 1 To 40
      If HelperUrl() = "" Then Exit For
      WScript.Sleep 500
    Next
  End If
End If

' --- already running? ---
url = HelperUrl()
If url <> "" Then
  WriteLog "already running"
  Done url
End If

' --- start it with no window ---
' Attempt 1: Windows' console host in headless mode never shows a window (even when Windows Terminal is the default terminal).
' Attempt 2: the classic hidden start, in case attempt 1 doesn't work on this computer.
For attempt = 1 To 2
  If attempt = 1 And fso.FileExists(conhost) Then
    WriteLog "starting (headless console)"
    sh.Run q & conhost & q & " --headless " & q & bun & q & " gui\server.ts --background", 0, False
  ElseIf attempt = 2 Then
    WriteLog "starting (hidden window)"
    sh.Run q & bun & q & " gui\server.ts --background", 0, False
  End If
  If attempt = 2 Or fso.FileExists(conhost) Then
    url = WaitForHelper(30)
    If url <> "" Then
      WriteLog "running"
      Done url
    End If
    WriteLog "no answer after 30 seconds"
  End If
Next

MsgBox "The helper didn't start." & vbCrLf & vbCrLf & "Double-click Start GUI.bat to see what's wrong. Details are in data\gui-server.log and data\launcher.log.", vbExclamation, "YNAB Amazon Helper"
WScript.Quit 1
