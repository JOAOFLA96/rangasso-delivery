# Envia bytes RAW (ESC/POS) para uma impressora instalada no Windows, pelo spooler (winspool.drv).
# Funciona com a Epson TM-T20 em USB (driver Epson APD ou "Generic / Text Only") e em portas virtuais.
# Saída: uma linha JSON. Código de saída 0 = o spooler aceitou todos os bytes.
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$DocName = "Rangasso"
)
$ErrorActionPreference = "Stop"
$src = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RangassoRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, IntPtr bytes, int count, out int written);

  public static int Send(string printer, byte[] data, string docName) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter: impressora '" + printer + "' nao encontrada");
    try {
      var di = new DOCINFO { pDocName = docName, pDataType = "RAW" };
      int job = StartDocPrinter(h, 1, di);
      if (job == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter");
      try {
        if (!StartPagePrinter(h)) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter");
        IntPtr p = Marshal.AllocCoTaskMem(data.Length);
        try {
          Marshal.Copy(data, 0, p, data.Length);
          int written;
          if (!WritePrinter(h, p, data.Length, out written)) throw new Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter");
          if (written != data.Length) throw new Exception("WritePrinter gravou " + written + " de " + data.Length + " bytes");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
      return job;
    } finally { ClosePrinter(h); }
  }
}
"@
try {
  if (-not ("RangassoRawPrinter" -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $job = [RangassoRawPrinter]::Send($PrinterName, $bytes, $DocName)
  @{ ok = $true; spoolJobId = $job; bytes = $bytes.Length } | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
