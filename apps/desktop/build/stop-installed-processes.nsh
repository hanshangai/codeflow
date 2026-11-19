!include "LogicLib.nsh"

!if ${NSIS_PTR_SIZE} != 4
  !error "Installation process ownership requires the existing x86 NSIS stub"
!endif

Var d16StopRoot
Var d16StopFailure
Var d16StopError
Var d16StopPid
Var d16StopHandle
Var d16StopList
Var d16StopNode
Var d16StopSnapshot
Var d16StopEntry
Var d16StopPath
Var d16StopName
Var d16StopParent
Var d16StopTimes
Var d16StopInfo
Var d16StopAdded
Var d16StopFound
Var d16StopPass
Var d16StopLog
Var d16StopRequest
Var d16StopWindow
Var d16StopDeadline

!ifdef BUILD_UNINSTALLER
  !define D16_STOP_PREFIX "un."
!else
  !define D16_STOP_PREFIX ""
!endif

; All stop diagnostics share a request and contain only bounded identifiers and Win32 causes.
Function ${D16_STOP_PREFIX}D16StopDiagnostic
  StrCpy $1 $d16StopFailure
  StrCmp $0 DESKTOP_INSTALL_PROCESS_FORCED 0 +2
    StrCpy $1 GRACEFUL_CLOSE_TIMEOUT
  FileWrite $d16StopLog '{"code":"$0","requestId":"$d16StopRequest","stage":"installation-process-stop","entity":"installation-process","processId":$d16StopPid,"rootCause":"$1","win32Error":$d16StopError}$\r$\n'
  IfErrors 0 +2
    StrCpy $d16StopFailure DIAGNOSTIC_WRITE_FAILED
FunctionEnd

; Reject drive roots, noncanonical roots and every reparse ancestor before determining ownership.
Function ${D16_STOP_PREFIX}D16ValidateStopRoot
  StrCpy $d16StopRoot "$INSTDIR"
  StrLen $0 $d16StopRoot
  ${If} $0 <= 3
    StrCpy $d16StopFailure INSTALL_ROOT_INVALID
    Return
  ${EndIf}
  StrCpy $1 $d16StopRoot 2 1
  StrCmp $1 ":\" 0 root_invalid
  System::Call 'kernel32::GetFullPathNameW(w "$d16StopRoot", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
  IntCmp $0 0 root_invalid root_invalid
  IntCmp $0 ${NSIS_MAX_STRLEN} root_invalid +1 root_invalid
  StrCmp $1 $d16StopRoot 0 root_invalid
  StrCpy $1 $d16StopRoot
  root_parent:
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r0 ?e'
    Pop $d16StopError
    IntCmp $0 -1 root_invalid
    IntOp $0 $0 & 0x410
    IntCmp $0 16 0 root_invalid root_invalid
    StrLen $0 $1
    IntCmp $0 3 root_valid root_valid
    ${GetParent} "$1" $1
    StrLen $0 $1
    ${If} $0 == 2
      StrCpy $1 "$1\"
    ${EndIf}
    Goto root_parent
  root_invalid:
    StrCpy $d16StopFailure INSTALL_ROOT_INVALID
    Return
  root_valid:
    StrCpy $d16StopError 0
FunctionEnd

; Match only this root launcher or one direct versioned launcher; path ancestors must be ordinary directories.
Function ${D16_STOP_PREFIX}D16IsRootProcess
  StrCpy $0 0
  StrCmp $d16StopPath "$d16StopRoot\CodeFlowAI.exe" owned_root
  StrCpy $1 "$d16StopRoot\shells\"
  StrLen $2 $1
  StrCpy $3 $d16StopPath $2
  StrCmp $1 $3 0 root_process_done
  StrCpy $3 $d16StopPath "" $2
  ${GetParent} "$3" $4
  StrCmp $4 "" root_process_done
  ${GetParent} "$4" $5
  StrCmp $5 "" 0 root_process_done
  StrCmp $3 "$4\CodeFlowAI.exe" 0 root_process_done
  StrCpy $1 "$d16StopRoot\shells\$4"
  version_parent:
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r2 ?e'
    Pop $d16StopError
    IntCmp $2 -1 root_path_invalid
    IntOp $2 $2 & 0x410
    IntCmp $2 16 0 root_path_invalid root_path_invalid
    StrCmp $1 $d16StopRoot owned_root
    ${GetParent} "$1" $1
    Goto version_parent
  root_path_invalid:
    StrCpy $d16StopFailure PROCESS_PATH_INVALID
    Return
  owned_root:
    StrCpy $0 1
  root_process_done:
FunctionEnd

; Open the current instance and verify a descendant's live parent and creation interval before retaining its handle.
Function ${D16_STOP_PREFIX}D16CaptureProcess
  StrCpy $d16StopHandle 0
  System::Call 'kernel32::OpenProcess(i 0x101001, i 0, i $d16StopPid) p.s ?e'
  Pop $d16StopError
  Pop $d16StopHandle
  ${If} $d16StopHandle == 0
    ; ERROR_INVALID_PARAMETER means this snapshot's PID has already exited.
    ${If} $d16StopError != 87
      StrCpy $d16StopFailure PROCESS_OPEN_FAILED
    ${EndIf}
    Return
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p $d16StopHandle, i 0) i.r0'
  ${If} $0 == 0
    Goto capture_close
  ${ElseIf} $0 != 258
    StrCpy $d16StopFailure PROCESS_WAIT_FAILED
    Goto capture_close
  ${EndIf}
  System::Call 'kernel32::QueryFullProcessImageNameW(p $d16StopHandle, i 0, w .r1, *i ${NSIS_MAX_STRLEN}) i.r0 ?e'
  Pop $d16StopError
  ${If} $0 == 0
    StrCpy $d16StopFailure PROCESS_PATH_UNAVAILABLE
    Goto capture_close
  ${EndIf}
  StrCpy $d16StopPath $1
  IntOp $1 $d16StopTimes + 8
  IntOp $2 $d16StopTimes + 16
  IntOp $3 $d16StopTimes + 24
  System::Call 'kernel32::GetProcessTimes(p $d16StopHandle, p $d16StopTimes, p r1, p r2, p r3) i.r0 ?e'
  Pop $d16StopError
  ${If} $0 == 0
    StrCpy $d16StopFailure PROCESS_IDENTITY_UNAVAILABLE
    Goto capture_close
  ${EndIf}
  Call ${D16_STOP_PREFIX}D16IsRootProcess
  ${If} $d16StopFailure != ""
    Goto capture_close
  ${EndIf}
  ${If} $0 == 0
    StrCmp $d16StopName CodeFlowAI.exe capture_close
    StrCmp $d16StopParent 0 capture_close
    System::Call 'ntdll::NtQueryInformationProcess(p $d16StopHandle, i 0, p $d16StopInfo, i 24, p 0) i.r0'
    ${If} $0 != 0
      StrCpy $d16StopFailure PROCESS_PARENT_UNAVAILABLE
      Goto capture_close
    ${EndIf}
    IntOp $1 $d16StopInfo + 20
    System::Call '*$1(i .r2)'
    System::Call '*$d16StopParent(p .r3, i .r4, p .r5)'
    IntCmp $2 $4 0 capture_close capture_close
    IntOp $1 $d16StopParent + 12
    IntOp $2 $d16StopParent + 20
    IntOp $3 $d16StopParent + 28
    IntOp $4 $d16StopParent + 36
    System::Call 'kernel32::GetProcessTimes(p r5, p r1, p r2, p r3, p r4) i.r0 ?e'
    Pop $d16StopError
    ${If} $0 == 0
      StrCpy $d16StopFailure PROCESS_PARENT_IDENTITY_UNAVAILABLE
      Goto capture_close
    ${EndIf}
    System::Call 'kernel32::CompareFileTime(p $d16StopTimes, p r1) i.r0'
    IntCmp $0 0 +1 capture_close +1
    ; An exited parent cannot own a process created after its recorded exit.
    System::Call 'kernel32::WaitForSingleObject(p r5, i 0) i.r0'
    ${If} $0 == 0
      IntOp $1 $d16StopParent + 20
      System::Call 'kernel32::CompareFileTime(p $d16StopTimes, p r1) i.r0'
      IntCmp $0 0 capture_close +1 capture_close
    ${ElseIf} $0 != 258
      StrCpy $d16StopFailure PROCESS_PARENT_WAIT_FAILED
      Goto capture_close
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 44) p.r0'
  ${If} $0 == 0
    StrCpy $d16StopFailure PROCESS_ALLOCATION_FAILED
    Goto capture_close
  ${EndIf}
  System::Call '*$0(p $d16StopList, i $d16StopPid, p $d16StopHandle)'
  IntOp $1 $0 + 12
  System::Call 'kernel32::RtlMoveMemory(p r1, p $d16StopTimes, p 32)'
  StrCpy $d16StopList $0
  StrCpy $d16StopAdded 1
  StrCpy $d16StopFound 1
  Return
  capture_close:
    System::Call 'kernel32::CloseHandle(p $d16StopHandle) i.r0'
    ${If} $0 == 0
      StrCpy $d16StopFailure PROCESS_HANDLE_CLOSE_FAILED
    ${EndIf}
FunctionEnd

; Repeat a stable process snapshot to discover roots before descendants, retaining original instance handles.
Function ${D16_STOP_PREFIX}D16FindInstalledProcesses
  StrCpy $d16StopFound 0
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.s ?e'
  Pop $d16StopError
  Pop $d16StopSnapshot
  IntCmp $d16StopSnapshot -1 snapshot_failed
  snapshot_pass:
    StrCpy $d16StopAdded 0
    System::Call '*$d16StopEntry(i 556)'
    System::Call 'kernel32::Process32FirstW(p $d16StopSnapshot, p $d16StopEntry) i.r0 ?e'
    Pop $d16StopError
    Goto snapshot_result
  snapshot_next:
    System::Call 'kernel32::Process32NextW(p $d16StopSnapshot, p $d16StopEntry) i.r0 ?e'
    Pop $d16StopError
  snapshot_result:
    ${If} $0 == 0
      ${If} $d16StopError != 18
        StrCpy $d16StopFailure PROCESS_ENUMERATION_FAILED
      ${EndIf}
      Goto snapshot_end
    ${EndIf}
    IntOp $1 $d16StopEntry + 8
    System::Call '*$1(i .r2)'
    StrCpy $d16StopPid $2
    IntOp $1 $d16StopEntry + 24
    System::Call '*$1(i .r3)'
    IntOp $1 $d16StopEntry + 36
    System::Call 'kernel32::lstrcpynW(w .r4, p r1, i 260) p'
    StrCpy $d16StopName $4
    StrCpy $d16StopParent 0
    StrCpy $d16StopNode $d16StopList
  find_parent:
    StrCmp $d16StopNode 0 candidate
    System::Call '*$d16StopNode(p .r0, i .r1, p .r2)'
    ${If} $1 == $d16StopPid
      System::Call 'kernel32::WaitForSingleObject(p r2, i 0) i.r4'
      ${If} $4 == 258
        Goto snapshot_next
      ${ElseIf} $4 != 0
        StrCpy $d16StopFailure PROCESS_WAIT_FAILED
        Goto snapshot_close
      ${EndIf}
    ${EndIf}
    ${If} $1 == $3
    ${AndIf} $d16StopParent == 0
      StrCpy $d16StopParent $d16StopNode
    ${EndIf}
    StrCpy $d16StopNode $0
    Goto find_parent
  candidate:
    StrCmp $d16StopName CodeFlowAI.exe capture
    StrCmp $d16StopParent 0 snapshot_next
  capture:
    Call ${D16_STOP_PREFIX}D16CaptureProcess
    StrCmp $d16StopFailure "" snapshot_next
  snapshot_end:
    StrCmp $d16StopFailure "" 0 snapshot_close
    StrCmp $d16StopAdded 1 snapshot_pass
  snapshot_close:
    System::Call 'kernel32::CloseHandle(p $d16StopSnapshot) i.r0'
    ${If} $0 == 0
      StrCpy $d16StopFailure PROCESS_SNAPSHOT_CLOSE_FAILED
    ${EndIf}
    Return
  snapshot_failed:
    StrCpy $d16StopFailure PROCESS_SNAPSHOT_FAILED
FunctionEnd

; Ask owned windows to close before forced termination; no business executable is launched.
Function ${D16_STOP_PREFIX}D16CloseInstalledWindows
  StrCpy $d16StopWindow 0
  close_window_next:
    System::Call 'user32::FindWindowExW(p 0, p $d16StopWindow, p 0, p 0) p.s'
    Pop $d16StopWindow
    StrCmp $d16StopWindow 0 close_windows_done
    System::Call 'user32::GetWindowThreadProcessId(p $d16StopWindow, *i .r3) i.r0'
    StrCpy $d16StopNode $d16StopList
  close_window_owner:
    StrCmp $d16StopNode 0 close_window_next
    System::Call '*$d16StopNode(p .r0, i .r1, p .r2)'
    StrCpy $d16StopNode $0
    IntCmp $1 $3 0 close_window_owner close_window_owner
    System::Call 'kernel32::WaitForSingleObject(p r2, i 0) i.r0'
    IntCmp $0 0 close_window_next
    System::Call 'user32::PostMessageW(p $d16StopWindow, i 16, p 0, p 0) i.r0 ?e'
    Pop $d16StopError
    ${If} $0 == 0
      System::Call 'kernel32::WaitForSingleObject(p r2, i 0) i.r0'
      ${If} $0 != 0
        StrCpy $d16StopFailure PROCESS_CLOSE_REQUEST_FAILED
        Return
      ${EndIf}
    ${EndIf}
    Goto close_window_next
  close_windows_done:
    StrCpy $d16StopDeadline 80
  close_wait_pass:
    StrCpy $d16StopNode $d16StopList
  close_wait_process:
    StrCmp $d16StopNode 0 close_wait_done
    System::Call '*$d16StopNode(p .r0, i .r1, p .r2)'
    StrCpy $d16StopNode $0
    System::Call 'kernel32::WaitForSingleObject(p r2, i 0) i.r0'
    IntCmp $0 0 close_wait_process
    ${If} $0 != 258
      StrCpy $d16StopFailure PROCESS_WAIT_FAILED
      Return
    ${EndIf}
    IntCmp $d16StopDeadline 0 close_wait_done
    IntOp $d16StopDeadline $d16StopDeadline - 1
    Sleep 100
    Goto close_wait_pass
  close_wait_done:
FunctionEnd

; Stop retained instances and wait on their handles; PID reuse can never change a termination target.
Function ${D16_STOP_PREFIX}D16StopNativeProcesses
  StrCpy $d16StopFailure ""
  StrCpy $d16StopError 0
  StrCpy $d16StopPid 0
  StrCpy $d16StopList 0
  ClearErrors
  GetTempFileName $R8
  FileOpen $d16StopLog "$R8" w
  IfErrors stop_log_failed
  StrCpy $0 DESKTOP_INSTALL_PROCESS_STOP_STARTED
  Call ${D16_STOP_PREFIX}D16StopDiagnostic
  Call ${D16_STOP_PREFIX}D16ValidateStopRoot
  StrCmp $d16StopFailure "" 0 stop_done
  System::Alloc 556
  Pop $d16StopEntry
  System::Alloc 32
  Pop $d16StopTimes
  System::Alloc 24
  Pop $d16StopInfo
  StrCmp $d16StopEntry 0 allocation_failed
  StrCmp $d16StopTimes 0 allocation_failed
  StrCmp $d16StopInfo 0 allocation_failed
  Call ${D16_STOP_PREFIX}D16FindInstalledProcesses
  StrCmp $d16StopFailure "" 0 stop_cleanup
  Call ${D16_STOP_PREFIX}D16CloseInstalledWindows
  StrCmp $d16StopFailure "" 0 stop_cleanup
  Call ${D16_STOP_PREFIX}D16FindInstalledProcesses
  StrCmp $d16StopFailure "" 0 stop_cleanup
  StrCpy $d16StopPass 0
  stop_pass:
  StrCpy $d16StopNode $d16StopList
  stop_process:
    StrCmp $d16StopNode 0 stop_verify
    System::Call '*$d16StopNode(p .r0, i .r1, p .r2)'
    StrCpy $d16StopPid $1
    StrCpy $d16StopHandle $2
    System::Call 'kernel32::WaitForSingleObject(p r2, i 0) i.r3'
    IntCmp $3 0 stop_next
    ${If} $3 != 258
      StrCpy $d16StopFailure PROCESS_WAIT_FAILED
      Goto stop_cleanup
    ${EndIf}
    StrCpy $0 DESKTOP_INSTALL_PROCESS_FORCED
    Call ${D16_STOP_PREFIX}D16StopDiagnostic
    StrCmp $d16StopFailure "" 0 stop_cleanup
    System::Call 'kernel32::TerminateProcess(p $d16StopHandle, i 0) i.r0 ?e'
    Pop $d16StopError
    ${If} $0 == 0
      System::Call 'kernel32::WaitForSingleObject(p $d16StopHandle, i 0) i.r0'
      ${If} $0 != 0
        StrCpy $d16StopFailure PROCESS_TERMINATION_FAILED
        Goto stop_cleanup
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::WaitForSingleObject(p $d16StopHandle, i 5000) i.r0'
    ${If} $0 != 0
      StrCpy $d16StopFailure PROCESS_STOP_TIMEOUT
      Goto stop_cleanup
    ${EndIf}
  stop_next:
    System::Call '*$d16StopNode(p .r0)'
    StrCpy $d16StopNode $0
    Goto stop_process
  stop_verify:
    Call ${D16_STOP_PREFIX}D16FindInstalledProcesses
    StrCmp $d16StopFailure "" 0 stop_cleanup
    StrCmp $d16StopFound 0 stop_cleanup
    IntOp $d16StopPass $d16StopPass + 1
    IntCmp $d16StopPass 3 +1 stop_pass +1
    StrCpy $d16StopFailure PROCESS_RESTART_LIMIT
    Goto stop_cleanup
  allocation_failed:
    StrCpy $d16StopFailure PROCESS_ALLOCATION_FAILED
  stop_cleanup:
    StrCpy $d16StopNode $d16StopList
  close_process:
    StrCmp $d16StopNode 0 free_buffers
    System::Call '*$d16StopNode(p .r0, i .r1, p .r2)'
    StrCpy $d16StopList $0
    System::Call 'kernel32::CloseHandle(p r2) i.r0'
    ${If} $0 == 0
      StrCpy $d16StopFailure PROCESS_HANDLE_CLOSE_FAILED
    ${EndIf}
    System::Free $d16StopNode
    StrCpy $d16StopNode $d16StopList
    Goto close_process
  free_buffers:
    System::Free $d16StopEntry
    System::Free $d16StopTimes
    System::Free $d16StopInfo
  stop_done:
    StrCpy $0 DESKTOP_INSTALL_PROCESS_STOP_FAILED
    ${If} $d16StopFailure == ""
      StrCpy $0 DESKTOP_INSTALL_PROCESSES_STOPPED
      StrCpy $d16StopPid 0
    ${EndIf}
    Call ${D16_STOP_PREFIX}D16StopDiagnostic
    System::Call 'kernel32::FlushFileBuffers(p $d16StopLog) i.r0'
    ${If} $0 == 0
      StrCpy $d16StopFailure DIAGNOSTIC_FLUSH_FAILED
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p $d16StopLog) i.r0'
    ${If} $0 == 0
      StrCpy $d16StopFailure DIAGNOSTIC_CLOSE_FAILED
    ${EndIf}
    Return
  stop_log_failed:
    StrCpy $d16StopFailure DIAGNOSTIC_OPEN_FAILED
FunctionEnd

!undef D16_STOP_PREFIX
