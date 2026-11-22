; Command Center installs the desktop app.
; Server install lived here and can be put back from git history.
; This file still sets $CcInstallApp, which the installer template reads.
;
; Base English is staged by scripts/fetch-base-en.mjs into base-en\bundle.nsh
; before this installer is compiled. That fragment copies ggml-base.en.bin and
; whisper-cli into %AppData%\command-center\ai when Base English is not already
; there, and removes an older Tiny English model file.
; Windows makensis only accepts \ in !if /FileExists. A / here makes the
; check miss the staged file even when it sits next to this script.

!include LogicLib.nsh

Var CcInstallApp

Function CcLoadChoices
  StrCpy $CcInstallApp 1
FunctionEnd

!ifdef NSIS_WIN32_MAKENSIS
  !if /FileExists "${__FILEDIR__}\base-en\bundle.nsh"
    !include "${__FILEDIR__}\base-en\bundle.nsh"
  !else
    !error "Base English is not staged for the Windows installer. From the repo root run: node scripts/fetch-base-en.mjs"
  !endif
!else
  !if /FileExists "${__FILEDIR__}/base-en/bundle.nsh"
    !include "${__FILEDIR__}/base-en/bundle.nsh"
  !else
    !error "Base English is not staged for the Windows installer. From the repo root run: node scripts/fetch-base-en.mjs"
  !endif
!endif
