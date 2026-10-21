# Remove o serviço do Agente Rangasso. Com -RemoveData apaga também config, fila local e logs.
param([string]$InstallDir = "$env:ProgramFiles\RangassoAgent", [switch]$RemoveData, [switch]$KeepFiles)
$ErrorActionPreference = "Stop"
$svcExe = Join-Path $InstallDir "RangassoAgent.exe"
if (Get-Service -Name RangassoAgent -ErrorAction SilentlyContinue) {
  & $svcExe stop | Out-Null
  Start-Sleep -Seconds 2
  & $svcExe uninstall
}
if (-not $KeepFiles -and (Test-Path $InstallDir)) {
  # o próprio script pode estar nessa pasta: remove o resto e agenda a pasta
  Get-ChildItem $InstallDir | Where-Object { $_.FullName -ne $PSCommandPath } | Remove-Item -Recurse -Force
}
if ($RemoveData) { Remove-Item -Recurse -Force (Join-Path $env:ProgramData "RangassoAgent") -ErrorAction SilentlyContinue }
Write-Host "Agente Rangasso removido.$(if (-not $RemoveData) { ' Configuração mantida em ' + (Join-Path $env:ProgramData 'RangassoAgent') + ' (use -RemoveData para apagar).' })"
