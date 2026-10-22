# Teste de fumaça do instalador no Windows (usado no CI, em máquina descartável).
# Instala pelo setup.exe, confere o serviço, imprime pelo spooler do Windows numa impressora
# "Generic / Text Only" cuja porta grava num arquivo, mata o processo para ver o reinício automático
# e desinstala. Não substitui o teste com a Epson física.
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = "Stop"
function Check($ok, $msg) { if (-not $ok) { throw "FALHOU: $msg" } else { Write-Host "OK: $msg" } }

$outDir = "C:\rg-out"
$portFile = Join-Path $outDir "comanda.prn"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Impressora de teste: spooler real, saída em arquivo.
Add-PrinterDriver -Name "Generic / Text Only"
Add-PrinterPort -Name $portFile
Add-Printer -Name "Rangasso Teste" -DriverName "Generic / Text Only" -PortName $portFile

# Configuração prévia (servidor inexistente: o agente deve ficar tentando sem cair).
$dataDir = Join-Path $env:ProgramData "RangassoAgent"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
@{
  serverUrl = "http://localhost:3999"; deviceToken = "rgd_ci_smoke_test_token_0000000000"
  printer = @{ mode = "windows"; windowsName = "Rangasso Teste"; host = ""; port = 9100; columns = 48; outputDir = "" }
  logLevel = "debug"
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $dataDir "config.json")

# 1. Instalação silenciosa
$p = Start-Process -FilePath $Setup -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$outDir\setup.log" -Wait -PassThru
Check ($p.ExitCode -eq 0) "instalador terminou com código 0"
$app = Join-Path $env:ProgramFiles "RangassoAgent"
Check (Test-Path (Join-Path $app "agent.cjs")) "arquivos instalados em $app"

# 2. Serviço registrado, automático e rodando
Start-Sleep -Seconds 8
$svc = Get-Service RangassoAgent
Check ($svc.Status -eq "Running") "serviço RangassoAgent rodando (status: $($svc.Status))"
Check ($svc.StartType -eq "Automatic") "serviço com início automático"
$log = Get-ChildItem (Join-Path $dataDir "logs") -Filter "agent-*.log" | Select-Object -First 1
Check ($null -ne $log) "log do agente criado"
$logText = Get-Content $log.FullName -Raw
Check ($logText -match "iniciando") "agente registrou o início no log"
Check ($logText -match "nova tentativa") "sem servidor, o agente fica tentando (backoff) sem cair"

# 2b. Monitor de Impressão (página local) e atalho no menu Iniciar
$st = Invoke-RestMethod -Uri "http://127.0.0.1:17800/api/state" -TimeoutSec 10
Check ($st.configured -eq $true) "Monitor de Impressão responde e vê a configuração"
Check ($null -eq $st.config.deviceToken) "Monitor não expõe a chave do agente"
$page = Invoke-WebRequest -Uri "http://127.0.0.1:17800/" -UseBasicParsing -TimeoutSec 10
Check ($page.Content -match "Monitor de Impress") "página do Monitor carrega"
$lnk = Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Filter "Monitor de Impress*" -ErrorAction SilentlyContinue
Check ($null -ne $lnk) "atalho do Monitor no menu Iniciar"

# 3. Diagnóstico e impressão pelo spooler
$cmd = Join-Path $app "rangasso-agent.cmd"
$list = & $cmd list-printers | Out-String
Write-Host $list
Check ($list -match "Rangasso Teste") "list-printers enxerga a impressora"
$status = & $cmd status | Out-String
Write-Host $status
Check ($status -match "windows") "status mostra o modo windows"
& $cmd test-print
Check ($LASTEXITCODE -eq 0) "test-print pelo spooler retornou sucesso"
Start-Sleep -Seconds 3
Check (Test-Path $portFile) "spooler gravou a comanda na porta de arquivo"
$bytes = [System.IO.File]::ReadAllBytes($portFile)
Check ($bytes.Length -gt 200) "comanda tem $($bytes.Length) bytes"
Check (($bytes[0] -eq 0x1B) -and ($bytes[1] -eq 0x40) -and ($bytes[2] -eq 0x1B) -and ($bytes[3] -eq 0x74) -and ($bytes[4] -eq 3)) "bytes ESC/POS chegaram intactos (ESC @, ESC t 3)"
[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
$cp860 = [System.Text.Encoding]::GetEncoding(860)
Check ($cp860.GetString($bytes) -match "IMPRESSÃO DE TESTE") "acentos em CP860 preservados"

# 4. Reinício automático se o processo morrer
$pidBefore = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "agent.cjs`" run" }).ProcessId
Check ($null -ne $pidBefore) "processo do agente encontrado"
Stop-Process -Id $pidBefore -Force
Start-Sleep -Seconds 20
$pidAfter = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "agent.cjs`" run" }).ProcessId
Check (($null -ne $pidAfter) -and ($pidAfter -ne $pidBefore)) "serviço reiniciou o agente depois de ser derrubado"

# 4b. Atualização automática: servidor falso oferece uma versão nova; o agente baixa, sai com código 3,
# o serviço sobe de novo e o agent.cjs instalado carrega a versão baixada.
$installedVersion = (& $cmd version | Out-String).Trim()
$newVersion = "9.9.9"
$fake = Start-Process -FilePath (Join-Path $app "node\node.exe") -ArgumentList "`"$PSScriptRoot\ci-fake-server.cjs`"", "`"$app\agent.cjs`"", $installedVersion, $newVersion, "3999" -PassThru -RedirectStandardOutput "$outDir\fake-server.log" -RedirectStandardError "$outDir\fake-server.err"
$xmlPath = Join-Path $app "RangassoAgent.xml"
(Get-Content $xmlPath -Raw) -replace "</service>", "  <env name=`"RANGASSO_UPDATE_FIRST_MS`" value=`"5000`"/>`r`n</service>" | Set-Content -Encoding UTF8 $xmlPath
Restart-Service RangassoAgent
$deadline = (Get-Date).AddSeconds(120)
$loaded = $false
while ((Get-Date) -lt $deadline -and -not $loaded) {
  Start-Sleep -Seconds 5
  $all = Get-ChildItem (Join-Path $dataDir "logs") -Filter "agent-*.log" | ForEach-Object { Get-Content -Encoding UTF8 $_.FullName -Raw } | Out-String
  $loaded = $all -match "Agente Rangasso $([regex]::Escape($newVersion)) iniciando"
}
Get-Content "$outDir\fake-server.log" -ErrorAction SilentlyContinue | Select-Object -Last 15 | Write-Host
Get-Content "$outDir\fake-server.err" -ErrorAction SilentlyContinue | Select-Object -Last 15 | Write-Host
Check ($all -match "Atualização $([regex]::Escape($newVersion)) baixada") "agente $installedVersion baixou a atualização $newVersion"
Check $loaded "serviço reiniciou e passou a rodar a versão $newVersion"
Start-Sleep -Seconds 20
$state = Get-Content (Join-Path $dataDir "update\state.json") -Raw | ConvertFrom-Json
Check ($state.healthy -eq $true) "versão $newVersion conectou e ficou confirmada"
Check ((Get-Service RangassoAgent).Status -eq "Running") "serviço rodando depois da atualização"
Stop-Process -Id $fake.Id -Force

# 5. Desinstalação
$unins = Get-ChildItem $app -Filter "unins*.exe" | Select-Object -First 1
$p = Start-Process -FilePath $unins.FullName -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
Start-Sleep -Seconds 5
Check ($null -eq (Get-Service RangassoAgent -ErrorAction SilentlyContinue)) "serviço removido na desinstalação"
Check (Test-Path (Join-Path $dataDir "config.json")) "configuração preservada após desinstalar"
Write-Host "Teste de fumaça do Windows concluído."
