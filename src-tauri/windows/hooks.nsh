; Command Center installs the desktop app.
; Server install lived here and can be put back from git history.
; This file still sets $CcInstallApp, which the installer template reads.
;
; Tiny English is staged by scripts/fetch-tiny-en.mjs into tiny-en\bundle.nsh
; before this installer is compiled. That fragment copies ggml-tiny.en.bin and
; whisper-cli into %AppData%\command-center\ai when it is not already there.

!include LogicLib.nsh

Var CcInstallApp

Function CcLoadChoices
  StrCpy $CcInstallApp 1
FunctionEnd

!if /FileExists "${__FILEDIR__}/tiny-en/bundle.nsh"
  !include "${__FILEDIR__}/tiny-en/bundle.nsh"
!else
  !error "Tiny English is not staged for the Windows installer. From the repo root run: node scripts/fetch-tiny-en.mjs"
!endif
