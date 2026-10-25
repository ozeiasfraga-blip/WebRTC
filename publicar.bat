@echo off
rem Copia a interface para o XAMPP e garante que o servidor Node esta rodando.
rem Rode este arquivo sempre que alterar algo dentro de public\.
cd /d "%~dp0"

echo Publicando em C:\xampp\htdocs\sala ...
robocopy "public" "C:\xampp\htdocs\sala" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo FALHOU ao copiar os arquivos.
  pause
  exit /b 1
)
echo Arquivos atualizados.

powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:8090/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Iniciando o servidor Node...
  start "" wscript.exe "%~dp0servidor-oculto.vbs"
  timeout /t 4 >nul
) else (
  echo Servidor Node ja esta rodando.
)

echo.
echo Pronto: https://survivorsstrugglepve.com.br/sala/
ping -n 6 127.0.0.1 >nul
