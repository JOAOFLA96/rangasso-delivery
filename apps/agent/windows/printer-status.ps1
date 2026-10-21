# Lê o estado da impressora informado pelo Windows (Win32_Printer). Depende do driver: com o driver
# Epson APD costuma indicar offline/sem papel; com drivers genéricos pode não informar nada.
# Com -List, lista as impressoras instaladas.
param([string]$PrinterName = "", [switch]$List)
$ErrorActionPreference = "Stop"
try {
  if ($List) {
    @(Get-CimInstance Win32_Printer | ForEach-Object { @{ name = $_.Name; driver = $_.DriverName; port = $_.PortName; default = [bool]$_.Default; workOffline = $_.WorkOffline } }) | ConvertTo-Json -Compress
    exit 0
  }
  $p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
  if (-not $p) { @{ found = $false } | ConvertTo-Json -Compress; exit 0 }
  @{ found = $true; name = $p.Name; driver = $p.DriverName; port = $p.PortName; workOffline = $p.WorkOffline;
     printerStatus = $p.PrinterStatus; detectedErrorState = $p.DetectedErrorState; jobs = @(Get-PrintJob -PrinterName $p.Name -ErrorAction SilentlyContinue).Count } | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ found = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
