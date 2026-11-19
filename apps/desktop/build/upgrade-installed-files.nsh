!ifndef CODEFLOW_UPGRADE_FILES_INCLUDED
!define CODEFLOW_UPGRADE_FILES_INCLUDED

!ifndef BUILD_UNINSTALLER
Var d16UpgradePath
Var d16UpgradeRelative
Var d16UpgradeHandle
Var d16UpgradeEntry
Var d16UpgradeFailure
Var d16UpgradeMode
Var d16UpgradeRegisteredRoot
Var d16UpgradeUninstallString
Var d16UpgradeExpectedType
Var d16UpgradeFindBuffer

; Known program entities are checked in a read-only pass before any deletion; unknown root entries are untouched.
Function D16UpgradeWalk
  System::Call 'kernel32::GetFileAttributesW(w "$d16UpgradePath") i.r0 ?e'
  Pop $d16InstallNativeError
  ${If} $0 == -1
    ${If} $d16InstallNativeError != 2
    ${AndIf} $d16InstallNativeError != 3
      StrCpy $d16UpgradeFailure PROGRAM_PATH_UNAVAILABLE
    ${EndIf}
    Return
  ${EndIf}
  IntOp $1 $0 & 0x400
  ${If} $1 != 0
    StrCpy $d16UpgradeFailure PROGRAM_PATH_REPARSE
    Return
  ${EndIf}
  IntOp $1 $0 & 0x10
  ${If} $d16UpgradeExpectedType != -1
  ${AndIf} $1 != $d16UpgradeExpectedType
    StrCpy $d16UpgradeFailure PROGRAM_PATH_TYPE_INVALID
    Return
  ${EndIf}
  ${If} $1 == 0
    ${If} $d16UpgradeMode == remove
      ClearErrors
      Delete "$d16UpgradePath"
      ${If} ${Errors}
        StrCpy $d16UpgradeFailure PROGRAM_FILE_REMOVE_FAILED
      ${EndIf}
    ${EndIf}
    Return
  ${EndIf}
  System::Alloc 592
  Pop $d16UpgradeFindBuffer
  ${If} $d16UpgradeFindBuffer == 0
    StrCpy $d16UpgradeFailure PROGRAM_ENUMERATION_ALLOCATION_FAILED
    Return
  ${EndIf}
  System::Call 'kernel32::FindFirstFileW(w "$d16UpgradePath\*", p $d16UpgradeFindBuffer) p.s ?e'
  Pop $d16InstallNativeError
  Pop $d16UpgradeHandle
  ${If} $d16UpgradeHandle == -1
    StrCpy $d16UpgradeFailure PROGRAM_DIRECTORY_READ_FAILED
    System::Free $d16UpgradeFindBuffer
    Return
  ${EndIf}
  upgrade_walk_next:
    IntOp $0 $d16UpgradeFindBuffer + 44
    System::Call 'kernel32::lstrcpynW(w .r1, p r0, i 260) p'
    StrCpy $d16UpgradeEntry $1
    StrCmp $d16UpgradeEntry "." upgrade_walk_continue
    StrCmp $d16UpgradeEntry ".." upgrade_walk_continue
    StrLen $0 $d16UpgradePath
    StrLen $1 $d16UpgradeEntry
    IntOp $0 $0 + $1
    IntOp $0 $0 + 2
    ${If} $0 >= ${NSIS_MAX_STRLEN}
      StrCpy $d16UpgradeFailure PROGRAM_PATH_TOO_LONG
      Goto upgrade_walk_done
    ${EndIf}
    Push $d16UpgradePath
    Push $d16UpgradeHandle
    Push $d16UpgradeEntry
    Push $d16UpgradeExpectedType
    Push $d16UpgradeFindBuffer
    StrCpy $d16UpgradeExpectedType -1
    StrCpy $d16UpgradePath "$d16UpgradePath\$d16UpgradeEntry"
    Call D16UpgradeWalk
    Pop $d16UpgradeFindBuffer
    Pop $d16UpgradeExpectedType
    Pop $d16UpgradeEntry
    Pop $d16UpgradeHandle
    Pop $d16UpgradePath
    StrCmp $d16UpgradeFailure "" 0 upgrade_walk_done
  upgrade_walk_continue:
    System::Call 'kernel32::FindNextFileW(p $d16UpgradeHandle, p $d16UpgradeFindBuffer) i.r0 ?e'
    Pop $d16InstallNativeError
    ${If} $0 == 0
      ${If} $d16InstallNativeError != 18
        StrCpy $d16UpgradeFailure PROGRAM_DIRECTORY_READ_FAILED
      ${EndIf}
      Goto upgrade_walk_done
    ${EndIf}
    Goto upgrade_walk_next
  upgrade_walk_done:
    System::Call 'kernel32::FindClose(p $d16UpgradeHandle) i.r0 ?e'
    Pop $d16InstallNativeError
    ${If} $0 == 0
      StrCpy $d16UpgradeFailure PROGRAM_ENUMERATION_CLOSE_FAILED
    ${EndIf}
    System::Free $d16UpgradeFindBuffer
    ${If} $d16UpgradeMode == remove
    ${AndIf} $d16UpgradeFailure == ""
      ClearErrors
      RMDir "$d16UpgradePath"
      ${If} ${Errors}
        StrCpy $d16UpgradeFailure PROGRAM_DIRECTORY_REMOVE_FAILED
      ${EndIf}
    ${EndIf}
FunctionEnd

; Fixed Electron files and owned program subtrees are the entire deletion authority.
!macro D16UpgradeOwnedFiles
  !insertmacro D16UpgradeDirectory "shells"
  !insertmacro D16UpgradeDirectory "resources"
  !insertmacro D16UpgradeDirectory "locales"
  !insertmacro D16UpgradeEntity "CodeFlowAI.exe"
  !insertmacro D16UpgradeEntity "Uninstall CodeFlowAI.exe"
  !insertmacro D16UpgradeEntity "shell-launch.ini"
  !insertmacro D16UpgradeEntity "shell-switch.ini"
  !insertmacro D16UpgradeEntity "installation-completed.ini"
  !insertmacro D16UpgradeEntity "chrome_100_percent.pak"
  !insertmacro D16UpgradeEntity "chrome_200_percent.pak"
  !insertmacro D16UpgradeEntity "d3dcompiler_47.dll"
  !insertmacro D16UpgradeEntity "dxcompiler.dll"
  !insertmacro D16UpgradeEntity "electron_wer.dll"
  !insertmacro D16UpgradeEntity "ffmpeg.dll"
  !insertmacro D16UpgradeEntity "icudtl.dat"
  !insertmacro D16UpgradeEntity "libEGL.dll"
  !insertmacro D16UpgradeEntity "libGLESv2.dll"
  !insertmacro D16UpgradeEntity "resources.pak"
  !insertmacro D16UpgradeEntity "snapshot_blob.bin"
  !insertmacro D16UpgradeEntity "v8_context_snapshot.bin"
  !insertmacro D16UpgradeEntity "vk_swiftshader.dll"
  !insertmacro D16UpgradeEntity "vk_swiftshader_icd.json"
  !insertmacro D16UpgradeEntity "vulkan-1.dll"
  !insertmacro D16UpgradeEntity "LICENSE"
  !insertmacro D16UpgradeEntity "LICENSES.chromium.html"
  !insertmacro D16UpgradeEntity "version"
  !insertmacro D16UpgradeEntity "uninstallerIcon.ico"
!macroend

; Walk only a fixed child of the canonical installation root, preserving the first precise failure.
!macro D16UpgradeEntity RELATIVE
  ${If} $d16UpgradeFailure == ""
    StrCpy $d16UpgradeExpectedType 0
    StrCpy $d16UpgradeRelative "${RELATIVE}"
    StrCpy $d16UpgradePath "$INSTDIR\${RELATIVE}"
    Call D16UpgradeWalk
  ${EndIf}
!macroend

; Only these owned subtrees grant recursive program cleanup authority.
!macro D16UpgradeDirectory RELATIVE
  ${If} $d16UpgradeFailure == ""
    StrCpy $d16UpgradeExpectedType 16
    StrCpy $d16UpgradeRelative "${RELATIVE}"
    StrCpy $d16UpgradePath "$INSTDIR\${RELATIVE}"
    Call D16UpgradeWalk
  ${EndIf}
!macroend

; Product replacement stops its owned instances, validates every program entity, then removes only the whitelist.
Function D16UpgradeSameRoot
  Call D16NewInstallRequestId
  !insertmacro D16StopInstalledProcesses false
  StrCpy $d16UpgradeFailure ""
  StrCpy $d16UpgradeMode validate
  !insertmacro D16UpgradeOwnedFiles
  ${If} $d16UpgradeFailure == ""
    StrCpy $d16UpgradeMode remove
    !insertmacro D16UpgradeOwnedFiles
  ${EndIf}
  ${If} $d16UpgradeFailure != ""
    StrCpy $d16InstallCause $d16UpgradeFailure
    StrCpy $d16InstallStage program-files-upgrade
    StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROGRAM_REPLACE_FAILED
    StrCpy $d16InstallExitCode "null"
    DetailPrint "CodeFlow program replacement failed: $d16UpgradeRelative"
    Call D16FailInstallation
  ${EndIf}
FunctionEnd

; Replace only a registered installation at this exact root; never invoke its old executable or uninstaller.
!macro D16NativeUninstallOldVersion ROOT_KEY
      ; Keep upstream's function symbol referenced for warnings-as-errors builds; never call its code.
      GetFunctionAddress $R0 uninstallOldVersion
      ClearErrors
      StrCpy $R0 0
      !insertmacro readReg $d16UpgradeRegisteredRoot "${ROOT_KEY}" "${INSTALL_REGISTRY_KEY}" InstallLocation
      !insertmacro readReg $d16UpgradeUninstallString "${ROOT_KEY}" "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $d16UpgradeRegisteredRoot == ""
      ${AndIf} $d16UpgradeUninstallString != ""
        StrCpy $d16InstallCause LEGACY_INSTALL_ROOT_UNKNOWN
        StrCpy $d16InstallStage program-files-upgrade
        StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROGRAM_REPLACE_FAILED
        StrCpy $d16InstallExitCode "null"
        Call D16FailInstallation
      ${EndIf}
      ${If} $d16UpgradeRegisteredRoot != ""
        !if "${ROOT_KEY}" == "HKEY_CURRENT_USER"
          ${If} $installMode == "all"
            StrCpy $d16InstallCause LEGACY_INSTALL_SCOPE_CONFLICT
            StrCpy $d16InstallStage program-files-upgrade
            StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROGRAM_REPLACE_FAILED
            StrCpy $d16InstallExitCode "null"
            Call D16FailInstallation
          ${EndIf}
        !endif
        ${If} $d16UpgradeRegisteredRoot != $INSTDIR
          StrCpy $d16InstallCause LEGACY_INSTALL_ROOT_CONFLICT
          StrCpy $d16InstallStage program-files-upgrade
          StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROGRAM_REPLACE_FAILED
          StrCpy $d16InstallExitCode "null"
          Call D16FailInstallation
        ${EndIf}
        Call D16UpgradeSameRoot
      ${EndIf}
      ClearErrors
      StrCpy $R0 0
!macroend
!endif
!else
; The second include runs after upstream installUtil definitions, before their first expansion in installSection.
  !ifmacrodef uninstallOldVersion
    !macroundef uninstallOldVersion
    !macro uninstallOldVersion ROOT_KEY
      !insertmacro D16NativeUninstallOldVersion "${ROOT_KEY}"
    !macroend
  !endif
!endif
