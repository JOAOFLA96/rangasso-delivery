; Instalador do Agente de Impressão Rangasso (Inno Setup 6).
; Compilar no Windows, depois de "npm run package:win":
;   iscc /DAppVersion=1.0.0 /DSourceDir=..\..\dist\RangassoAgent-1.0.0 RangassoAgent.iss
; Gera dist\RangassoAgentSetup-<versão>.exe

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\RangassoAgent-" + AppVersion
#endif

[Setup]
AppId={{6F1B6C3E-2C55-4E7B-9A0E-5B7D1E2A9C41}
AppName=Agente de Impressão Rangasso
AppVersion={#AppVersion}
AppPublisher=Rangasso
DefaultDirName={autopf}\RangassoAgent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=RangassoAgentSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Agente de Impressão Rangasso
CloseApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Run]
; Configura (se informado), registra o serviço e inicia. install.ps1 roda da própria pasta {app}: não copia nada.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -InstallDir ""{app}"" -Quiet {code:SetupArgs}"; \
  StatusMsg: "Registrando o serviço do Windows..."; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\RangassoAgent.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopSvc"
Filename: "{app}\RangassoAgent.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "DelSvc"

[Code]
var
  ConfigPage: TInputQueryWizardPage;

function ConfigExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{commonappdata}\RangassoAgent\config.json'));
end;

procedure InitializeWizard;
begin
  ConfigPage := CreateInputQueryPage(wpWelcome,
    'Conexão com o sistema',
    'Informe o endereço do sistema e a chave do agente.',
    'A chave é gerada no painel em Configurações > Impressora > Gerar chave do agente. ' +
    'A impressora (USB ou rede) é escolhida no painel.');
  ConfigPage.Add('Endereço do sistema (https://...):', False);
  ConfigPage.Add('Chave do agente (rgd_...):', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Atualização: mantém a configuração existente.
  Result := (PageID = ConfigPage.ID) and ConfigExists();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = ConfigPage.ID then
  begin
    if (Pos('https://', Lowercase(Trim(ConfigPage.Values[0]))) <> 1) then
    begin
      MsgBox('O endereço precisa começar com https://', mbError, MB_OK);
      Result := False;
    end
    else if (Pos('rgd_', Trim(ConfigPage.Values[1])) <> 1) then
    begin
      MsgBox('A chave do agente começa com rgd_. Copie do painel.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function SetupArgs(Param: String): String;
begin
  if ConfigExists() then
    Result := ''
  else
    Result := '-ServerUrl "' + Trim(ConfigPage.Values[0]) + '" -Token "' + Trim(ConfigPage.Values[1]) + '"';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  // Atualização: para o serviço antes de substituir os arquivos.
  if FileExists(ExpandConstant('{autopf}\RangassoAgent\RangassoAgent.exe')) then
    Exec(ExpandConstant('{autopf}\RangassoAgent\RangassoAgent.exe'), 'stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
