# Instala (ou atualiza) o Agente de Impressão Rangasso como serviço do Windows.
# Rode no PowerShell como Administrador, dentro da pasta extraída do pacote:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -ServerUrl https://seu-dominio -Token rgd_...
# Sem parâmetros, pergunta o que faltar. Em atualização, mantém o config.json existente.
param(
  [string]$ServerUrl = "",
  [string]$Token = "",
  [ValidateSet("auto", "windows", "network", "file")][string]$Printer = "",
  [string]$WindowsName = "",
  [string]$PrinterHost = "",
  [string]$InstallDir = "$env:ProgramFiles\RangassoAgent",
  [switch]$NoStart,
  [switch]$Quiet
)
$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Execute este script como Administrador (clique com o botão direito no PowerShell > Executar como administrador)."
  exit 1
}

$src = $PSScriptRoot
$dataDir = Join-Path $env:ProgramData "RangassoAgent"
$config = Join-Path $dataDir "config.json"
$svcExe = Join-Path $InstallDir "RangassoAgent.exe"

# 1. Para o serviço se já existir (atualização)
if (Get-Service -Name RangassoAgent -ErrorAction SilentlyContinue) {
  Write-Host "Parando o serviço atual para atualizar..."
  & $svcExe stop | Out-Null
  Start-Sleep -Seconds 2
}

# 2. Copia os arquivos (se o script não estiver rodando da própria pasta de instalação)
if ((Resolve-Path $src).Path.TrimEnd('\') -ne $InstallDir.TrimEnd('\')) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $src "*") -Destination $InstallDir -Recurse -Force
}
$node = Join-Path $InstallDir "node\node.exe"
$agent = Join-Path $InstallDir "agent.cjs"

# 3. Pasta de dados: só Administradores e o sistema (o config.json guarda a chave do agente)
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
& icacls $dataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# 4. Configuração (sem endereço/chave em modo silencioso: configura depois pelo Monitor de Impressão)
$needSetup = -not (Test-Path $config) -or $ServerUrl -or $Token -or $Printer -or $WindowsName -or $PrinterHost
if ($needSetup -and $Quiet -and -not (Test-Path $config) -and -not $ServerUrl -and -not $Token) {
  Write-Host "Sem configuração ainda. Abra o Monitor de Impressão (http://127.0.0.1:17800) para informar o endereço e a chave."
  $needSetup = $false
}
if ($needSetup) {
  if (-not (Test-Path $config)) {
    if (-not $ServerUrl -and -not $Quiet) { $ServerUrl = Read-Host "Endereço do sistema (ex.: https://pedidos.seudominio.com.br)" }
    if (-not $Token -and -not $Quiet) { $Token = Read-Host "Chave do agente (Painel > Configurações > Impressora > + Credencial de agente)" }
  }
  $setupArgs = @($agent, "setup", "--config", $config)
  if ($ServerUrl) { $setupArgs += @("--server", $ServerUrl) }
  if ($Token) { $setupArgs += @("--token", $Token) }
  if ($Printer) { $setupArgs += @("--printer", $Printer) }
  if ($WindowsName) { $setupArgs += @("--windows-name", $WindowsName) }
  if ($PrinterHost) { $setupArgs += @("--host", $PrinterHost) }
  & $node @setupArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "Configuração inválida. Nada foi instalado como serviço."; exit 2 }
}

# 5. Teste de conexão (não impede a instalação: a internet pode estar fora agora)
if (Test-Path $config) {
  & $node $agent test-connection --config $config
  if ($LASTEXITCODE -ne 0) { Write-Warning "Não foi possível falar com o servidor agora. O serviço continuará tentando sozinho." }
}

# 6. Registra o serviço (início automático, reinício em caso de falha)
if (-not (Get-Service -Name RangassoAgent -ErrorAction SilentlyContinue)) {
  & $svcExe install
  if ($LASTEXITCODE -ne 0) { Write-Error "Falha ao registrar o serviço."; exit 3 }
}
if (-not $NoStart) {
  & $svcExe start
  Start-Sleep -Seconds 3
  & $svcExe status
}

Write-Host ""
Write-Host "Instalado em $InstallDir"
Write-Host "Configuração e logs: $dataDir"
Write-Host "Monitor de Impressão: http://127.0.0.1:17800 (atalho no menu Iniciar)"
Write-Host "Diagnóstico: `"$InstallDir\rangasso-agent.cmd`" status   |   test-print   |   list-printers"
