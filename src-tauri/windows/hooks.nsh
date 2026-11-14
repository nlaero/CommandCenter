; Command Center installer pages.
; The server admin created here is for the server and its settings.
; It is not a Command Center board login.

!include nsDialogs.nsh
!include LogicLib.nsh

Var CcInstallApp
Var CcInstallServer
Var CcRole
Var CcSecrets
Var CcPort
Var CcRemoteUrl
Var CcHttp
Var CcStartup
Var CcAdminUser
Var CcAdminPass
Var CcAdminPassAgain
Var CcBundledServer
Var CcDialog
Var CcAppCheck
Var CcServerCheck
Var CcUrlField
Var CcHttpCheck
Var CcRoleDevice
Var CcRoleShared
Var CcSecretsCheck
Var CcPortField
Var CcStartupService
Var CcStartupLogin
Var CcAdminUserField
Var CcAdminPassField
Var CcAdminPassAgainField
Var CcAdminFile

!macro NSIS_HOOK_PREINSTALL
  ExecWait 'taskkill /F /IM auth-server.exe'
  ExecWait 'sc stop CommandCenterAuth'
!macroend

!macro NSIS_HOOK_EXTRAFILES
  StrCpy $CcBundledServer 0
  !if /FileExists "${__FILEDIR__}\..\resources\auth-server.exe"
    File "/oname=auth-server.exe" "${__FILEDIR__}\..\resources\auth-server.exe"
    StrCpy $CcBundledServer 1
  !endif
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode = 1
    ${If} ${FileExists} "$APPDATA\command-center\server\install.json"
      ExecWait '"$INSTDIR\auth-server.exe" --service-start'
      Exec '"$WINDIR\System32\wscript.exe" //B "$APPDATA\command-center\server\start-tray.vbs"'
    ${EndIf}
  ${Else}
    Call CcFinishServer
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\auth-server.exe"
    ExecWait '"$INSTDIR\auth-server.exe" --uninstall --home "$APPDATA\command-center"'
  ${EndIf}
  ExecWait 'sc stop CommandCenterAuth'
  ExecWait 'sc delete CommandCenterAuth'
  ExecWait 'schtasks /Delete /F /TN "Command Center auth-server"'
  ExecWait 'reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Command Center auth-server" /f'
  ExecWait 'taskkill /F /IM auth-server.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\auth-server.exe"
  Delete "$SMPROGRAMS\Command Center server.url"
  RMDir /r "$APPDATA\command-center\server"
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\command-center"
  ${EndIf}
!macroend

Function CcLoadChoices
  StrCpy $CcInstallApp 1
  StrCpy $CcInstallServer 0
  StrCpy $CcRole "device"
  StrCpy $CcSecrets 0
  StrCpy $CcPort "8080"
  StrCpy $CcRemoteUrl ""
  StrCpy $CcHttp 0
  StrCpy $CcStartup "login"
  StrCpy $CcAdminUser ""
  StrCpy $CcAdminPass ""
  StrCpy $CcAdminPassAgain ""
  StrCpy $CcAdminFile ""
  StrCpy $CcBundledServer 0

  ${GetOptions} $CMDLINE "/APP=" $0
  ${IfNot} ${Errors}
    StrCpy $CcInstallApp $0
  ${EndIf}
  ${GetOptions} $CMDLINE "/SERVER=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "0"
      StrCpy $CcInstallServer 0
    ${ElseIf} $0 == "shared"
      StrCpy $CcInstallServer 1
      StrCpy $CcRole "shared"
    ${ElseIf} $0 == "device"
      StrCpy $CcInstallServer 1
      StrCpy $CcRole "device"
    ${Else}
      StrCpy $CcInstallServer 1
    ${EndIf}
  ${EndIf}
  ${GetOptions} $CMDLINE "/SECRETS=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "1"
      StrCpy $CcSecrets 1
    ${EndIf}
  ${EndIf}
  ${GetOptions} $CMDLINE "/PORT=" $0
  ${IfNot} ${Errors}
    StrCpy $CcPort $0
  ${EndIf}
  ${GetOptions} $CMDLINE "/AUTHURL=" $0
  ${IfNot} ${Errors}
    StrCpy $CcRemoteUrl $0
  ${EndIf}
  ${GetOptions} $CMDLINE "/HTTP=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "1"
      StrCpy $CcHttp 1
    ${EndIf}
  ${EndIf}
  ${GetOptions} $CMDLINE "/ADMINFILE=" $0
  ${IfNot} ${Errors}
    StrCpy $CcAdminFile $0
  ${EndIf}
  ${GetOptions} $CMDLINE "/STARTUP=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "service"
      StrCpy $CcStartup "service"
    ${Else}
      StrCpy $CcStartup "login"
    ${EndIf}
  ${EndIf}

  ${If} $CcRole == "shared"
    StrCpy $CcSecrets 0
  ${EndIf}
  ${If} $CcInstallApp <> 1
  ${AndIf} $CcInstallServer <> 1
    StrCpy $CcInstallApp 1
  ${EndIf}
  ${If} $UpdateMode = 1
    StrCpy $CcInstallApp 1
    StrCpy $CcInstallServer 0
    StrCpy $CcRemoteUrl ""
  ${EndIf}
FunctionEnd

Function CcSkipSpecial
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
FunctionEnd

Function CcProductCreate
  Call CcSkipSpecial
  nsDialogs::Create 1018
  Pop $CcDialog
  ${NSD_CreateLabel} 0 0 100% 24u "Install Command Center, the server, or both. At least one is required."
  Pop $0
  ${NSD_CreateCheckbox} 0 28u 100% 12u "Command Center"
  Pop $CcAppCheck
  ${If} $CcInstallApp = 1
    ${NSD_Check} $CcAppCheck
  ${EndIf}
  ${NSD_CreateCheckbox} 0 46u 100% 12u "Auth server"
  Pop $CcServerCheck
  ${If} $CcInstallServer = 1
    ${NSD_Check} $CcServerCheck
  ${EndIf}
  ${NSD_CreateLabel} 0 68u 100% 18u "Server URL, if you install the app without a server on this computer."
  Pop $0
  ${NSD_CreateText} 0 88u 100% 12u "$CcRemoteUrl"
  Pop $CcUrlField
  ${NSD_CreateCheckbox} 0 108u 100% 18u "Also allow HTTP for a .local or .lan name"
  Pop $CcHttpCheck
  ${If} $CcHttp = 1
    ${NSD_Check} $CcHttpCheck
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function CcProductLeave
  ${NSD_GetState} $CcAppCheck $CcInstallApp
  ${NSD_GetState} $CcServerCheck $CcInstallServer
  ${NSD_GetText} $CcUrlField $CcRemoteUrl
  ${NSD_GetState} $CcHttpCheck $CcHttp
  ${If} $CcInstallApp <> 1
  ${AndIf} $CcInstallServer <> 1
    MessageBox MB_ICONEXCLAMATION "Choose Command Center, the server, or both."
    Abort
  ${EndIf}
  ${If} $CcInstallApp = 1
  ${AndIf} $CcInstallServer <> 1
    StrCpy $0 $CcRemoteUrl 8
    StrCpy $1 $CcRemoteUrl 7
    ${If} $0 != "https://"
    ${AndIf} $1 != "http://"
      MessageBox MB_ICONEXCLAMATION "Enter the auth-server URL, starting with http:// or https://."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CcRoleCreate
  Call CcSkipSpecial
  ${If} $CcInstallServer <> 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $CcDialog
  ${NSD_CreateLabel} 0 0 100% 20u "Who is this server for?"
  Pop $0
  ${NSD_CreateRadioButton} 0 24u 100% 12u "This computer only"
  Pop $CcRoleDevice
  ${NSD_CreateRadioButton} 0 40u 100% 24u "A server for other devices"
  Pop $CcRoleShared
  ${If} $CcRole == "shared"
    ${NSD_Check} $CcRoleShared
  ${Else}
    ${NSD_Check} $CcRoleDevice
  ${EndIf}
  ${NSD_CreateCheckbox} 0 70u 100% 20u "Store source passwords and API keys on this server"
  Pop $CcSecretsCheck
  ${If} $CcSecrets = 1
    ${NSD_Check} $CcSecretsCheck
  ${EndIf}
  ${NSD_CreateLabel} 0 96u 100% 12u "Port"
  Pop $0
  ${NSD_CreateText} 0 110u 40% 12u "$CcPort"
  Pop $CcPortField
  nsDialogs::Show
FunctionEnd

Function CcRoleLeave
  ${NSD_GetState} $CcRoleShared $0
  ${If} $0 = 1
    StrCpy $CcRole "shared"
  ${Else}
    StrCpy $CcRole "device"
  ${EndIf}
  ${NSD_GetState} $CcSecretsCheck $CcSecrets
  ${NSD_GetText} $CcPortField $CcPort
  ${If} $CcRole == "shared"
  ${AndIf} $CcSecrets = 1
    StrCpy $CcSecrets 0
    MessageBox MB_ICONINFORMATION "A server for other devices does not store passwords or API keys. Those stay on each computer."
  ${EndIf}
  ${If} $CcPort < 1
  ${OrIf} $CcPort > 65535
    MessageBox MB_ICONEXCLAMATION "Port must be between 1 and 65535."
    Abort
  ${EndIf}
FunctionEnd

Function CcStartupCreate
  Call CcSkipSpecial
  ${If} $CcInstallServer <> 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $CcDialog
  ${NSD_CreateLabel} 0 0 100% 24u "How should the server run?"
  Pop $0
  ${NSD_CreateRadioButton} 0 28u 100% 28u "Windows service. Runs when nobody is signed in. No taskbar icon. Windows will ask for administrator approval."
  Pop $CcStartupService
  ${NSD_CreateRadioButton} 0 62u 100% 28u "Start at login and show an icon in the taskbar."
  Pop $CcStartupLogin
  ${If} $CcStartup == "service"
    ${NSD_Check} $CcStartupService
  ${Else}
    ${NSD_Check} $CcStartupLogin
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function CcStartupLeave
  ${NSD_GetState} $CcStartupService $0
  ${If} $0 = 1
    StrCpy $CcStartup "service"
  ${Else}
    StrCpy $CcStartup "login"
  ${EndIf}
FunctionEnd

Function CcAdminCreate
  Call CcSkipSpecial
  ${If} $CcInstallServer <> 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $CcDialog
  ${NSD_CreateLabel} 0 0 100% 36u "Create the server admin. This account is only for the server and its settings. It is not a Command Center board login."
  Pop $0
  ${NSD_CreateLabel} 0 40u 100% 10u "Server admin username"
  Pop $0
  ${NSD_CreateText} 0 52u 100% 12u "$CcAdminUser"
  Pop $CcAdminUserField
  ${NSD_CreateLabel} 0 70u 100% 10u "Server admin password"
  Pop $0
  ${NSD_CreatePassword} 0 82u 100% 12u ""
  Pop $CcAdminPassField
  ${NSD_CreateLabel} 0 100u 100% 10u "Confirm server admin password"
  Pop $0
  ${NSD_CreatePassword} 0 112u 100% 12u ""
  Pop $CcAdminPassAgainField
  nsDialogs::Show
FunctionEnd

Function CcAdminLeave
  ${NSD_GetText} $CcAdminUserField $CcAdminUser
  ${NSD_GetText} $CcAdminPassField $CcAdminPass
  ${NSD_GetText} $CcAdminPassAgainField $CcAdminPassAgain
  ${If} $CcAdminUser == ""
    MessageBox MB_ICONEXCLAMATION "Enter a username for the server admin. This is not a Command Center board login."
    Abort
  ${EndIf}
  StrLen $0 $CcAdminPass
  ${If} $0 < 8
    MessageBox MB_ICONEXCLAMATION "The server admin password needs at least 8 characters."
    Abort
  ${EndIf}
  ${If} $CcAdminPass != $CcAdminPassAgain
    MessageBox MB_ICONEXCLAMATION "The server admin passwords do not match."
    Abort
  ${EndIf}
FunctionEnd

Function CcFinishServer
  ${If} $CcInstallServer = 1
    ${If} $CcBundledServer <> 1
      MessageBox MB_ICONSTOP "This setup was built without the auth-server program, so the server cannot be installed."
      Abort
    ${EndIf}
    StrCpy $CcAdminPassAgain ""
    ${If} $CcAdminFile != ""
      StrCpy $R1 "$CcAdminFile"
    ${Else}
      ClearErrors
      FileOpen $R9 "$TEMP\cc-server-admin.txt" w
      IfErrors cc_admin_write_failed
      FileWrite $R9 "$CcAdminUser$\r$\n$CcAdminPass"
      FileClose $R9
      StrCpy $R1 "$TEMP\cc-server-admin.txt"
    ${EndIf}
    StrCpy $R1 '"$INSTDIR\auth-server.exe" --install --home "$APPDATA\command-center" --role $CcRole --port $CcPort --startup $CcStartup --admin-file "$R1" --autostart'
    ${If} $CcSecrets = 1
    ${AndIf} $CcRole == "device"
      StrCpy $R1 '$R1 --secret-store'
    ${EndIf}
    ExecWait $R1 $R2
    FileOpen $R9 "$TEMP\cc-server-admin.txt" w
    FileWrite $R9 ""
    FileClose $R9
    Delete "$TEMP\cc-server-admin.txt"
    StrCpy $CcAdminPass ""
    ${If} $R2 <> 0
      MessageBox MB_ICONSTOP "The server did not finish installing. Check that Windows approved the service if you chose that, then run setup again."
      Abort
    ${EndIf}
    CreateDirectory "$SMPROGRAMS"
    FileOpen $R9 "$SMPROGRAMS\Command Center server.url" w
    FileWrite $R9 "[InternetShortcut]$\r$\nURL=http://127.0.0.1:$CcPort/admin$\r$\n"
    FileClose $R9
    ${If} $CcStartup == "login"
      Exec '"$WINDIR\System32\wscript.exe" //B "$APPDATA\command-center\server\start-tray.vbs"'
    ${EndIf}
  ${EndIf}

  ${If} $CcInstallApp = 1
    ${If} $CcInstallServer = 1
    ${OrIf} $CcRemoteUrl != ""
      CreateDirectory "$APPDATA\command-center"
      FileOpen $R9 "$APPDATA\command-center\server-setup.json" w
      ${If} $CcInstallServer = 1
        FileWrite $R9 '{"pending":true,"installServer":false,"remoteUrl":"http://127.0.0.1:$CcPort","allowInsecureHttp":true}'
      ${Else}
        ${If} $CcHttp = 1
          StrCpy $R8 "true"
        ${Else}
          StrCpy $R8 "false"
        ${EndIf}
        FileWrite $R9 '{"pending":true,"installServer":false,"remoteUrl":"$CcRemoteUrl","allowInsecureHttp":$R8}'
      ${EndIf}
      FileClose $R9
    ${EndIf}
  ${EndIf}
  Return
  cc_admin_write_failed:
    MessageBox MB_ICONSTOP "Could not save the server admin for setup."
    Abort
FunctionEnd
