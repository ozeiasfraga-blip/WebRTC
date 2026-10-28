# ---------------------------------------------------------------------
#  Agente de suporte remoto - Sala de Tela
#
#  Roda no computador que vai ser assistido. Recebe cliques e teclas do
#  tecnico (via servidor) e aplica no Windows usando SendInput.
#
#  Nao instala nada, nao pede administrador, nao grava a sessao.
#  Feche a janela (ou Ctrl+C) para encerrar na hora.
#
#  Uso:  agente.bat  (o .bat baixado do site chama este script)
# ---------------------------------------------------------------------

param(
  [string]$Codigo = "",
  [string]$Servidor = "wss://survivorsstrugglepve.com.br/sala/agente",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
try { $Host.UI.RawUI.WindowTitle = "Suporte remoto - Sala de Tela" } catch { }

Add-Type -AssemblyName System.Windows.Forms

# ---------------------------- Win32 ----------------------------------
$win32 = @"
using System;
using System.Runtime.InteropServices;

public static class Win32
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    // Digita uma sequencia curta (inclui pares surrogate de emoji) de uma vez
    public static void UnicodeText(string s)
    {
        if (string.IsNullOrEmpty(s)) return;
        int n = s.Length * 2;
        INPUT[] a = new INPUT[n];
        for (int i = 0; i < s.Length; i++)
        {
            int k = i * 2;
            a[k].type = 1;
            a[k].u.ki.wVk = 0;
            a[k].u.ki.wScan = (ushort)s[i];
            a[k].u.ki.dwFlags = 0x0004;
            a[k + 1] = a[k];
            a[k + 1].u.ki.dwFlags = 0x0004 | 0x0002;
        }
        SendInput((uint)n, a, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@
Add-Type -TypeDefinition $win32

# Em telas com escala (125%, 150%) o Windows mentiria as coordenadas para um
# processo sem DPI awareness. Isto faz o agente enxergar os pixels reais.
try { [Win32]::SetProcessDPIAware() | Out-Null } catch { }

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$VK_CONTROL = 17
$VK_V = 86
$MOUSE_LEFT = 2, 4
$MOUSE_RIGHT = 8, 16
$MOUSE_MIDDLE = 32, 64
$MOUSE_WHEEL = 2048
$VK_EXTENDED = 33, 34, 35, 36, 37, 38, 39, 40, 44, 45, 46, 91, 92, 93, 144

# --------------------------- entradas --------------------------------
function Move-Cursor($nx, $ny) {
  $x = [int]($vs.Left + ([double]$nx * $vs.Width))
  $y = [int]($vs.Top + ([double]$ny * $vs.Height))
  if ($DryRun) { Write-Host ("  [teste] mover mouse -> " + $x + "," + $y); return }
  [Win32]::SetCursorPos($x, $y) | Out-Null
}

function Press-Button($button, $down) {
  $nome = "left"
  if ($button -eq 1 -or $button -eq "middle") { $nome = "middle" }
  elseif ($button -eq 2 -or $button -eq "right") { $nome = "right" }

  $flags = 0
  if ($nome -eq "right") { $flags = if ($down) { $MOUSE_RIGHT[0] } else { $MOUSE_RIGHT[1] } }
  elseif ($nome -eq "middle") { $flags = if ($down) { $MOUSE_MIDDLE[0] } else { $MOUSE_MIDDLE[1] } }
  else { $flags = if ($down) { $MOUSE_LEFT[0] } else { $MOUSE_LEFT[1] } }

  if ($DryRun) { Write-Host ("  [teste] botao " + $nome + " " + $(if ($down) { "down" } else { "up" })); return }
  [Win32]::mouse_event([uint32]$flags, 0, 0, 0, [UIntPtr]::Zero)
}

function Turn-Wheel($delta) {
  if ($DryRun) { Write-Host ("  [teste] roda " + $delta); return }
  [Win32]::mouse_event([uint32]$MOUSE_WHEEL, 0, 0, [int]([double]$delta * 120), [UIntPtr]::Zero)
}

function Press-Key($vk, $down) {
  if ($DryRun) { Write-Host ("  [teste] tecla vk=" + $vk + " " + $(if ($down) { "down" } else { "up" })); return }
  $flags = if ($down) { [uint32]0 } else { [uint32]2 }   # KEYEVENTF_KEYUP
  # Setas, Insert/Delete/Home/End/Page, PrintScreen e teclas Windows precisam
  # da flag "extended" para o Windows nao confundir com o teclado numerico.
  if ($VK_EXTENDED -contains [int]$vk) { $flags = $flags -bor 1 }   # KEYEVENTF_EXTENDEDKEY
  [Win32]::keybd_event([byte]$vk, 0, $flags, [UIntPtr]::Zero)
}

function Type-Char($ch) {
  if ($DryRun) { Write-Host ("  [teste] digitar '" + $ch + "'"); return }
  [Win32]::UnicodeText([string]$ch)
}

function Paste-Text($text) {
  if ($DryRun) { Write-Host ("  [teste] colar '" + $text + "'"); return }
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 50
  [Win32]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  [Win32]::keybd_event($VK_V, 0, 0, [UIntPtr]::Zero)
  [Win32]::keybd_event($VK_V, 0, 2, [UIntPtr]::Zero)
  [Win32]::keybd_event($VK_CONTROL, 0, 2, [UIntPtr]::Zero)
}

# --------------------------- websocket -------------------------------
$buffer = New-Object byte[] 65536
$keepAlive = [System.Threading.CancellationToken]::None

# Windows antigo negocia TLS 1.0 por padrao e o servidor recusa
try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 } catch { }

function Connect-Agent($uri) {
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  $socket.ConnectAsync($uri, $keepAlive).GetAwaiter().GetResult() | Out-Null
  return $socket
}

function Send-Json($ws, $obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object "System.ArraySegment[byte]" -ArgumentList (, $bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $keepAlive).GetAwaiter().GetResult() | Out-Null
}

function Receive-Text($ws) {
  $sb = New-Object System.Text.StringBuilder
  do {
    $seg = New-Object "System.ArraySegment[byte]" -ArgumentList (, $buffer)
    $res = $ws.ReceiveAsync($seg, $keepAlive).GetAwaiter().GetResult()
    if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
  } while (-not $res.EndOfMessage)
  return $sb.ToString()
}

# ----------------------------- principal -----------------------------
Write-Host ""
Write-Host "  Suporte remoto - Sala de Tela" -ForegroundColor Cyan
Write-Host "  ------------------------------" -ForegroundColor DarkGray
Write-Host ("  Este computador: " + $env:COMPUTERNAME)
Write-Host ("  Tela: " + $vs.Width + "x" + $vs.Height) -ForegroundColor DarkGray
if ($DryRun) { Write-Host "  MODO TESTE: nao move o mouse nem digita" -ForegroundColor Yellow }
Write-Host ""

if (-not $Codigo) { $Codigo = (Read-Host "  Codigo de acesso").Trim().ToUpper() }
if (-not $Codigo) { Write-Host "  Sem codigo. Saindo." -ForegroundColor Red; exit 1 }

$codigoAtual = $Codigo
$ws = $null
$falhas = 0
$MAX_FALHAS = 12   # ~2 minutos tentando; depois sai para nao ficar em loop eterno

while ($true) {
  $conectou = $false
  $fechadoPeloServidor = $false

  try {
    Write-Host "  Conectando..." -ForegroundColor DarkGray
    $ws = Connect-Agent ([Uri]$Servidor)

    Send-Json $ws @{ type = "hello"; code = $codigoAtual; host = $env:COMPUTERNAME; screen = @{ w = $vs.Width; h = $vs.Height } }

    $first = Receive-Text $ws
    if (-not $first) { throw "conexao encerrada pelo servidor" }
    $hello = $first | ConvertFrom-Json

    if ($hello.type -eq "bye") {
      Write-Host ""
      Write-Host ("  " + $hello.reason) -ForegroundColor Yellow
      Write-Host "  Gere um codigo novo na pagina e rode este arquivo de novo." -ForegroundColor Yellow
      exit 0
    }
    if ($hello.type -ne "ok") { throw "resposta inesperada do servidor" }

    $conectou = $true
    $falhas = 0
    Write-Host ""
    Write-Host "  CONECTADO - o tecnico ja pode controlar este computador." -ForegroundColor Green
    Write-Host "  Deixe esta janela aberta. Feche-a para encerrar na hora." -ForegroundColor DarkGray
    Write-Host ""

    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $raw = Receive-Text $ws
      if (-not $raw) {
        # O servidor mandou um Close (sala encerrada, cliente saiu, etc.).
        # Isso e definitivo: nao adianta reconectar com o mesmo codigo.
        $fechadoPeloServidor = $true
        break
      }

      $msg = $raw | ConvertFrom-Json
      if ($msg.type -ne "input") { continue }

      $d = $msg.data
      switch ($d.t) {
        "m" { Move-Cursor $d.x $d.y }
        "d" { Press-Button $d.b $true }
        "u" { Press-Button $d.b $false }
        "w" { Turn-Wheel $d.dy }
        "k" {
          if ($d.ch) { Type-Char $d.ch }
          elseif ($d.vk) { Press-Key $d.vk $d.down }
        }
        "p" { Paste-Text $d.text }
        "paste" { Paste-Text $d.text }
        default { }
      }
    }
  }
  catch {
    Write-Host ("  Falha: " + $_.Exception.Message) -ForegroundColor DarkYellow
    Write-Host "  Se repetir, verifique a internet e se a data/hora do Windows estao certas." -ForegroundColor DarkGray
    Write-Host ("  Servidor usado: " + $Servidor) -ForegroundColor DarkGray
  }
  finally {
    if ($ws) {
      # Abort fecha o TCP na hora. Dispose sozinho ja deixou conexao pendurada
      # no Apache em testes antigos (cada tentativa consumia uma thread).
      try { $ws.Abort() } catch { }
      try { $ws.Dispose() } catch { }
      $ws = $null
    }
  }

  if ($fechadoPeloServidor) {
    Write-Host ""
    Write-Host "  A sessao foi encerrada pelo servidor." -ForegroundColor Yellow
    Write-Host "  Feche esta janela. Se precisar de novo, gere outro codigo na pagina." -ForegroundColor DarkGray
    exit 0
  }

  if ($conectou) { $falhas = 0 } else { $falhas += 1 }

  if ($falhas -ge $MAX_FALHAS) {
    Write-Host ""
    Write-Host "  Nao foi possivel conectar depois de varias tentativas." -ForegroundColor Red
    Write-Host "  Feche esta janela, gere um codigo novo na pagina e abra o agente de novo." -ForegroundColor Yellow
    exit 1
  }

  $espera = if ($falhas -gt 3) { 15 } else { 5 }
  Write-Host ("  Tentando reconectar em " + $espera + "s (tentativa " + $falhas + "/" + $MAX_FALHAS + ", Ctrl+C para sair)...") -ForegroundColor DarkGray
  Start-Sleep -Seconds $espera
}
