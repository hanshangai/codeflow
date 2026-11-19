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
Var d16UpgradeBase
Var d16UpgradeTarget
Var d16UpgradeTargetBase
Var d16UpgradeRoot
Var d16UpgradePrepared
Var d16UpgradeBackup
Var d16UpgradeRestore
Var d16UpgradeState
Var d16UpgradeSnapshotRequest
Var d16UpgradeSavedCause
Var d16UpgradeRecognized

; Validate, copy or remove only owned paths; reject reparse points in every traversal.
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
    ${If} $d16UpgradeMode == snapshot
    ${OrIf} $d16UpgradeMode == install
    ${OrIf} $d16UpgradeMode == restore
    System::Call 'kernel32::CopyFileW(w "$d16UpgradePath", w "$d16UpgradeTarget", i 1) i.r0 ?e'
      Pop $d16InstallNativeError
      ${If} $0 == 0
        StrCpy $d16UpgradeFailure PROGRAM_FILE_COPY_FAILED
      ${EndIf}
    ${EndIf}
    ${If} $d16UpgradeMode == remove
      ClearErrors
      Delete "$d16UpgradePath"
      ${If} ${Errors}
        StrCpy $d16UpgradeFailure PROGRAM_FILE_REMOVE_FAILED
      ${EndIf}
    ${EndIf}
    Return
  ${EndIf}
  ${If} $d16UpgradeMode == snapshot
  ${OrIf} $d16UpgradeMode == install
  ${OrIf} $d16UpgradeMode == restore
    ClearErrors
    CreateDirectory "$d16UpgradeTarget"
    ${If} ${Errors}
      StrCpy $d16UpgradeFailure PROGRAM_DIRECTORY_CREATE_FAILED
      Return
    ${EndIf}
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
    ${If} $d16UpgradeMode == validate
    ${AndIf} $d16UpgradePath == $d16UpgradeBackup
      Call D16RecognizeSnapshotEntry
      StrCmp $d16UpgradeFailure "" 0 upgrade_walk_done
    ${EndIf}
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
    Push $d16UpgradeTarget
    StrCpy $d16UpgradeExpectedType -1
    StrCpy $d16UpgradePath "$d16UpgradePath\$d16UpgradeEntry"
    StrCpy $d16UpgradeTarget "$d16UpgradeTarget\$d16UpgradeEntry"
    Call D16UpgradeWalk
    Pop $d16UpgradeTarget
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

; Keep the root uninstaller usable until the final atomic replacement.
!macro D16UpgradeOwnedFiles
  !insertmacro D16UpgradeDirectory "shells"
  !insertmacro D16UpgradeDirectory "resources"
  !insertmacro D16UpgradeDirectory "locales"
  !insertmacro D16UpgradeEntity "CodeFlowAI.exe"
  ${If} $d16UpgradeMode != remove
  ${OrIf} $d16UpgradeBase != $d16UpgradeRoot
  ${AndIf} $d16UpgradeMode != install
  ${AndIf} $d16UpgradeMode != restore
    !insertmacro D16UpgradeEntity "Uninstall CodeFlowAI.exe"
  ${EndIf}
  ${If} $d16UpgradeMode == validate
  ${OrIf} $d16UpgradeMode == remove
    !insertmacro D16UpgradeEntity ".codeflow-install-uninstaller.exe"
  ${EndIf}
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
  ${If} $d16UpgradeMode == recognize
    ${If} $d16UpgradeEntry == "${RELATIVE}"
      StrCpy $d16UpgradeRecognized 1
    ${EndIf}
  ${ElseIf} $d16UpgradeFailure == ""
    StrCpy $d16UpgradeExpectedType 0
    StrCpy $d16UpgradeRelative "${RELATIVE}"
    StrCpy $d16UpgradePath "$d16UpgradeBase\${RELATIVE}"
    StrCpy $d16UpgradeTarget "$d16UpgradeTargetBase\${RELATIVE}"
    Call D16UpgradeWalk
  ${EndIf}
!macroend

; Only these owned subtrees grant recursive program cleanup authority.
!macro D16UpgradeDirectory RELATIVE
  ${If} $d16UpgradeMode == recognize
    ${If} $d16UpgradeEntry == "${RELATIVE}"
      StrCpy $d16UpgradeRecognized 1
    ${EndIf}
  ${ElseIf} $d16UpgradeFailure == ""
    StrCpy $d16UpgradeExpectedType 16
    StrCpy $d16UpgradeRelative "${RELATIVE}"
    StrCpy $d16UpgradePath "$d16UpgradeBase\${RELATIVE}"
    StrCpy $d16UpgradeTarget "$d16UpgradeTargetBase\${RELATIVE}"
    Call D16UpgradeWalk
  ${EndIf}
!macroend

; Snapshot cleanup must reject unknown root entries before deleting any recognized entity.
Function D16RecognizeSnapshotEntry
  StrCpy $d16UpgradeMode recognize
  StrCpy $d16UpgradeRecognized 0
  !insertmacro D16UpgradeOwnedFiles
  ${If} $d16UpgradeEntry == transaction.ini
  ${OrIf} $d16UpgradeEntry == transaction.tmp
    StrCpy $d16UpgradeRecognized 1
  ${EndIf}
  ${If} $d16UpgradeRecognized != 1
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_CONTENT_CONFLICT
  ${EndIf}
  StrCpy $d16UpgradeMode validate
FunctionEnd

; Preflight must not remove any old files before a complete new payload exists.
Function D16UpgradeSameRoot
  Call D16NewInstallRequestId
  !insertmacro D16StopInstalledProcesses false
  StrCpy $d16UpgradeFailure ""
  StrCpy $d16UpgradeMode validate
  StrCpy $d16UpgradeBase $INSTDIR
  !insertmacro D16UpgradeOwnedFiles
  ${If} $d16UpgradeFailure != ""
    StrCpy $d16InstallCause $d16UpgradeFailure
    StrCpy $d16InstallStage program-files-upgrade
    StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROGRAM_REPLACE_FAILED
    StrCpy $d16InstallExitCode "null"
    DetailPrint "CodeFlow program replacement failed: $d16UpgradeRelative"
    Call D16FailInstallation
  ${EndIf}
FunctionEnd

; Fail explicitly with the original root restored as the diagnostic entity.
Function D16FailProgramReplacement
  StrCpy $INSTDIR $d16UpgradeRoot
  StrCpy $d16InstallCause $d16UpgradeFailure
  StrCpy $d16InstallStage program-files-upgrade
  StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROGRAM_REPLACE_FAILED
  StrCpy $d16InstallExitCode "null"
  Call D16FailInstallation
FunctionEnd

; Atomically persist snapshot intent/completion before any original program mutation.
Function D16WriteUpgradeState
  StrCpy $d16UpgradeMode remove
  StrCpy $d16UpgradeExpectedType 0
  StrCpy $d16UpgradePath "$d16UpgradeBackup\transaction.tmp"
  Call D16UpgradeWalk
  StrCmp $d16UpgradeFailure "" 0 upgrade_state_done
  System::Call 'kernel32::CreateFileW(w "$d16UpgradeBackup\transaction.tmp", i 0x40000000, i 0, p 0, i 1, i 0x00200080, p 0) p.s ?e'
  Pop $d16InstallNativeError
  Pop $d16UpgradeHandle
  IntCmp $d16UpgradeHandle -1 upgrade_state_failed
  ClearErrors
  FileWrite $d16UpgradeHandle '[upgrade]$\r$\nschema=1$\r$\nstate=$d16UpgradeState$\r$\nrequestId=$d16InstallRequestId$\r$\n'
  IfErrors upgrade_state_close_failed
  System::Call 'kernel32::FlushFileBuffers(p $d16UpgradeHandle) i.r0 ?e'
  Pop $d16InstallNativeError
  IntCmp $0 0 upgrade_state_close_failed
  System::Call 'kernel32::CloseHandle(p $d16UpgradeHandle) i.r0 ?e'
  Pop $d16InstallNativeError
  IntCmp $0 0 upgrade_state_failed
  System::Call 'kernel32::MoveFileExW(w "$d16UpgradeBackup\transaction.tmp", w "$d16UpgradeBackup\transaction.ini", i 9) i.r0 ?e'
  Pop $d16InstallNativeError
  IntCmp $0 0 upgrade_state_failed upgrade_state_done upgrade_state_done
  upgrade_state_close_failed:
    System::Call 'kernel32::CloseHandle(p $d16UpgradeHandle) i.r0'
  upgrade_state_failed:
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_STATE_WRITE_FAILED
  upgrade_state_done:
FunctionEnd

; Remove only recognized snapshot files; unexpected contents remain an explicit conflict.
Function D16RemoveUpgradeBackup
  StrCpy $d16UpgradeBase $d16UpgradeBackup
  StrCpy $d16UpgradeMode remove
  !insertmacro D16UpgradeOwnedFiles
  StrCmp $d16UpgradeFailure "" 0 upgrade_backup_remove_done
  StrCpy $d16UpgradeExpectedType 0
  StrCpy $d16UpgradePath "$d16UpgradeBackup\transaction.ini"
  Call D16UpgradeWalk
  StrCmp $d16UpgradeFailure "" 0 upgrade_backup_remove_done
  StrCpy $d16UpgradePath "$d16UpgradeBackup\transaction.tmp"
  Call D16UpgradeWalk
  StrCmp $d16UpgradeFailure "" 0 upgrade_backup_remove_done
  ClearErrors
  RMDir "$d16UpgradeBackup"
  ${If} ${Errors}
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_REMOVE_FAILED
  ${EndIf}
  upgrade_backup_remove_done:
FunctionEnd

; Restore the complete durable snapshot; retain it on any failure for the next retry.
Function D16RestoreUpgrade
  StrCmp $d16UpgradeRestore 1 0 upgrade_restore_done
  StrCpy $d16UpgradeFailure ""
  StrCpy $d16UpgradeBase $d16UpgradeRoot
  StrCpy $d16UpgradeMode validate
  !insertmacro D16UpgradeOwnedFiles
  StrCmp $d16UpgradeFailure "" 0 upgrade_restore_done
  StrCpy $d16UpgradeMode remove
  !insertmacro D16UpgradeOwnedFiles
  StrCmp $d16UpgradeFailure "" 0 upgrade_restore_done
  StrCpy $d16UpgradeBase $d16UpgradeBackup
  StrCpy $d16UpgradeTargetBase $d16UpgradeRoot
  StrCpy $d16UpgradeMode restore
  !insertmacro D16UpgradeOwnedFiles
  ${If} $d16UpgradeFailure == ""
    StrCpy $d16UpgradeRestore 0
  ${EndIf}
  upgrade_restore_done:
FunctionEnd

; A previous interrupted attempt restores first; a committed/preparing snapshot only needs cleanup.
Function D16RecoverUpgrade
  StrCpy $d16UpgradeMode validate
  StrCpy $d16UpgradeExpectedType 16
  StrCpy $d16UpgradePath $d16UpgradeBackup
  Call D16UpgradeWalk
  StrCmp $d16UpgradeFailure "" 0 upgrade_recover_done
  IfFileExists "$d16UpgradeBackup\*.*" 0 upgrade_recover_done
  ${IfNot} ${FileExists} "$d16UpgradeBackup\transaction.ini"
    ; An interruption between directory creation and the first marker may leave only an empty directory.
    ClearErrors
    RMDir "$d16UpgradeBackup"
    ${If} ${Errors}
      StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_STATE_INVALID
    ${EndIf}
    Return
  ${EndIf}
  ClearErrors
  ReadINIStr $0 "$d16UpgradeBackup\transaction.ini" upgrade schema
  ${If} ${Errors}
  ${OrIf} $0 != 1
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_STATE_INVALID
    Return
  ${EndIf}
  ReadINIStr $d16UpgradeState "$d16UpgradeBackup\transaction.ini" upgrade state
  ReadINIStr $d16UpgradeSnapshotRequest "$d16UpgradeBackup\transaction.ini" upgrade requestId
  ${If} $d16UpgradeSnapshotRequest == ""
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_STATE_INVALID
    Return
  ${EndIf}
  ${If} $d16UpgradeState == ready
    ReadINIStr $0 "$d16UpgradeRoot\installation-completed.ini" installation requestId
    ${If} $0 != $d16UpgradeSnapshotRequest
      StrCpy $d16UpgradeRestore 1
      Call D16RestoreUpgrade
    ${EndIf}
  ${ElseIf} $d16UpgradeState != preparing
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_STATE_INVALID
  ${EndIf}
  ${If} $d16UpgradeFailure == ""
    Call D16RemoveUpgradeBackup
  ${EndIf}
  upgrade_recover_done:
FunctionEnd

; Prepare an independent destination before extraction; never point package extraction at the live root.
Function D16PrepareProgramReplacement
  StrCpy $d16UpgradeRoot $INSTDIR
  StrCpy $d16UpgradeBackup "$INSTDIR\.codeflow-install-previous"
  StrCpy $d16UpgradePrepared "$PLUGINSDIR\codeflow-install-new"
  StrCpy $d16UpgradeRestore 0
  StrCpy $d16UpgradeFailure ""
  Call D16RecoverUpgrade
  ${If} $d16UpgradeFailure != ""
    Call D16FailProgramReplacement
  ${EndIf}
  ClearErrors
  CreateDirectory "$d16UpgradePrepared"
  SetOutPath "$d16UpgradePrepared"
  ${If} ${Errors}
    StrCpy $d16UpgradeFailure PROGRAM_PREPARATION_CREATE_FAILED
    Call D16FailProgramReplacement
  ${EndIf}
FunctionEnd

; Snapshot all owned old files before cleanup, then copy only a validated complete new payload.
Function D16CommitPreparedProgram
  StrCpy $INSTDIR $d16UpgradeRoot
  StrCpy $d16UpgradeBase $d16UpgradePrepared
  StrCpy $d16UpgradeMode validate
  !insertmacro D16UpgradeOwnedFiles
  ${IfNot} ${FileExists} "$d16UpgradePrepared\CodeFlowAI.exe"
  ${OrIfNot} ${FileExists} "$d16UpgradePrepared\Uninstall CodeFlowAI.exe"
    StrCpy $d16UpgradeFailure PROGRAM_PREPARATION_INCOMPLETE
  ${EndIf}
  StrCmp $d16UpgradeFailure "" 0 upgrade_commit_failed
  ; Recheck the live root after extraction and before gaining any cleanup authority.
  Call D16UpgradeSameRoot
  ClearErrors
  CreateDirectory "$d16UpgradeBackup"
  IfErrors upgrade_snapshot_create_failed
  StrCpy $d16UpgradeState preparing
  Call D16WriteUpgradeState
  StrCmp $d16UpgradeFailure "" 0 upgrade_commit_failed
  StrCpy $d16UpgradeBase $d16UpgradeRoot
  StrCpy $d16UpgradeTargetBase $d16UpgradeBackup
  StrCpy $d16UpgradeMode snapshot
  !insertmacro D16UpgradeOwnedFiles
  StrCmp $d16UpgradeFailure "" 0 upgrade_commit_failed
  StrCpy $d16UpgradeState ready
  Call D16WriteUpgradeState
  StrCmp $d16UpgradeFailure "" 0 upgrade_commit_failed
  StrCpy $d16UpgradeRestore 1
  StrCpy $d16UpgradeMode remove
  !insertmacro D16UpgradeOwnedFiles
  StrCmp $d16UpgradeFailure "" 0 upgrade_commit_failed
  StrCpy $d16UpgradeBase $d16UpgradePrepared
  StrCpy $d16UpgradeTargetBase $d16UpgradeRoot
  StrCpy $d16UpgradeMode install
  !insertmacro D16UpgradeOwnedFiles
  StrCmp $d16UpgradeFailure "" 0 upgrade_commit_failed
  SetOutPath "$INSTDIR"
  Return
  upgrade_snapshot_create_failed:
    StrCpy $d16UpgradeFailure PROGRAM_SNAPSHOT_CREATE_FAILED
  upgrade_commit_failed:
    Call D16FailProgramReplacement
FunctionEnd

; Replace the independent root uninstaller last, using a same-volume atomic rename.
Function D16FinishProgramReplacement
  StrCmp $d16UpgradePrepared "" upgrade_finish_done
  System::Call 'kernel32::CopyFileW(w "$d16UpgradePrepared\Uninstall CodeFlowAI.exe", w "$d16UpgradeRoot\.codeflow-install-uninstaller.exe", i 1) i.r0 ?e'
  Pop $d16InstallNativeError
  IntCmp $0 0 upgrade_finish_failed
  System::Call 'kernel32::MoveFileExW(w "$d16UpgradeRoot\.codeflow-install-uninstaller.exe", w "$d16UpgradeRoot\Uninstall CodeFlowAI.exe", i 9) i.r0 ?e'
  Pop $d16InstallNativeError
  IntCmp $0 0 upgrade_finish_failed
  StrCpy $d16UpgradeRestore 0
  Goto upgrade_finish_done
  upgrade_finish_failed:
    StrCpy $d16UpgradeFailure PROGRAM_UNINSTALLER_COMMIT_FAILED
    Call D16FailProgramReplacement
  upgrade_finish_done:
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
  !ifmacrodef installApplicationFiles
    !macroundef installApplicationFiles
    ; Prepare bundled files independently; web installers are outside this product's supported target.
    !macro installApplicationFiles
      Call D16PrepareProgramReplacement
      StrCpy $INSTDIR $d16UpgradePrepared
      ClearErrors
      !ifdef APP_BUILD_DIR
        File /r "${APP_BUILD_DIR}\*.*"
      !else
        !ifdef APP_PACKAGE_URL
          !error "CodeFlow transactional installation requires a bundled application payload"
        !else
          !insertmacro extractEmbeddedAppPackage
        !endif
      !endif
      File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
      ${If} ${Errors}
        StrCpy $d16UpgradeFailure PROGRAM_PREPARATION_COPY_FAILED
        Call D16FailProgramReplacement
      ${EndIf}
      Call D16CommitPreparedProgram
    !macroend
  !endif
  !ifmacrodef extractUsing7za
    !macroundef extractUsing7za
    ; Extract only into the independent prepared directory; never use upstream's ignore-error overwrite fallback.
    !macro extractUsing7za FILE
      ClearErrors
      Nsis7z::Extract "${FILE}"
      ${If} ${Errors}
        StrCpy $d16UpgradeFailure PROGRAM_PREPARATION_EXTRACT_FAILED
        Call D16FailProgramReplacement
      ${EndIf}
    !macroend
  !endif
  !ifmacrodef uninstallOldVersion
    !macroundef uninstallOldVersion
    !macro uninstallOldVersion ROOT_KEY
      !insertmacro D16NativeUninstallOldVersion "${ROOT_KEY}"
    !macroend
  !endif
!endif
