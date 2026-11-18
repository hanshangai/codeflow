Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
Name "CodeFlow"
OutFile "${OUTPUT_FILE}"

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!if ${NSIS_PTR_SIZE} != 4
  !error "Fixed launcher requires the existing x86 NSIS stub"
!endif

Var stateFile
Var activeId
Var previousId
Var baselineId
Var requestId
Var failure
Var byte
Var expected
Var parsedId
Var idBase
Var checkedPath
Var expectedType
Var relativeEntity
Var win32Error
Var stage
Var arguments
Var cleanupWin32Error
Var processCreated
Var lifecycleCall
Var lifecycleExitCode
Var lifecycleArgv
Var lifecycleArgc
Var lifecycleFlag
Var lifecycleRequest
Var lifecycleMode
Var lifecycleResume
Var lifecycleReserved

; Parse only reserved lifecycle argv; ordinary calls retain their original raw arguments.
Function ReadLifecycleArguments
  StrCpy $lifecycleCall false
  StrCpy $lifecycleExitCode 0
  StrCpy $lifecycleReserved false
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'shell32::CommandLineToArgvW(p r0, *i .r1) p.r2 ?e'
  Pop $win32Error
  ${If} $2 == 0
    StrCpy $failure "COMMAND_LINE_PARSE_FAILED"
    Return
  ${EndIf}
  StrCpy $win32Error 0
  StrCpy $lifecycleArgv $2
  StrCpy $lifecycleArgc $1
  StrCpy $3 1
  scan_lifecycle:
    IntCmp $3 $lifecycleArgc classify_lifecycle scan_argument classify_lifecycle
  scan_argument:
    IntOp $4 $3 * 4
    IntOp $4 $lifecycleArgv + $4
    System::Call '*$4(p .r5)'
    System::Call 'kernel32::lstrlenW(p r5) i.r6'
    IntCmp $6 ${NSIS_MAX_STRLEN} invalid_arguments +1 invalid_arguments
    System::Call 'kernel32::lstrcpynW(w .r6, p r5, i ${NSIS_MAX_STRLEN}) p'
    ${If} $3 == 1
      StrCpy $lifecycleFlag $6
    ${ElseIf} $3 == 2
      StrCpy $lifecycleRequest $6
    ${ElseIf} $3 == 3
      StrCpy $lifecycleMode $6
    ${ElseIf} $3 == 4
      StrCpy $lifecycleResume $6
    ${EndIf}
    StrLen $7 "--codeflow-register-installation"
    StrCpy $8 $6 $7
    StrCmpS $8 "--codeflow-register-installation" reserved_argument
    StrLen $7 "--codeflow-check-installation"
    StrCpy $8 $6 $7
    StrCmpS $8 "--codeflow-check-installation" reserved_argument
    StrLen $7 "--codeflow-uninstall-maintenance"
    StrCpy $8 $6 $7
    StrCmpS $8 "--codeflow-uninstall-maintenance" reserved_argument
    StrCmpS $6 "--delete-app-data" reserved_argument next_argument
  reserved_argument:
    StrCpy $lifecycleReserved true
  next_argument:
    IntOp $3 $3 + 1
    Goto scan_lifecycle
  classify_lifecycle:
    StrCmpS $lifecycleReserved true 0 free_arguments
    IntCmp $lifecycleArgc 2 registration_arguments
    IntCmp $lifecycleArgc 3 registration_request_arguments
    IntCmp $lifecycleArgc 4 maintenance_arguments
    IntCmp $lifecycleArgc 5 resume_arguments invalid_arguments invalid_arguments
  resume_arguments:
    StrCmpS $lifecycleResume "--resume-pending" maintenance_arguments invalid_arguments
  registration_arguments:
    StrCmpS $lifecycleFlag "--codeflow-register-installation" valid_arguments
    StrCmpS $lifecycleFlag "--codeflow-check-installation" valid_arguments invalid_arguments
  registration_request_arguments:
    StrCmpS $lifecycleFlag "--codeflow-register-installation" 0 invalid_arguments
    StrCmpS $lifecycleRequest "--resume-pending" invalid_arguments
    StrCpy $5 $lifecycleRequest 1
    StrCmpS $5 "-" invalid_arguments
    StrLen $4 $lifecycleRequest
    IntCmp $4 1 registration_request_length_valid invalid_arguments registration_request_length_valid
  registration_request_length_valid:
    IntCmp $4 128 valid_arguments valid_arguments invalid_arguments
  maintenance_arguments:
    StrCmpS $lifecycleFlag "--codeflow-uninstall-maintenance" 0 invalid_arguments
    StrCmpS $lifecycleMode keep mode_valid
    StrCmpS $lifecycleMode remove 0 invalid_arguments
  mode_valid:
    StrLen $4 $lifecycleRequest
    IntCmp $4 1 request_length_valid invalid_arguments request_length_valid
  request_length_valid:
    IntCmp $4 128 request_length_bounded request_length_bounded invalid_arguments
  request_length_bounded:
    StrCpy $4 0
  request_character:
    StrCpy $6 $lifecycleRequest 1 $4
    StrCmpS $6 "" valid_arguments
    StrCpy $7 "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    ${If} $4 != 0
      StrCpy $7 "$7._:+-"
    ${EndIf}
    StrCpy $8 0
  allowed_character:
    StrCpy $9 $7 1 $8
    StrCmpS $9 "" invalid_arguments
    StrCmpS $9 $6 character_valid
    IntOp $8 $8 + 1
    Goto allowed_character
  character_valid:
    IntOp $4 $4 + 1
    Goto request_character
  valid_arguments:
    StrCpy $lifecycleCall true
    Goto free_arguments
  invalid_arguments:
    StrCpy $failure "LIFECYCLE_ARGUMENTS_INVALID"
  free_arguments:
    StrCpy $2 $lifecycleArgv
    System::Call 'kernel32::LocalFree(p r2) p.r3 ?e'
    Pop $7
    ${If} $3 != 0
      ${If} $failure == ""
        StrCpy $failure "COMMAND_LINE_RELEASE_FAILED"
        StrCpy $win32Error $7
      ${Else}
        StrCpy $cleanupWin32Error $7
      ${EndIf}
    ${EndIf}
FunctionEnd

; Read one byte from the held read-only handle; -1 means a successful EOF.
Function ReadStateByte
  StrCpy $8 $stateFile
  System::Call 'kernel32::ReadFile(p r8, *i .r9, i 1, *i .r7, p 0) i.r6 ?e'
  Pop $5
  ${If} $6 == 0
    StrCpy $win32Error $5
    StrCpy $failure "STATE_READ_FAILED"
  ${ElseIf} $7 == 0
    StrCpy $byte -1
  ${Else}
    IntOp $byte $9 & 255
  ${EndIf}
FunctionEnd

; Close exactly the held state handle and retain a cleanup failure alongside any primary failure.
Function CloseState
  StrCpy $8 $stateFile
  System::Call 'kernel32::CloseHandle(p r8) i.r6 ?e'
  Pop $5
  ${If} $6 == 0
    ${If} $failure == ""
      StrCpy $win32Error $5
      StrCpy $failure "STATE_CLOSE_FAILED"
    ${Else}
      StrCpy $cleanupWin32Error $5
    ${EndIf}
  ${EndIf}
FunctionEnd

; Read an exact ASCII literal from the already opened state file.
Function ReadLiteral
  Exch $expected
  Push $0
  StrCpy $0 0
  loop_literal:
    StrCpy $1 $expected 1 $0
    StrCmp $1 "" done_literal
    Call ReadStateByte
    StrCmp $failure "" 0 done_literal
    IntFmt $2 "%c" $byte
    StrCmpS $1 $2 0 invalid_literal
    IntOp $0 $0 + 1
    Goto loop_literal
  invalid_literal:
    StrCpy $failure "STATE_FORMAT_INVALID"
  done_literal:
    Pop $0
    Pop $expected
FunctionEnd

; Read one bounded portable ID followed by an exact CRLF; empty is checked by the caller.
Function ReadId
  StrCpy $parsedId ""
  StrCpy $idBase ""
  StrCpy $3 0
  loop_id:
    Call ReadStateByte
    StrCmp $failure "" 0 done_id
    IntCmp $byte 13 end_id
    StrLen $0 $parsedId
    IntCmp $0 128 invalid_id invalid_id_length invalid_id
  invalid_id_length:
    ${If} $byte >= 48
    ${AndIf} $byte <= 57
      Goto append_id
    ${EndIf}
    ${If} $byte >= 65
    ${AndIf} $byte <= 90
      Goto append_id
    ${EndIf}
    ${If} $byte >= 97
    ${AndIf} $byte <= 122
      Goto append_id
    ${EndIf}
    StrCmp $parsedId "" invalid_id
    IntCmp $byte 46 append_id
    IntCmp $byte 95 append_id
    IntCmp $byte 45 append_id invalid_id invalid_id
  append_id:
    IntFmt $1 "%c" $byte
    StrCpy $parsedId "$parsedId$1"
    ${If} $byte == 46
      StrCpy $3 1
    ${ElseIf} $3 == 0
      StrCpy $idBase "$idBase$1"
    ${EndIf}
    Goto loop_id
  end_id:
    Call ReadStateByte
    StrCmp $failure "" 0 done_id
    IntCmp $byte 10 0 invalid_id invalid_id
    StrCpy $0 $parsedId 1 -1
    StrCmp $0 "." invalid_id
    StrCmp $idBase "CON" invalid_id
    StrCmp $idBase "PRN" invalid_id
    StrCmp $idBase "AUX" invalid_id
    StrCmp $idBase "NUL" invalid_id
    StrLen $0 $idBase
    IntCmp $0 4 0 done_id done_id
    StrCpy $0 $idBase 3
    StrCmp $0 "COM" reserved_number
    StrCmp $0 "LPT" reserved_number done_id
  reserved_number:
    StrCpy $0 $idBase 1 3
    IntCmp $0 1 invalid_id done_id check_number
  check_number:
    IntCmp $0 9 invalid_id invalid_id done_id
  invalid_id:
    StrCpy $failure "STATE_ID_INVALID"
  done_id:
FunctionEnd

; Reject missing objects and reparse points before reading state or executing a shell.
Function CheckPath
  System::Call 'kernel32::GetFileAttributesW(w "$checkedPath") i.r0 ?e'
  Pop $win32Error
  IntCmp $0 -1 missing_path
  StrCpy $win32Error 0
  IntOp $1 $0 & 0x400
  IntCmp $1 0 check_type
    StrCpy $failure "SHELL_PATH_REPARSE"
    Return
  check_type:
    IntOp $1 $0 & 0x10
    IntCmp $1 $expectedType done_path
    StrCpy $failure "SHELL_PATH_TYPE_INVALID"
    Return
  missing_path:
    StrCpy $failure "SHELL_PATH_MISSING"
  done_path:
FunctionEnd

; Check one relative object while keeping only its safe, validated entity in diagnostics.
!macro CheckObject RELATIVE TYPE
  StrCpy $relativeEntity "${RELATIVE}"
  StrCpy $checkedPath "$EXEDIR\${RELATIVE}"
  StrCpy $expectedType ${TYPE}
  Call CheckPath
  StrCmp $failure "" 0 failed
!macroend

; All launchable version references must retain a normal directory and executable.
!macro CheckShell ID
  !insertmacro CheckObject "shells\${ID}" 16
  !insertmacro CheckObject "shells\${ID}\CodeFlowAI.exe" 0
!macroend

; Close each newly created handle without hiding a prior cleanup failure.
!macro CloseCreatedHandle HANDLE
  System::Call 'kernel32::CloseHandle(p ${HANDLE}) i.r6 ?e'
  Pop $7
  ${If} $6 == 0
    ${If} $failure == ""
      StrCpy $failure "SHELL_PROCESS_HANDLE_CLOSE_FAILED"
      StrCpy $win32Error $7
    ${Else}
      StrCpy $cleanupWin32Error $7
    ${EndIf}
  ${EndIf}
!macroend

; Await lifecycle completion and preserve its exit code; ordinary opening stays asynchronous.
Function LaunchShell
  ; One zeroed x86 buffer holds STARTUPINFOW (68 bytes) and PROCESS_INFORMATION (16 bytes).
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 84) p.r0 ?e'
  Pop $win32Error
  ${If} $0 == 0
    StrCpy $failure "SHELL_PROCESS_ALLOCATION_FAILED"
    Return
  ${EndIf}
  System::Call '*$0(i 68)'
  IntOp $1 $0 + 68
  StrCpy $2 '$\"$checkedPath$\" $arguments'
  System::Call 'kernel32::CreateProcessW(w "$checkedPath", w r2, p 0, p 0, i 0, i 0, p 0, p 0, p r0, p r1) i.r3 ?e'
  Pop $win32Error
  ${If} $3 == 0
    StrCpy $failure "SHELL_EXEC_FAILED"
  ${Else}
    StrCpy $processCreated true
    StrCpy $win32Error 0
    System::Call '*$1(p .r4, p .r5)'
    !insertmacro CloseCreatedHandle r5
    ${If} $lifecycleCall == true
      StrCpy $stage "lifecycle-wait"
      System::Call 'kernel32::WaitForSingleObject(p r4, i -1) i.r3 ?e'
      Pop $7
      ${If} $3 != 0
        ${If} $failure == ""
          StrCpy $failure "LIFECYCLE_WAIT_FAILED"
          StrCpy $win32Error $7
        ${Else}
          StrCpy $cleanupWin32Error $7
        ${EndIf}
      ${Else}
        StrCpy $stage "lifecycle-result"
        System::Call 'kernel32::GetExitCodeProcess(p r4, *i .r2) i.r3 ?e'
        Pop $7
        ${If} $3 == 0
          ${If} $failure == ""
            StrCpy $failure "LIFECYCLE_RESULT_FAILED"
            StrCpy $win32Error $7
          ${Else}
            StrCpy $cleanupWin32Error $7
          ${EndIf}
        ${Else}
          StrCpy $lifecycleExitCode $2
        ${EndIf}
      ${EndIf}
    ${EndIf}
    !insertmacro CloseCreatedHandle r4
  ${EndIf}
  System::Call 'kernel32::GlobalFree(p r0) p.r6 ?e'
  Pop $7
  ${If} $6 != 0
    ${If} $failure == ""
      StrCpy $failure "SHELL_PROCESS_ALLOCATION_RELEASE_FAILED"
      StrCpy $win32Error $7
    ${Else}
      StrCpy $cleanupWin32Error $7
    ${EndIf}
  ${EndIf}
FunctionEnd

; Record one fixed diagnostic without dialogs; a log failure remains a failed launch.
Function Fail
  StrCmp $requestId "" 0 have_request
  System::Alloc 16
  Pop $0
  System::Call 'ole32::CoCreateGuid(p r0) i.r1'
  ${If} $1 == 0
    System::Call 'ole32::StringFromGUID2(p r0, w .r2, i 40) i.r1'
    StrCpy $requestId $2 36 1
  ${EndIf}
  System::Free $0
  StrCmp $requestId "" log_failed
  have_request:
  System::Call 'kernel32::GetFileAttributesW(w "$EXEDIR\shell-launch-errors.jsonl") i.r0 ?e'
  Pop $1
  ${If} $0 == -1
    IntCmp $1 2 open_log log_failed log_failed
  ${Else}
    IntOp $1 $0 & 0x410
    IntCmp $1 0 open_log log_failed log_failed
  ${EndIf}
  open_log:
  ClearErrors
  FileOpen $0 "$EXEDIR\shell-launch-errors.jsonl" a
  IfErrors log_failed
  FileSeek $0 0 END
  IfErrors close_failed
  ; Entity uses forward slashes because validated IDs and fixed segments contain no JSON escapes.
  StrCpy $1 ""
  StrCpy $2 0
  entity_loop:
    StrCpy $3 $relativeEntity 1 $2
    StrCmp $3 "" entity_done
    StrCmp $3 "\" 0 entity_append
      StrCpy $3 "/"
    entity_append:
      StrCpy $1 "$1$3"
      IntOp $2 $2 + 1
      Goto entity_loop
  entity_done:
  StrCpy $relativeEntity $1
  StrCpy $2 ""
  StrCmp $cleanupWin32Error "" no_cleanup_error
    StrCpy $2 ',"cleanupWin32Error":$cleanupWin32Error'
  no_cleanup_error:
  FileWrite $0 '{"errorCode":"DESKTOP_SHELL_LAUNCH_FAILED","requestId":"$requestId","activeId":"$activeId","stage":"$stage","relativeEntity":"$relativeEntity","win32Error":$win32Error,"processCreated":$processCreated,"rootCause":"$failure"$2}$\r$\n'
  IfErrors close_failed
  System::Call 'kernel32::FlushFileBuffers(p r0) i.r6'
  ${If} $6 == 0
    Goto close_failed
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0) i.r6'
  ${If} $6 == 0
    Goto log_failed
  ${EndIf}
  SetErrorLevel 1
  Quit
  close_failed:
    System::Call 'kernel32::CloseHandle(p r0) i.r6'
  log_failed:
    SetErrorLevel 2
    Quit
FunctionEnd

Section
  StrCpy $stage "command-line"
  StrCpy $win32Error 0
  StrCpy $processCreated false
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'kernel32::lstrlenW(p r0) i.r1'
  IntCmp $1 ${NSIS_MAX_STRLEN} command_too_long command_valid command_too_long
  command_valid:
  ${GetParameters} $arguments
  Call ReadLifecycleArguments
  StrCmp $failure "" 0 command_parse_failed
  ; The selected executable can be up to 148 characters longer than the launcher.
  StrLen $0 "$EXEDIR"
  StrLen $1 $arguments
  IntOp $0 $0 + $1
  IntOp $0 $0 + 160
  IntCmp $0 ${NSIS_MAX_STRLEN} command_too_long command_fits command_too_long
  command_fits:
  StrCpy $stage "state"
  StrCpy $relativeEntity "installation-root"
  StrCpy $checkedPath "$EXEDIR"
  StrCpy $expectedType 16
  Call CheckPath
  StrCmp $failure "" 0 failed
  !insertmacro CheckObject "shell-launch.ini" 0
  System::Call 'kernel32::CreateFileW(w "$checkedPath", i 0x80000000, i 1, p 0, i 3, i 0x00200080, p 0) p.r8 ?e'
  Pop $win32Error
  IntCmp $8 -1 state_open_failed
  StrCpy $stateFile $8
  StrCpy $win32Error 0
  Push "[shell]$\r$\nschema=1$\r$\nactive="
  Call ReadLiteral
  StrCmp $failure "" 0 state_failed
  Call ReadId
  StrCmp $failure "" 0 state_failed
  StrCmp $parsedId "" state_format_failed
  StrCpy $activeId $parsedId
  Push "previous="
  Call ReadLiteral
  StrCmp $failure "" 0 state_failed
  Call ReadId
  StrCmp $failure "" 0 state_failed
  StrCpy $previousId $parsedId
  Push "baseline="
  Call ReadLiteral
  StrCmp $failure "" 0 state_failed
  Call ReadId
  StrCmp $failure "" 0 state_failed
  StrCmp $parsedId "" state_format_failed
  StrCpy $baselineId $parsedId
  Call ReadStateByte
  StrCmp $failure "" 0 state_failed
  IntCmp $byte -1 state_read state_format_failed state_format_failed
  state_read:
    Call CloseState
    StrCmp $failure "" 0 failed
    StrCpy $stage "layout"
    !insertmacro CheckObject "shells" 16
    !insertmacro CheckShell "$activeId"
    StrCmp $previousId "" no_previous
      !insertmacro CheckShell "$previousId"
    no_previous:
    !insertmacro CheckShell "$baselineId"
    !insertmacro CheckObject "shells\$baselineId\resources" 16
    !insertmacro CheckObject "shells\$baselineId\resources\web" 16
    !insertmacro CheckObject "shells\$baselineId\resources\web\index.html" 0
    !insertmacro CheckObject "shells\$baselineId\resources\client" 16
    !insertmacro CheckObject "shells\$baselineId\resources\client\dist" 16
    !insertmacro CheckObject "shells\$baselineId\resources\client\dist\index.cjs" 0
    !insertmacro CheckObject "shells\$baselineId\resources\release-trust.json" 0
    StrCpy $stage "execute"
    StrCpy $relativeEntity "shells\$activeId\CodeFlowAI.exe"
    StrCpy $checkedPath "$EXEDIR\$relativeEntity"
    Call LaunchShell
    StrCmp $failure "" 0 failed
    SetErrorLevel $lifecycleExitCode
    Quit
  state_format_failed:
    StrCpy $failure "STATE_FORMAT_INVALID"
  state_failed:
    Call CloseState
    Goto failed
  state_open_failed:
    StrCpy $failure "STATE_OPEN_FAILED"
    Goto failed
  command_too_long:
    StrCpy $relativeEntity "command-line"
    StrCpy $failure "COMMAND_LINE_TOO_LONG"
    Goto failed
  command_parse_failed:
    StrCpy $relativeEntity "command-line"
  failed:
    Call Fail
SectionEnd
