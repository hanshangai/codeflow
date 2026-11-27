Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "CodeFlow shell switch"
OutFile "${OUTPUT_FILE}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!if ${NSIS_PTR_SIZE} != 4
  !error "Shell switch requires the existing x86 NSIS stub"
!endif
!ifndef SHELL_READY_WAIT_MS
  !define SHELL_READY_WAIT_MS 30000
!endif
!ifndef SWITCH_WAIT_MS
  !define SWITCH_WAIT_MS 30000
!endif

Var root
Var previous
Var target
Var oldPid
Var requestId
Var requestedId
Var argv
Var rootHandle
Var journal
Var oldHandle
Var oldExited
Var stateHandle
Var originalState
Var baseline
Var originalPrevious
Var temporary
Var backup
Var phase
Var failure
Var win32Error
Var cleanupError
Var processExitCode
Var committed
Var launched
Var checkedPath
Var expectedType
Var id
Var candidateHandle
Var candidateThread
Var candidatePid
Var readyPipe
Var readyBuffer
Var readyElapsed
Var readyStarted
Var readyConnected
Var selectionPath
Var userData
Var sessionData
Var userDataHandle
Var sessionDataHandle
Var directoryPath
Var directoryHandle
Var quotedPath
Var quotedUserData
Var quotedSessionData

; Copy one bounded native argument; parser never truncates an accepted value.
!macro ReadArgument INDEX DESTINATION
  IntOp $0 ${INDEX} * 4
  IntOp $0 $argv + $0
  System::Call '*$0(p .r1)'
  System::Call 'kernel32::lstrlenW(p r1) i.r2'
  IntCmp $2 ${NSIS_MAX_STRLEN} arguments_invalid +1 arguments_invalid
  System::Call 'kernel32::lstrcpynW(w .r0, p r1, i ${NSIS_MAX_STRLEN}) p'
  StrCpy ${DESTINATION} $0
!macroend

; Validate the same portable single-directory IDs as the fixed launcher, including Windows device names.
Function ValidateId
  StrLen $0 $id
  IntCmp $0 1 +1 invalid_id +1
  IntCmp $0 128 +1 +1 invalid_id
  StrCpy $1 0
  id_character:
    StrCpy $2 $id 1 $1
    StrCmp $2 "" id_complete
    StrCpy $3 "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    ${If} $1 != 0
      StrCpy $3 "$3._-"
    ${EndIf}
    StrCpy $4 0
  id_allowed:
    StrCpy $6 $3 1 $4
    StrCmp $6 "" invalid_id
    StrCmpS $6 $2 id_append
    IntOp $4 $4 + 1
    Goto id_allowed
  id_append:
    IntOp $1 $1 + 1
    Goto id_character
  id_complete:
    StrCpy $2 $id 1 -1
    StrCmp $2 "." invalid_id
    ${WordFind} "$id" "." "+1" $5
    StrCmp $5 CON invalid_id
    StrCmp $5 PRN invalid_id
    StrCmp $5 AUX invalid_id
    StrCmp $5 NUL invalid_id
    StrLen $0 $5
    IntCmp $0 4 0 id_valid id_valid
    StrCpy $2 $5 3
    StrCmp $2 COM device_number
    StrCmp $2 LPT device_number id_valid
  device_number:
    StrCpy $2 $5 1 3
    IntCmp $2 1 invalid_id id_valid +1
    IntCmp $2 9 invalid_id invalid_id id_valid
  invalid_id:
    StrCpy $failure ID_INVALID
  id_valid:
FunctionEnd

; Restart only the exact original selection after the old and candidate processes are gone.
Function RestartOriginal
  StrCpy $R5 $failure
  StrCpy $R6 $win32Error
  StrCpy $failure ""
  StrCpy $selectionPath "$root\shell-launch.ini"
  Call ReadSelection
  StrCpy $0 "[shell]$\r$\nschema=1$\r$\nactive=$previous$\r$\nprevious=$originalPrevious$\r$\nbaseline=$baseline$\r$\n"
  StrCmp $failure "" 0 restart_failed
  StrCmpS $0 $originalState 0 restart_failed
  StrCpy $checkedPath "$root\shells"
  StrCpy $expectedType 16
  Call CheckPath
  StrCmp $failure "" 0 restart_failed
  StrCpy $checkedPath "$root\shells\$previous"
  StrCpy $expectedType 16
  Call CheckPath
  StrCmp $failure "" 0 restart_failed
  StrCpy $checkedPath "$root\shells\$previous\CodeFlowAI.exe"
  StrCpy $expectedType 0
  Call CheckPath
  StrCmp $failure "" 0 restart_failed
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 84) p.r0'
  StrCmp $0 0 restart_failed
  System::Call '*$0(i 68)'
  IntOp $1 $0 + 68
  StrCpy $2 '$\"$checkedPath$\" $\"--user-data-dir=$quotedUserData$\" $\"--codeflow-session-data-dir=$quotedSessionData$\"'
  System::Call 'kernel32::CreateProcessW(w "$checkedPath", w r2, p 0, p 0, i 0, i 0, p 0, w "$root\shells\$previous", p r0, p r1) i.r3 ?e'
  Pop $cleanupError
  ${If} $3 != 0
    System::Call '*$1(p .r4, p .r5)'
    System::Call 'kernel32::CloseHandle(p r5) i.r1 ?e'
    Pop $R7
    System::Call 'kernel32::CloseHandle(p r4) i.r2 ?e'
    Pop $cleanupError
    ${If} $1 == 0
      StrCpy $cleanupError $R7
    ${ElseIf} $2 != 0
      StrCpy $cleanupError 0
    ${EndIf}
  ${EndIf}
  System::Free $0
  StrCmp $3 0 restart_failed restart_done
  restart_failed:
    StrCpy $phase restart-failed
    ${If} $cleanupError == 0
      StrCpy $cleanupError $win32Error
    ${EndIf}
  restart_done:
    StrCpy $failure $R5
    StrCpy $win32Error $R6
FunctionEnd

; Check ordinary file/directory entities without following reparse points.
Function CheckPath
  System::Call 'kernel32::GetFileAttributesW(w "$checkedPath") i.r0 ?e'
  Pop $win32Error
  IntCmp $0 -1 path_failed
  IntOp $1 $0 & 0x410
  IntCmp $1 $expectedType path_valid
  path_failed:
    StrCpy $failure PATH_INVALID
    Return
  path_valid:
    StrCpy $win32Error 0
FunctionEnd

; Validate each fixed relative path before state reads, replacement or executable launch.
!macro CheckObject RELATIVE TYPE
  StrCpy $checkedPath "$root\${RELATIVE}"
  StrCpy $expectedType ${TYPE}
  Call CheckPath
  StrCmp $failure "" 0 failed
!macroend

; Read the existing strict ASCII/CRLF selection, preserving original previous and baseline bytes.
Function ReadSelection
  StrCpy $checkedPath $selectionPath
  StrCpy $expectedType 0
  Call CheckPath
  StrCmp $failure "" 0 state_done
  ClearErrors
  System::Call 'kernel32::CreateFileW(w "$selectionPath", i 0x80000000, i 1, p 0, i 3, i 0x00200080, p 0) p.s ?e'
  Pop $win32Error
  Pop $stateHandle
  IntCmp $stateHandle -1 state_open_failed
  StrCpy $0 $stateHandle
  Call CheckHeldEntity
  StrCmp $failure "" 0 state_close
  FileRead $stateHandle $0 160
  StrCmpS $0 "[shell]$\r$\n" 0 state_invalid
  FileRead $stateHandle $0 160
  StrCmpS $0 "schema=1$\r$\n" 0 state_invalid
  FileRead $stateHandle $0 160
  StrCmpS $0 "active=$previous$\r$\n" 0 state_invalid
  FileRead $stateHandle $0 160
  StrCpy $1 $0 9
  StrCmpS $1 "previous=" 0 state_invalid
  StrCpy $originalPrevious $0 -2 9
  StrCmpS $0 "previous=$originalPrevious$\r$\n" 0 state_invalid
  ${If} $originalPrevious != ""
    StrCpy $id $originalPrevious
    Call ValidateId
    StrCmp $failure "" 0 state_close
  ${EndIf}
  FileRead $stateHandle $0 160
  StrCpy $1 $0 9
  StrCmpS $1 "baseline=" 0 state_invalid
  StrCpy $baseline $0 -2 9
  StrCmpS $0 "baseline=$baseline$\r$\n" 0 state_invalid
  StrCpy $id $baseline
  Call ValidateId
  StrCmp $failure "" 0 state_close
  ClearErrors
  FileRead $stateHandle $0 1
  IfErrors state_close state_invalid
  state_invalid:
    StrCpy $failure STATE_INVALID
  state_close:
    System::Call 'kernel32::CloseHandle(p $stateHandle) i.r0 ?e'
    Pop $win32Error
    ${If} $0 == 0
      StrCpy $failure STATE_CLOSE_FAILED
    ${EndIf}
    Return
  state_open_failed:
    StrCpy $failure STATE_OPEN_FAILED
  state_done:
FunctionEnd

; Write one durable diagnostic transaction; this journal never supplies the active shell selection.
Function WriteJournal
  ${If} $failure == ""
    StrCpy $win32Error 0
  ${EndIf}
  ClearErrors
  System::Call 'kernel32::SetFilePointer(p $journal, i 0, p 0, i 0) i.r0 ?e'
  Pop $R1
  ${If} $0 != 0
    StrCpy $win32Error $R1
    StrCpy $failure JOURNAL_SEEK_FAILED
    Return
  ${EndIf}
  System::Call 'kernel32::SetEndOfFile(p $journal) i.r0 ?e'
  Pop $R1
  ${If} $0 == 0
    StrCpy $win32Error $R1
    StrCpy $failure JOURNAL_TRUNCATE_FAILED
    Return
  ${EndIf}
  FileWrite $journal '[switch]$\r$\nschema=1$\r$\nrequestId=$requestId$\r$\nfrom=$previous$\r$\nto=$target$\r$\nphase=$phase$\r$\nerrorCode=$failure$\r$\nwin32Error=$win32Error$\r$\ncleanupError=$cleanupError$\r$\nprocessExitCode=$processExitCode$\r$\ncandidatePid=$candidatePid$\r$\n'
  IfErrors journal_write_failed
  System::Call 'kernel32::FlushFileBuffers(p $journal) i.r0 ?e'
  Pop $R1
  ${If} $0 == 0
    StrCpy $win32Error $R1
    StrCpy $failure JOURNAL_FLUSH_FAILED
  ${EndIf}
  Return
  journal_write_failed:
    StrCpy $failure JOURNAL_WRITE_FAILED
FunctionEnd

; Verify the actual held entity type; ordinary files must also have exactly one hard link.
Function CheckHeldEntity
  System::Alloc 52
  Pop $1
  ${If} $1 == 0
    StrCpy $failure FILE_INFORMATION_ALLOCATION_FAILED
    Return
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p r1) i.r2 ?e'
  Pop $win32Error
  ${If} $2 == 0
    StrCpy $failure FILE_IDENTITY_FAILED
  ${Else}
    System::Call '*$1(i .r2)'
    IntOp $2 $2 & 0x410
    ${If} $2 != $expectedType
      StrCpy $failure FILE_IDENTITY_INVALID
    ${EndIf}
    IntOp $2 $1 + 40
    System::Call '*$2(i .r3)'
    ${If} $expectedType == 0
    ${AndIf} $3 != 1
      StrCpy $failure FILE_LINK_COUNT_INVALID
    ${EndIf}
  ${EndIf}
  System::Free $1
FunctionEnd

; Resolve and hold an ordinary absolute directory, checking every ancestor and the final handle path.
Function ValidateDirectory
  StrCpy $directoryPath $checkedPath
  StrCpy $directoryHandle 0
  StrLen $0 $directoryPath
  IntCmp $0 3 +1 directory_invalid +1
  StrCpy $0 $directoryPath 2 1
  StrCmp $0 ":\" 0 directory_invalid
  System::Call 'kernel32::GetFullPathNameW(w "$directoryPath", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0 ?e'
  Pop $win32Error
  IntCmp $0 0 directory_invalid directory_invalid
  IntCmp $0 ${NSIS_MAX_STRLEN} directory_invalid +1 directory_invalid
  StrCmp $1 $directoryPath 0 directory_invalid
  StrCpy $expectedType 16
  directory_ancestor:
    Call CheckPath
    StrCmp $failure "" 0 directory_done
    StrLen $0 $checkedPath
    IntCmp $0 3 directory_open directory_open
    ${GetParent} "$checkedPath" $checkedPath
    StrLen $0 $checkedPath
    ${If} $0 == 2
      StrCpy $checkedPath "$checkedPath\"
    ${EndIf}
    Goto directory_ancestor
  directory_open:
    System::Call 'kernel32::CreateFileW(w "$directoryPath", i 0x80, i 3, p 0, i 3, i 0x02200000, p 0) p.s ?e'
    Pop $win32Error
    Pop $directoryHandle
    ${If} $directoryHandle == -1
      StrCpy $directoryHandle 0
      Goto directory_invalid
    ${EndIf}
    StrCpy $0 $directoryHandle
    Call CheckHeldEntity
    StrCmp $failure "" 0 directory_done
    System::Call 'kernel32::GetFinalPathNameByHandleW(p $directoryHandle, w .r1, i ${NSIS_MAX_STRLEN}, i 0) i.r0 ?e'
    Pop $win32Error
    IntCmp $0 0 directory_invalid directory_invalid
    IntCmp $0 ${NSIS_MAX_STRLEN} directory_invalid +1 directory_invalid
    StrCmp $1 "\\?\$directoryPath" directory_done
    StrCpy $R0 $directoryPath
  directory_trailing_separator:
    StrLen $0 $R0
    IntCmp $0 3 directory_invalid directory_invalid
    StrCpy $0 $R0 1 -1
    StrCmp $0 "\" 0 directory_invalid
    StrCpy $R0 $R0 -1
    StrCmp $1 "\\?\$R0" directory_done directory_trailing_separator
  directory_invalid:
    StrCpy $failure DIRECTORY_PATH_INVALID
  directory_done:
FunctionEnd

; Windows quoted argv doubles each trailing backslash so the closing quote stays a delimiter.
Function QuoteDirectory
  StrLen $0 $quotedPath
  quote_tail:
    IntOp $0 $0 - 1
    IntCmp $0 0 quote_index quote_done quote_index
  quote_index:
    StrCpy $1 $quotedPath 1 $0
    StrCmp $1 "\" 0 quote_done
    StrCpy $quotedPath "$quotedPath\"
    Goto quote_tail
  quote_done:
FunctionEnd

; Close exactly owned handles; cleanup failure remains a failed result.
!macro CloseHandle HANDLE
  ${If} ${HANDLE} != 0
    System::Call 'kernel32::CloseHandle(p ${HANDLE}) i.r0 ?e'
    Pop $R1
    ${If} $0 == 0
      StrCpy $cleanupError $R1
      SetErrorLevel 2
    ${EndIf}
  ${EndIf}
!macroend

Section
  StrCpy $phase requested
  StrCpy $win32Error 0
  StrCpy $cleanupError 0
  StrCpy $processExitCode 0
  StrCpy $rootHandle 0
  StrCpy $journal 0
  StrCpy $oldHandle 0
  StrCpy $oldExited false
  StrCpy $userDataHandle 0
  StrCpy $sessionDataHandle 0
  StrCpy $committed false
  StrCpy $launched false
  StrCpy $readyPipe 0
  StrCpy $readyBuffer 0
  StrCpy $candidateHandle 0
  StrCpy $candidateThread 0
  StrCpy $candidatePid 0
  System::Alloc 16
  Pop $0
  System::Call 'ole32::CoCreateGuid(p r0) i.r1'
  ${If} $1 == 0
    System::Call 'ole32::StringFromGUID2(p r0, w .r2, i 40) i.r1'
    StrCpy $requestId $2 36 1
  ${EndIf}
  System::Free $0
  StrCmp $requestId "" request_failed
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'kernel32::lstrlenW(p r0) i.r1'
  IntCmp $1 ${NSIS_MAX_STRLEN} arguments_invalid +1 arguments_invalid
  System::Call 'shell32::CommandLineToArgvW(p r0, *i .r1) p.s'
  Pop $argv
  StrCmp $argv 0 arguments_invalid
  IntCmp $1 15 +1 arguments_invalid arguments_invalid
  !insertmacro ReadArgument 1 $3
  StrCmpS $3 "--root" 0 arguments_invalid
  !insertmacro ReadArgument 2 $root
  !insertmacro ReadArgument 3 $3
  StrCmpS $3 "--previous" 0 arguments_invalid
  !insertmacro ReadArgument 4 $previous
  !insertmacro ReadArgument 5 $3
  StrCmpS $3 "--target" 0 arguments_invalid
  !insertmacro ReadArgument 6 $target
  !insertmacro ReadArgument 7 $3
  StrCmpS $3 "--pid" 0 arguments_invalid
  !insertmacro ReadArgument 8 $oldPid
  !insertmacro ReadArgument 9 $3
  StrCmpS $3 "--request-id" 0 arguments_invalid
  !insertmacro ReadArgument 10 $requestedId
  !insertmacro ReadArgument 11 $3
  StrCmpS $3 "--user-data-dir" 0 arguments_invalid
  !insertmacro ReadArgument 12 $userData
  !insertmacro ReadArgument 13 $3
  StrCmpS $3 "--session-data-dir" 0 arguments_invalid
  !insertmacro ReadArgument 14 $sessionData
  System::Call 'kernel32::LocalFree(p $argv) p.r0'
  StrCpy $argv 0
  StrCmp $0 0 +2
    Goto arguments_invalid
  StrCpy $id $previous
  Call ValidateId
  StrCmp $failure "" 0 failed
  StrCpy $id $target
  Call ValidateId
  StrCmp $failure "" 0 failed
  StrCmp $previous $target arguments_invalid
  StrLen $0 $requestedId
  IntCmp $0 36 +1 arguments_invalid arguments_invalid
  StrCpy $0 0
  uuid_character:
    StrCpy $1 $requestedId 1 $0
    StrCmp $1 "" uuid_valid
    ${If} $0 == 8
    ${OrIf} $0 == 13
    ${OrIf} $0 == 18
    ${OrIf} $0 == 23
      StrCmp $1 "-" uuid_next arguments_invalid
    ${EndIf}
    StrCpy $2 "0123456789abcdefABCDEF"
    StrCpy $3 0
  uuid_allowed:
    StrCpy $4 $2 1 $3
    StrCmp $4 "" arguments_invalid
    StrCmpS $4 $1 uuid_next
    IntOp $3 $3 + 1
    Goto uuid_allowed
  uuid_next:
    IntOp $0 $0 + 1
    Goto uuid_character
  uuid_valid:
    StrCpy $requestId $requestedId
    StrLen $0 $oldPid
    IntCmp $0 1 +1 arguments_invalid +1
    IntCmp $0 10 pid_bounded pid_characters arguments_invalid
  pid_bounded:
    System::Call 'kernel32::CompareStringOrdinal(w "$oldPid", i -1, w "4294967294", i -1, i 1) i.r0'
    IntCmp $0 3 arguments_invalid pid_characters arguments_invalid
  pid_characters:
    StrCpy $1 $oldPid 1
    StrCmp $1 "0" arguments_invalid
    StrCpy $0 0
  pid_character:
    StrCpy $1 $oldPid 1 $0
    StrCmp $1 "" pid_valid
    StrCpy $2 "0123456789"
    StrCpy $3 0
  pid_allowed:
    StrCpy $4 $2 1 $3
    StrCmp $4 "" arguments_invalid
    StrCmpS $4 $1 pid_next
    IntOp $3 $3 + 1
    Goto pid_allowed
  pid_next:
    IntOp $0 $0 + 1
    Goto pid_character
  pid_valid:
    StrLen $0 $root
    IntCmp $0 3 arguments_invalid arguments_invalid +1
    StrCpy $0 $root 2 1
    StrCmp $0 ":\" 0 arguments_invalid
    StrCpy $checkedPath $root
    Call ValidateDirectory
    StrCpy $rootHandle $directoryHandle
    StrCmp $failure "" 0 failed
    StrCpy $checkedPath $userData
    Call ValidateDirectory
    StrCpy $userDataHandle $directoryHandle
    StrCmp $failure "" 0 failed
    StrCpy $checkedPath $sessionData
    Call ValidateDirectory
    StrCpy $sessionDataHandle $directoryHandle
    StrCmp $failure "" 0 failed
    StrCpy $quotedPath $userData
    Call QuoteDirectory
    StrCpy $quotedUserData $quotedPath
    StrCpy $quotedPath $sessionData
    Call QuoteDirectory
    StrCpy $quotedSessionData $quotedPath
    StrLen $0 $root
    StrLen $1 $quotedUserData
    IntOp $0 $0 + $1
    StrLen $1 $quotedSessionData
    IntOp $0 $0 + $1
    IntOp $0 $0 + 320
    IntCmp $0 ${NSIS_MAX_STRLEN} arguments_invalid +1 arguments_invalid
    !insertmacro CheckObject "shells" 16
    !insertmacro CheckObject "shells\$previous" 16
    !insertmacro CheckObject "shells\$previous\CodeFlowAI.exe" 0
    !insertmacro CheckObject "shells\$target" 16
    !insertmacro CheckObject "shells\$target\CodeFlowAI.exe" 0
    StrCpy $selectionPath "$root\shell-launch.ini"
    Call ReadSelection
    StrCmp $failure "" 0 failed
    StrCpy $originalState "[shell]$\r$\nschema=1$\r$\nactive=$previous$\r$\nprevious=$originalPrevious$\r$\nbaseline=$baseline$\r$\n"
    System::Call 'kernel32::CreateFileW(w "$root\shell-switch.ini", i 0xC0000000, i 1, p 0, i 4, i 0x00200080, p 0) p.s ?e'
    Pop $win32Error
    Pop $journal
    IntCmp $journal -1 journal_open_failed
    StrCpy $0 $journal
    Call CheckHeldEntity
    StrCmp $failure "" 0 failed
    Call WriteJournal
    StrCmp $failure "" 0 failed
    System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i $oldPid) p.s ?e'
    Pop $win32Error
    Pop $oldHandle
    ${If} $oldHandle == 0
      IntCmp $win32Error 87 old_exited old_open_failed old_open_failed
    ${EndIf}
    System::Call 'kernel32::QueryFullProcessImageNameW(p $oldHandle, i 0, w .r1, *i ${NSIS_MAX_STRLEN}) i.r0 ?e'
    Pop $win32Error
    ${If} $0 == 0
      StrCpy $failure OLD_PROCESS_PATH_FAILED
      Goto failed
    ${EndIf}
    StrCmp $1 "$root\shells\$previous\CodeFlowAI.exe" 0 old_path_invalid
    StrCpy $phase waiting
    Call WriteJournal
    StrCmp $failure "" 0 failed
    System::Call 'kernel32::WaitForSingleObject(p $oldHandle, i ${SWITCH_WAIT_MS}) i.r0 ?e'
    Pop $win32Error
    IntCmp $0 0 old_exited
    StrCpy $failure OLD_PROCESS_WAIT_FAILED
    ${If} $0 == 258
      StrCpy $failure OLD_PROCESS_TIMEOUT
    ${EndIf}
    Goto failed
  old_exited:
    StrCpy $oldExited true
    Call ReadSelection
    StrCmp $failure "" 0 failed
    StrCpy $0 "[shell]$\r$\nschema=1$\r$\nactive=$previous$\r$\nprevious=$originalPrevious$\r$\nbaseline=$baseline$\r$\n"
    StrCmpS $0 $originalState 0 state_changed
    StrCpy $temporary "$root\shell-launch.ini.$requestId.tmp"
    StrCpy $backup "$root\shell-launch.ini.$requestId.bak"
    System::Call 'kernel32::GetFileAttributesW(w "$backup") i.r0 ?e'
    Pop $win32Error
    IntCmp $0 -1 +1 backup_exists backup_exists
    IntCmp $win32Error 2 +1 backup_exists backup_exists
    System::Call 'kernel32::CreateFileW(w "$temporary", i 0xC0000000, i 0, p 0, i 1, i 0x00200080, p 0) p.s ?e'
    Pop $win32Error
    Pop $stateHandle
    IntCmp $stateHandle -1 temporary_failed
    StrCpy $0 $stateHandle
    Call CheckHeldEntity
    StrCmp $failure "" 0 temporary_close_failed
    ClearErrors
    FileWrite $stateHandle "[shell]$\r$\nschema=1$\r$\nactive=$target$\r$\nprevious=$previous$\r$\nbaseline=$baseline$\r$\n"
    IfErrors temporary_close_failed
    System::Call 'kernel32::FlushFileBuffers(p $stateHandle) i.r0'
    IntCmp $0 0 temporary_close_failed
    System::Call 'kernel32::CloseHandle(p $stateHandle) i.r0'
    StrCpy $stateHandle 0
    IntCmp $0 0 temporary_failed
    StrCpy $phase prepared
    Call WriteJournal
    StrCmp $failure "" 0 failed
    ; First-instance local pipe prevents stale ownership; client identity is checked against CreateProcess PID.
    System::Call 'kernel32::CreateNamedPipeW(w "\\.\pipe\codeflow-shell-ready-$requestId", i 0x80003, i 9, i 1, i 128, i 128, i 0, p 0) p.s ?e'
    Pop $win32Error
    Pop $readyPipe
    ${If} $readyPipe == -1
      StrCpy $readyPipe 0
      StrCpy $failure READY_PIPE_CREATE_FAILED
      Goto failed
    ${EndIf}
    !insertmacro CheckObject "shell-launch.ini" 0
    !insertmacro CheckObject "shells" 16
    !insertmacro CheckObject "shells\$target" 16
    !insertmacro CheckObject "shells\$target\CodeFlowAI.exe" 0
    System::Call 'kernel32::GlobalAlloc(i 0x40, p 84) p.r0'
    StrCmp $0 0 allocation_failed
    System::Call '*$0(i 68)'
    IntOp $1 $0 + 68
    StrCpy $2 '$\"$root\shells\$target\CodeFlowAI.exe$\" $\"--user-data-dir=$quotedUserData$\" $\"--codeflow-session-data-dir=$quotedSessionData$\" --codeflow-shell-ready=$requestId'
    System::Call 'kernel32::CreateProcessW(w "$root\shells\$target\CodeFlowAI.exe", w r2, p 0, p 0, i 0, i 0, p 0, w "$root\shells\$target", p r0, p r1) i.r3 ?e'
    Pop $win32Error
    ${If} $3 != 0
      System::Call '*$1(p .r4, p .r5, i .r6)'
      StrCpy $candidateHandle $4
      StrCpy $candidateThread $5
      StrCpy $candidatePid $6
    ${EndIf}
    System::Free $0
    IntCmp $3 0 launch_failed
    Call WriteJournal
    StrCmp $failure "" 0 stop_candidate
    System::Call 'kernel32::GlobalAlloc(i 0x40, p 128) p.s'
    Pop $readyBuffer
    StrCmp $readyBuffer 0 ready_allocation_failed
    StrCpy $readyElapsed 0
    System::Call 'kernel32::GetTickCount() i.s'
    Pop $readyStarted
    StrCpy $readyConnected false
  wait_ready:
    System::Call 'kernel32::WaitForSingleObject(p $candidateHandle, i 0) i.r0 ?e'
    Pop $win32Error
    ${If} $0 == 0
      System::Call 'kernel32::GetExitCodeProcess(p $candidateHandle, *i .r1) i.r0 ?e'
      Pop $win32Error
      StrCpy $processExitCode $1
      StrCpy $failure TARGET_EXITED_EARLY
      ${If} $0 == 0
        StrCpy $failure TARGET_RESULT_FAILED
      ${EndIf}
      Goto stop_candidate
    ${ElseIf} $0 != 258
      StrCpy $failure TARGET_WAIT_FAILED
      Goto stop_candidate
    ${EndIf}
    ${If} $readyConnected != true
      System::Call 'kernel32::ConnectNamedPipe(p $readyPipe, p 0) i.r0 ?e'
      Pop $win32Error
      ${If} $0 != 0
      ${OrIf} $win32Error == 535
        StrCpy $readyConnected true
        System::Call 'kernel32::GetNamedPipeClientProcessId(p $readyPipe, *i .r1) i.r0 ?e'
        Pop $win32Error
        ${If} $0 == 0
        ${OrIf} $1 != $candidatePid
          StrCpy $failure TARGET_READY_IDENTITY_INVALID
          Goto stop_candidate
        ${EndIf}
      ${ElseIf} $win32Error != 536
        StrCpy $failure TARGET_READY_CONNECT_FAILED
        Goto stop_candidate
      ${EndIf}
    ${EndIf}
    ${If} $readyConnected == true
      System::Call 'kernel32::ReadFile(p $readyPipe, p $readyBuffer, i 128, *i .r2, p 0) i.r0 ?e'
      Pop $win32Error
      ${If} $0 != 0
      ${AndIf} $2 > 0
        System::Call 'kernel32::MultiByteToWideChar(i 20127, i 0, p $readyBuffer, i r2, w .r1, i 128) i.r0'
        StrCpy $3 "$requestId:$candidatePid$\r$\n"
        StrLen $4 $3
        ${If} $0 != $4
        ${OrIf} $2 != $4
        ${OrIf} $1 != $3
          StrCpy $failure TARGET_READY_RESPONSE_INVALID
          Goto stop_candidate
        ${EndIf}
        Goto target_ready
      ${ElseIf} $0 == 0
      ${AndIf} $win32Error != 232
        StrCpy $failure TARGET_READY_READ_FAILED
        Goto stop_candidate
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::GetTickCount() i.r0'
    IntOp $readyElapsed $0 - $readyStarted
    IntCmp $readyElapsed ${SHELL_READY_WAIT_MS} ready_timeout +1 ready_timeout
    Sleep 20
    Goto wait_ready
  ready_allocation_failed:
    StrCpy $failure READY_ALLOCATION_FAILED
    Goto stop_candidate
  ready_timeout:
    StrCpy $failure TARGET_READY_TIMEOUT
  stop_candidate:
    ; Restore only after the exact candidate handle is signalled, including timeout and invalid ready.
    System::Call 'kernel32::TerminateProcess(p $candidateHandle, i 1) i.r0 ?e'
    Pop $cleanupError
    System::Call 'kernel32::WaitForSingleObject(p $candidateHandle, i 5000) i.r0 ?e'
    Pop $R1
    ${If} $0 != 0
      StrCpy $launched true
      StrCpy $cleanupError $R1
    ${Else}
      StrCpy $cleanupError 0
    ${EndIf}
    Goto failed
  target_ready:
    ; Keep the old selection until the exact candidate has completed its readiness probe.
    Call ReadSelection
    StrCmp $failure "" 0 stop_candidate
    StrCpy $0 "[shell]$\r$\nschema=1$\r$\nactive=$previous$\r$\nprevious=$originalPrevious$\r$\nbaseline=$baseline$\r$\n"
    ${If} $0 != $originalState
      StrCpy $failure STATE_CHANGED
      Goto stop_candidate
    ${EndIf}
    System::Call 'kernel32::ReplaceFileW(w "$root\shell-launch.ini", w "$temporary", w "$backup", i 0, p 0, p 0) i.r0 ?e'
    Pop $win32Error
    IntCmp $0 0 replace_failed
    StrCpy $committed true
    StrCpy $phase started
    Call WriteJournal
    StrCmp $failure "" 0 stop_candidate
    System::Call '*$readyBuffer(i 1)'
    System::Call 'kernel32::WriteFile(p $readyPipe, p $readyBuffer, i 1, *i .r1, p 0) i.r0 ?e'
    Pop $win32Error
    ${If} $0 == 0
    ${OrIf} $1 != 1
      StrCpy $failure TARGET_READY_COMMIT_FAILED
      Goto stop_candidate
    ${EndIf}
    StrCpy $launched true
    ${If} $cleanupError == 0
      SetErrorLevel 0
    ${Else}
      SetErrorLevel 2
    ${EndIf}
    Goto close_owned
  arguments_invalid:
    StrCpy $failure ARGUMENTS_INVALID
    Goto failed
  request_failed:
    StrCpy $failure REQUEST_ID_FAILED
    Goto failed
  journal_open_failed:
    StrCpy $journal 0
    StrCpy $failure JOURNAL_OPEN_FAILED
    Goto failed
  old_open_failed:
    StrCpy $failure OLD_PROCESS_OPEN_FAILED
    Goto failed
  old_path_invalid:
    StrCpy $failure OLD_PROCESS_PATH_INVALID
    Goto failed
  state_changed:
    StrCpy $failure STATE_CHANGED
    Goto failed
  backup_exists:
    StrCpy $failure BACKUP_EXISTS
    Goto failed
  temporary_close_failed:
    System::Call 'kernel32::CloseHandle(p $stateHandle) i.r0'
    StrCpy $stateHandle 0
  temporary_failed:
    StrCpy $failure TEMPORARY_WRITE_FAILED
    Goto failed
  replace_failed:
    StrCpy $failure SELECTION_REPLACE_FAILED
    ; ReplaceFile can fail after moving the old file; its owned backup still permits exact restoration.
    System::Call 'kernel32::GetFileAttributesW(w "$backup") i.r0'
    ${If} $0 != -1
      StrCpy $committed true
    ${EndIf}
    Goto stop_candidate
  allocation_failed:
    StrCpy $failure PROCESS_ALLOCATION_FAILED
    Goto failed
  launch_failed:
    StrCpy $failure TARGET_START_FAILED
  failed:
    SetErrorLevel 1
    StrCpy $phase failed
    ${If} $committed == true
    ${AndIf} $launched != true
      StrCpy $phase rollback-failed
      StrCpy $R5 $failure
      StrCpy $R6 $win32Error
      StrCpy $failure ""
      StrCpy $selectionPath $backup
      Call ReadSelection
      StrCpy $0 "[shell]$\r$\nschema=1$\r$\nactive=$previous$\r$\nprevious=$originalPrevious$\r$\nbaseline=$baseline$\r$\n"
      ${If} $failure == ""
      ${AndIf} $0 == $originalState
        System::Call 'kernel32::GetFileAttributesW(w "$root\shell-launch.ini") i.r0 ?e'
        Pop $cleanupError
        ${If} $0 == -1
        ${AndIf} $cleanupError == 2
          System::Call 'kernel32::MoveFileExW(w "$backup", w "$root\shell-launch.ini", i 8) i.r0 ?e'
        ${Else}
          System::Call 'kernel32::ReplaceFileW(w "$root\shell-launch.ini", w "$backup", p 0, i 0, p 0, p 0) i.r0 ?e'
        ${EndIf}
        Pop $cleanupError
        ${If} $0 != 0
          StrCpy $phase rolled-back
          StrCpy $cleanupError 0
        ${EndIf}
      ${EndIf}
      StrCpy $failure $R5
      StrCpy $win32Error $R6
    ${EndIf}
    ${If} $oldExited == true
    ${AndIf} $launched != true
    ${AndIf} $phase != rollback-failed
      Call RestartOriginal
    ${EndIf}
    ${If} $journal != 0
      Call WriteJournal
    ${Else}
      ClearErrors
      GetTempFileName $R8
      FileOpen $R9 "$R8" w
      IfErrors diagnostic_failed
      FileWrite $R9 '{"errorCode":"DESKTOP_SHELL_SWITCH_FAILED","requestId":"$requestId","stage":"$phase","entity":"shell-switch","rootCause":"$failure","win32Error":$win32Error}$\r$\n'
      IfErrors diagnostic_close_failed
      System::Call 'kernel32::FlushFileBuffers(p $R9) i.r0'
      IntCmp $0 0 diagnostic_close_failed
      System::Call 'kernel32::CloseHandle(p $R9) i.r0'
      IntCmp $0 0 diagnostic_failed close_owned close_owned
      diagnostic_close_failed:
        System::Call 'kernel32::CloseHandle(p $R9) i.r0'
      diagnostic_failed:
        SetErrorLevel 2
    ${EndIf}
  close_owned:
    !insertmacro CloseHandle $candidateThread
    !insertmacro CloseHandle $candidateHandle
    !insertmacro CloseHandle $readyPipe
    ${If} $readyBuffer != 0
      System::Call 'kernel32::GlobalFree(p $readyBuffer) p.r0'
      ${If} $0 != 0
        SetErrorLevel 2
      ${EndIf}
    ${EndIf}
    !insertmacro CloseHandle $oldHandle
    !insertmacro CloseHandle $journal
    !insertmacro CloseHandle $rootHandle
    !insertmacro CloseHandle $userDataHandle
    !insertmacro CloseHandle $sessionDataHandle
    ${If} $argv != 0
      System::Call 'kernel32::LocalFree(p $argv) p.r0'
      ${If} $0 != 0
        SetErrorLevel 2
      ${EndIf}
    ${EndIf}
    Quit
SectionEnd
