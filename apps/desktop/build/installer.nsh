; D16 NSIS hooks. The parent electron-builder template owns file removal and page order.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!ifndef CODEFLOW_STOP_INSTALLED_INCLUDE
  !define CODEFLOW_STOP_INSTALLED_INCLUDE "${__FILEDIR__}\stop-installed-processes.nsh"
!endif
!include "${CODEFLOW_STOP_INSTALLED_INCLUDE}"

; Native ownership checks and held process handles are independent of Electron, Client and PowerShell.
!macro D16StopInstalledProcesses UNINSTALL
  !if "${UNINSTALL}" == "true"
    StrCpy $d16StopRequest $d16RequestId
    Call un.D16StopNativeProcesses
  !else
    ${If} $d16InstallRequestId == ""
      Call D16NewInstallRequestId
    ${EndIf}
    StrCpy $d16StopRequest $d16InstallRequestId
    Call D16StopNativeProcesses
  !endif
  DetailPrint "CodeFlow process stop diagnostic: $R8"
  ${If} $d16StopFailure != ""
    !if "${UNINSTALL}" == "true"
      StrCpy $d16FailureCode DESKTOP_INSTALL_PROCESS_STOP_FAILED
      StrCpy $d16FailureDetails '"stage":"installation-process-stop","rootCause":"$d16StopFailure","processId":$d16StopPid,"win32Error":$d16StopError'
      Call un.D16FailUninstall
    !else
      StrCpy $d16InstallExitCode "null"
      StrCpy $d16InstallCause $d16StopFailure
      StrCpy $d16InstallStage "installation-process-stop"
      StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROCESS_STOP_FAILED
      Call D16FailInstallation
    !endif
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ${If} ${isUpdated}
      Call un.D16NewRequestId
      !insertmacro D16StopInstalledProcesses true
    ${EndIf}
  !else
    !include "${CODEFLOW_UPGRADE_INSTALLED_INCLUDE}"
    ${If} ${FileExists} "$INSTDIR\*.*"
      Call D16NewInstallRequestId
      !insertmacro D16StopInstalledProcesses false
    ${EndIf}
  !endif
!macroend


!ifdef BUILD_UNINSTALLER
  Var d16RequestId
  Var d16Parameters
  Var d16FailureLog
  Var d16FailureCode
  Var d16FailureDetails

; Persist bounded failure context before exiting; never create a maintenance result.
Function un.D16FailUninstall
    ClearErrors
    GetTempFileName $d16FailureLog
    IfErrors choice_diagnostic_failed
    FileOpen $3 "$d16FailureLog" w
    IfErrors choice_diagnostic_failed
    FileWrite $3 '{"errorCode":"$d16FailureCode","requestId":"$d16RequestId","appId":"ai.codeflow.codeflowai",$d16FailureDetails}$\r$\n'
    IfErrors choice_diagnostic_close_failed
    System::Call 'kernel32::FlushFileBuffers(p r3) i.r2'
    ${If} $2 == 0
      Goto choice_diagnostic_close_failed
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r3) i.r2'
    ${If} $2 == 0
      Goto choice_diagnostic_failed
    ${EndIf}
    SetErrorLevel 1
    MessageBox MB_ICONSTOP|MB_OK "CodeFlow 卸载已中止，请保留日志并重新打开卸载程序（$d16RequestId）。日志：$d16FailureLog" /SD IDOK
    Quit
    choice_diagnostic_close_failed:
      System::Call 'kernel32::CloseHandle(p r3) i.r2'
    choice_diagnostic_failed:
    DetailPrint '{"errorCode":"DESKTOP_UNINSTALL_DIAGNOSTIC_FAILED","requestId":"$d16RequestId","appId":"ai.codeflow.codeflowai","failureCode":"$d16FailureCode",$d16FailureDetails}'
    SetErrorLevel 2
    MessageBox MB_ICONSTOP|MB_OK "CodeFlow 卸载已中止，且诊断日志保存失败（$d16RequestId，$d16FailureCode）。" /SD IDOK
    Quit
FunctionEnd

!endif

; Generate a short request id without reading or writing a result file.
!ifdef BUILD_UNINSTALLER
Function un.D16NewRequestId
  System::Call 'kernel32::GetTickCount() i.r0'
  System::Call 'kernel32::GetCurrentProcessId() i.r2'
  StrCpy $d16RequestId "nsis-$2-$0"
FunctionEnd
!endif

; Use the template's upgrade predicate and actual silent state before any file removal.
!ifdef BUILD_UNINSTALLER
!macro customUnInit
  ${GetParameters} $d16Parameters
  ClearErrors
  ${GetOptions} $d16Parameters "--delete-app-data" $0
  ${IfNot} ${Errors}
    Call un.D16NewRequestId
    StrCpy $d16FailureCode DESKTOP_UNINSTALL_INVOCATION_REJECTED
    StrCpy $d16FailureDetails '"stage":"uninstall-init","rootCause":"DELETE_APP_DATA_UNSUPPORTED"'
    Call un.D16FailUninstall
  ${EndIf}
  ${If} ${isUpdated}
    !insertmacro customCheckAppRunning
    Return
  ${EndIf}
!macroend

; Program removal preserves all user data; destructive data maintenance is a separate action.
!macro customUnWelcomePage
  UninstPage custom un.D16UninstallWelcomePage
  ; Explain the exact retention boundary; upgrades skip this page.
  Function un.D16UninstallWelcomePage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Call un.D16NewRequestId
      StrCpy $d16FailureCode DESKTOP_UNINSTALL_PAGE_FAILED
      StrCpy $d16FailureDetails '"stage":"uninstall-page","rootCause":"DIALOG_CREATE_FAILED"'
      Call un.D16FailUninstall
    ${EndIf}
    ${NSD_CreateLabel} 0 0u 100% 36u "仅卸载程序，账号、设备身份、配置和业务任务原样保留。"
    Pop $0
    ${NSD_CreateLabel} 0 48u 100% 36u "项目和工作区 .codeflow 始终保留。若需清理数据，请先在应用内显式操作并确认清理结果。"
    Pop $0
    nsDialogs::Show
  FunctionEnd
!macroend

!else
Var d16InstallLog
Var d16InstallRequestId
Var d16InstallCause
Var d16InstallExitCode
Var d16InstallStage
Var d16InstallErrorCode
Var d16InstallNativeError
Var d16InstallMarkerHandle
Var d16InstallMarkerTemporary

!ifndef CODEFLOW_UPGRADE_INSTALLED_INCLUDE
  !define CODEFLOW_UPGRADE_INSTALLED_INCLUDE "${__FILEDIR__}\upgrade-installed-files.nsh"
!endif
!include "${CODEFLOW_UPGRADE_INSTALLED_INCLUDE}"

Function D16NewInstallRequestId
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  System::Call 'kernel32::GetTickCount() i.r2'
  StrCpy $d16InstallRequestId "nsis-install-$0-$2"
FunctionEnd

; Persist only bounded NSIS diagnostics; a logging failure is a distinct failed install.
Function D16FailInstallation
  ${If} $d16InstallNativeError == ""
    StrCpy $d16InstallNativeError 0
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  System::Call 'kernel32::GetTickCount() i.r2'
  ${If} $d16InstallRequestId == ""
    StrCpy $d16InstallRequestId "nsis-install-$0-$2"
  ${EndIf}
  ClearErrors
  GetTempFileName $d16InstallLog
  IfErrors diagnostic_failed
  FileOpen $1 "$d16InstallLog" w
  IfErrors diagnostic_failed
  FileWrite $1 '{"errorCode":"$d16InstallErrorCode","requestId":"$d16InstallRequestId","appId":"ai.codeflow.codeflowai","stage":"$d16InstallStage","rootCause":"$d16InstallCause","exitCode":$d16InstallExitCode,"win32Error":$d16InstallNativeError}$\r$\n'
  IfErrors diagnostic_close_failed
  System::Call 'kernel32::FlushFileBuffers(p r1) i.r2'
  ${If} $2 == 0
    Goto diagnostic_close_failed
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r1) i.r2'
  ${If} $2 == 0
    Goto diagnostic_failed
  ${EndIf}
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "CodeFlow 安装失败（$d16InstallRequestId）。日志：$d16InstallLog" /SD IDOK
  Abort
  diagnostic_close_failed:
    System::Call 'kernel32::CloseHandle(p r1) i.r2'
  diagnostic_failed:
    DetailPrint '{"errorCode":"DESKTOP_INSTALL_DIAGNOSTIC_FAILED","requestId":"$d16InstallRequestId","appId":"ai.codeflow.codeflowai","stage":"$d16InstallStage","rootCause":"$d16InstallCause","exitCode":$d16InstallExitCode}'
    SetErrorLevel 2
    MessageBox MB_ICONSTOP|MB_OK "CodeFlow 安装失败，且诊断日志保存失败（$d16InstallCause）。" /SD IDOK
    Abort
FunctionEnd

; Commit only a durable program-copy fact; business repair and marker consumption belong to normal startup.
Function D16RecordInstallation
  StrCpy $d16InstallStage installation-files-completed
  StrCpy $d16InstallErrorCode DESKTOP_INSTALL_COMPLETION_FAILED
  StrCpy $d16InstallExitCode "null"
  StrCpy $d16InstallNativeError 0
  ${If} $d16InstallRequestId == ""
    Call D16NewInstallRequestId
  ${EndIf}
  StrCpy $d16StopFailure ""
  Call D16ValidateStopRoot
  ${If} $d16StopFailure != ""
    StrCpy $d16InstallCause $d16StopFailure
    Call D16FailInstallation
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\installation-completed.ini") i.r0 ?e'
  Pop $d16InstallNativeError
  ${If} $0 == -1
    IntCmp $d16InstallNativeError 2 marker_create marker_path_invalid marker_path_invalid
  ${EndIf}
  IntOp $0 $0 & 0x410
  IntCmp $0 0 +1 marker_path_invalid marker_path_invalid
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\installation-completed.ini", i 0x80000000, i 1, p 0, i 3, i 0x00200080, p 0) p.s ?e'
  Pop $d16InstallNativeError
  Pop $d16InstallMarkerHandle
  IntCmp $d16InstallMarkerHandle -1 marker_path_invalid
  System::Alloc 52
  Pop $2
  StrCmp $2 0 marker_identity_close
  System::Call 'kernel32::GetFileInformationByHandle(p $d16InstallMarkerHandle, p r2) i.r0 ?e'
  Pop $d16InstallNativeError
  StrCpy $3 0
  ${If} $0 != 0
    IntOp $0 $2 + 40
    System::Call '*$0(i .r3)'
    System::Call '*$2(i .r0)'
    IntOp $0 $0 & 0x410
    ${If} $0 != 0
      StrCpy $3 0
    ${EndIf}
  ${EndIf}
  System::Free $2
  System::Call 'kernel32::CloseHandle(p $d16InstallMarkerHandle) i.r0 ?e'
  Pop $d16InstallNativeError
  IntCmp $0 0 marker_path_invalid
  IntCmp $3 1 marker_create marker_path_invalid marker_path_invalid
  marker_identity_close:
    System::Call 'kernel32::CloseHandle(p $d16InstallMarkerHandle) i.r0'
    Goto marker_path_invalid
  marker_create:
    StrCpy $d16InstallMarkerTemporary "$INSTDIR\installation-completed.ini.$d16InstallRequestId.tmp"
    System::Call 'kernel32::CreateFileW(w "$d16InstallMarkerTemporary", i 0x40000000, i 0, p 0, i 1, i 0x00200080, p 0) p.s ?e'
    Pop $d16InstallNativeError
    Pop $d16InstallMarkerHandle
    IntCmp $d16InstallMarkerHandle -1 marker_write_failed
    ClearErrors
    FileWrite $d16InstallMarkerHandle "[installation]$\r$\nschema=1$\r$\nrequestId=$d16InstallRequestId$\r$\n"
    IfErrors marker_write_close_failed
    System::Call 'kernel32::FlushFileBuffers(p $d16InstallMarkerHandle) i.r0 ?e'
    Pop $d16InstallNativeError
    IntCmp $0 0 marker_write_close_failed
    System::Call 'kernel32::CloseHandle(p $d16InstallMarkerHandle) i.r0 ?e'
    Pop $d16InstallNativeError
    IntCmp $0 0 marker_write_failed
    System::Call 'kernel32::MoveFileExW(w "$d16InstallMarkerTemporary", w "$INSTDIR\installation-completed.ini", i 9) i.r0 ?e'
    Pop $d16InstallNativeError
    IntCmp $0 0 marker_write_failed
    Return
  marker_write_close_failed:
    System::Call 'kernel32::CloseHandle(p $d16InstallMarkerHandle) i.r0'
  marker_write_failed:
    StrCpy $d16InstallCause INSTALLATION_MARKER_WRITE_FAILED
    Call D16FailInstallation
  marker_path_invalid:
    StrCpy $d16InstallCause INSTALLATION_MARKER_PATH_INVALID
    Call D16FailInstallation
FunctionEnd

; Record completed program files without starting Electron or touching any profile.
!macro customInstall
  Call D16RecordInstallation
!macroend
!endif

!ifdef BUILD_UNINSTALLER
; Stop only this installation's processes; never open or mutate business data.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Call un.D16NewRequestId
    !insertmacro D16StopInstalledProcesses true
  ${EndIf}
!macroend
!endif

; Keep the assisted-installer vocabulary explicit when a bundled template references it.
!ifndef D16_ASSISTED_LANGUAGE_KEYS
  !define D16_ASSISTED_LANGUAGE_KEYS "chooseUninstallationOptions;whichInstallationShouldBeRemoved;whichInstallationRemove;forAll;onlyForMe;loginWithAdminAccount;perUserInstall;uninstall;freshInstallForCurrent;perMachineInstall;freshInstallForAll"
!endif
