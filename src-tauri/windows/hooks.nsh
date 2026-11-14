; Command Center installs the desktop app.
; Server install lived here and can be put back from git history.
; This file still sets $CcInstallApp, which the installer template reads.

!include LogicLib.nsh

Var CcInstallApp

Function CcLoadChoices
  StrCpy $CcInstallApp 1
FunctionEnd
