' ------------------------------------------------------------------
'  Sala de Tela — inicia o servidor Node sem abrir janela nenhuma.
'  Usado pelo atalho da pasta Inicializar (inicia junto com o Windows).
' ------------------------------------------------------------------
Dim sh, fso, nodePath, appDir

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = "D:\Acesso remoto"
nodePath = "C:\Program Files\nodejs\node.exe"

If Not fso.FileExists(nodePath) Then
  nodePath = "node.exe"
End If

sh.CurrentDirectory = appDir
sh.Run """" & nodePath & """ server.js", 0, False
