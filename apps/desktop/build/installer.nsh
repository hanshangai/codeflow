; D16 NSIS hooks. The parent electron-builder template owns file removal and page order.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!ifndef CODEFLOW_STOP_INSTALLED_HELPER
  !define CODEFLOW_STOP_INSTALLED_HELPER "${__FILEDIR__}\stop-installed-processes.ps1"
!endif

!macro D16StopInstalledProcesses UNINSTALL
  InitPluginsDir
  ClearErrors
  File /oname=$PLUGINSDIR\stop-installed-processes.ps1 "${CODEFLOW_STOP_INSTALLED_HELPER}"
  GetTempFileName $R8
  StrCpy $R9 -1
  ${IfNot} ${Errors}
    StrCpy $R7 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
      StrCpy $R7 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    ${EndIf}
    ExecWait '"$R7" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installed-processes.ps1" -InstallDirectory "$INSTDIR" -LogPath "$R8"' $R9
  ${EndIf}
  DetailPrint "CodeFlow process stop diagnostic: $R8"
  ${If} ${Errors}
  ${OrIf} $R9 != 0
    !if "${UNINSTALL}" == "true"
      StrCpy $d16FailureCode DESKTOP_INSTALL_PROCESS_STOP_FAILED
      StrCpy $d16FailureDetails '"stage":"installation-process-stop","rootCause":"PROCESS_STOP_FAILED","exitCode":$R9'
      Call un.D16FailUninstall
    !else
      StrCpy $d16InstallExitCode $R9
      StrCpy $d16InstallCause "INSTALL_PROCESS_STOP_FAILED"
      Call D16FailInstallation
    !endif
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ${If} ${isUpdated}
      Call un.D16NewRequestId
      !insertmacro D16StopInstalledProcesses true
      ClearErrors
      ExecWait '"$INSTDIR\CodeFlowAI.exe" --codeflow-check-installation' $0
      ${If} ${Errors}
        StrCpy $d16FailureCode DESKTOP_INSTALL_PREFLIGHT_FAILED
        StrCpy $d16FailureDetails '"stage":"installation-preflight","rootCause":"PROCESS_START_FAILED","exitCode":null'
        Call un.D16FailUninstall
      ${EndIf}
      ${If} $0 != 0
        StrCpy $d16FailureCode DESKTOP_INSTALL_PREFLIGHT_FAILED
        StrCpy $d16FailureDetails '"stage":"installation-preflight","rootCause":"PROCESS_EXIT_NONZERO","exitCode":$0'
        Call un.D16FailUninstall
      ${EndIf}
    ${EndIf}
  !else
    ${If} ${FileExists} "$INSTDIR\CodeFlowAI.exe"
      !insertmacro D16StopInstalledProcesses false
      ClearErrors
      ExecWait '"$INSTDIR\CodeFlowAI.exe" --codeflow-check-installation' $0
      ${If} ${Errors}
        StrCpy $d16InstallExitCode "null"
        StrCpy $d16InstallCause "PREFLIGHT_PROCESS_START_FAILED"
        Call D16FailInstallation
      ${EndIf}
      ${If} $0 != 0
        StrCpy $d16InstallExitCode $0
        StrCpy $d16InstallCause "PREFLIGHT_PROCESS_EXIT_NONZERO"
        Call D16FailInstallation
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!ifdef BUILD_UNINSTALLER
  Var d16KeepData
  Var d16RequestId
  Var d16Mode
  Var d16Parameters
  Var d16FailureLog
  Var d16FailureCode
  Var d16FailureDetails
  Var d16ChoiceCause

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

; Preserve the choice-failure contract while sharing the uninstall diagnostic boundary.
Function un.D16FailChoice
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    System::Call 'kernel32::GetTickCount() i.r2'
    StrCpy $d16RequestId "nsis-choice-$0-$2"
    StrCpy $d16FailureCode DESKTOP_UNINSTALL_CHOICE_INVALID
    StrCpy $d16FailureDetails '"stage":"uninstall-choice","rootCause":"$d16ChoiceCause"'
    Call un.D16FailUninstall
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
  !insertmacro customCheckAppRunning
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
    Return
  ${EndIf}
  ${If} ${Silent}
    Call un.D16NewRequestId
    StrCpy $d16FailureCode DESKTOP_UNINSTALL_INVOCATION_REJECTED
    StrCpy $d16FailureDetails '"stage":"uninstall-init","rootCause":"SILENT_UNINSTALL_UNSUPPORTED"'
    Call un.D16FailUninstall
  ${EndIf}
!macroend

; The single uninstall choice defaults to retaining application data.
!macro customUnWelcomePage
  UninstPage custom un.D16UninstallWelcomePage un.D16UninstallWelcomeLeave
  ; Explain the private-data scope before choosing; skip this page for upgrades.
  Function un.D16UninstallWelcomePage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0u 100% 24u "仅影响本机应用数据；项目和工作区 .codeflow 始终保留。"
    Pop $0
    ${NSD_CreateCheckbox} 0 32u 100% 12u "保留本机应用数据"
    Pop $d16KeepData
    ${NSD_CreateLabel} 0 56u 100% 40u "两种选择都会移除安装身份；保留数据中的敏感凭据需重新录入。"
    Pop $0
    ${If} $d16Mode == ""
      StrCpy $d16Mode keep
    ${EndIf}
    ${If} $d16Mode == keep
      ${NSD_Check} $d16KeepData
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  ; Read the choice while its window is still alive; never infer remove from a dead handle.
  Function un.D16UninstallWelcomeLeave
    System::Call 'user32::IsWindow(p $d16KeepData) i.r0'
    ${If} $0 != 0
      ${NSD_GetState} $d16KeepData $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $d16Mode keep
        Return
      ${ElseIf} $0 == ${BST_UNCHECKED}
        StrCpy $d16Mode remove
        Return
      ${EndIf}
    ${EndIf}
    StrCpy $d16ChoiceCause CONTROL_INVALID
    Call un.D16FailChoice
  FunctionEnd
!macroend

!else
Var d16InstallLog
Var d16InstallRequestId
Var d16InstallCause
Var d16InstallExitCode

; Persist only bounded NSIS diagnostics; a logging failure is a distinct failed install.
Function D16FailInstallation
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  System::Call 'kernel32::GetTickCount() i.r2'
  StrCpy $d16InstallRequestId "nsis-install-$0-$2"
  ClearErrors
  GetTempFileName $d16InstallLog
  IfErrors diagnostic_failed
  FileOpen $1 "$d16InstallLog" w
  IfErrors diagnostic_failed
  FileWrite $1 '{"errorCode":"DESKTOP_INSTALL_REGISTRATION_FAILED","requestId":"$d16InstallRequestId","appId":"ai.codeflow.codeflowai","stage":"installation-registration","rootCause":"$d16InstallCause","exitCode":$d16InstallExitCode}$\r$\n'
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
  MessageBox MB_ICONSTOP|MB_OK "CodeFlow 安装登记失败（$d16InstallRequestId）。日志：$d16InstallLog" /SD IDOK
  Abort
  diagnostic_close_failed:
    System::Call 'kernel32::CloseHandle(p r1) i.r2'
  diagnostic_failed:
    DetailPrint '{"errorCode":"DESKTOP_INSTALL_DIAGNOSTIC_FAILED","requestId":"$d16InstallRequestId","appId":"ai.codeflow.codeflowai","stage":"installation-registration","registrationFailure":"$d16InstallCause","exitCode":$d16InstallExitCode}'
    SetErrorLevel 2
    MessageBox MB_ICONSTOP|MB_OK "CodeFlow 安装登记失败，且诊断日志保存失败（$d16InstallCause）。" /SD IDOK
    Abort
FunctionEnd

; Register the installation only after the template has copied the executable.
!macro customInstall
  StrCpy $d16InstallExitCode "null"
  ClearErrors
  ExecWait '"$INSTDIR\CodeFlowAI.exe" --codeflow-register-installation' $0
  ${If} ${Errors}
    StrCpy $d16InstallCause "PROCESS_START_FAILED"
    Call D16FailInstallation
  ${EndIf}
  ${If} $0 != 0
    StrCpy $d16InstallExitCode $0
    StrCpy $d16InstallCause "PROCESS_EXIT_NONZERO"
    Call D16FailInstallation
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
; Run one synchronous maintenance request and stop the template on any failure.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ${If} $d16Mode != keep
    ${AndIf} $d16Mode != remove
      StrCpy $d16ChoiceCause MODE_UNCONFIRMED
      Call un.D16FailChoice
    ${EndIf}
    Call un.D16NewRequestId
    ClearErrors
    ExecWait '"$INSTDIR\CodeFlowAI.exe" --codeflow-uninstall-maintenance "$d16RequestId" "$d16Mode" --resume-pending' $0
    ${If} ${Errors}
      StrCpy $d16FailureCode DESKTOP_UNINSTALL_MAINTENANCE_FAILED
      StrCpy $d16FailureDetails '"stage":"uninstall-maintenance","mode":"$d16Mode","rootCause":"PROCESS_START_FAILED","exitCode":null'
      Call un.D16FailUninstall
    ${EndIf}
    ${If} $0 != 0
      StrCpy $d16FailureCode DESKTOP_UNINSTALL_MAINTENANCE_FAILED
      StrCpy $d16FailureDetails '"stage":"uninstall-maintenance","mode":"$d16Mode","rootCause":"PROCESS_EXIT_NONZERO","exitCode":$0'
      Call un.D16FailUninstall
    ${EndIf}
  ${EndIf}
!macroend
!endif

; Keep the assisted-installer vocabulary explicit when a bundled template references it.
!ifndef D16_ASSISTED_LANGUAGE_KEYS
  !define D16_ASSISTED_LANGUAGE_KEYS "chooseUninstallationOptions;whichInstallationShouldBeRemoved;whichInstallationRemove;forAll;onlyForMe;loginWithAdminAccount;perUserInstall;uninstall;freshInstallForCurrent;perMachineInstall;freshInstallForAll"
!endif
