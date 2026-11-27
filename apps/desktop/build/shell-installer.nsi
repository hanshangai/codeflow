Unicode true
!define INSTALL_DOLLAR "$"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
Name "CodeFlow candidate shell"
OutFile "${OUTPUT_FILE}"
!ifdef CODEFLOW_SHELL_FAST_COMPRESS
  SetCompressor zlib
!else
  SetCompressor lzma
!endif
SetOverwrite on

!include "LogicLib.nsh"
!if ${NSIS_PTR_SIZE} != 4
  !error "Candidate installer requires the existing x86 NSIS stub"
!endif

Var argv
Var root
Var requestId
Var target
Var finalTarget
Var checkedPath
Var failure
Var stage
Var win32Error
Var pathPosition
Var segment
Var cleanupWin32Error

; Read each native argument only after its UTF-16 length fits the NSIS buffer.
!macro ReadArgument OFFSET DESTINATION
  IntOp $0 $argv + ${OFFSET}
  System::Call '*$0(p.r1)'
  System::Call 'kernel32::lstrlenW(p r1)i.r2'
  IntCmp $2 ${NSIS_MAX_STRLEN} invalid_arguments +1 invalid_arguments
  System::Call 'kernel32::lstrcpynW(w.r3, p r1, i ${NSIS_MAX_STRLEN})p'
  StrCpy ${DESTINATION} $3
!macroend

; Release only the CommandLineToArgvW allocation, keeping a primary failure intact.
Function FreeArguments
  StrCmp $argv 0 done_free
  System::Call 'kernel32::LocalFree(p $argv)p.r0 ?e'
  Pop $1
  StrCpy $argv 0
  ${If} $0 != 0
    ${If} $failure == ""
      StrCpy $failure "ARGUMENT_RELEASE_FAILED"
      StrCpy $win32Error $1
    ${Else}
      StrCpy $cleanupWin32Error $1
    ${EndIf}
  ${EndIf}
  done_free:
FunctionEnd

; Only lowercase UUID v4 text may enter the structured diagnostic.
Function ValidateRequest
  StrLen $0 $requestId
  IntCmp $0 36 +1 invalid_request invalid_request
  StrCpy $0 0
  request_loop:
    StrCpy $1 $requestId 1 $0
    ${If} $0 == 8
    ${OrIf} $0 == 13
    ${OrIf} $0 == 18
    ${OrIf} $0 == 23
      StrCmpS $1 "-" next_request invalid_request
    ${EndIf}
    StrCmpS $1 "0" next_request
    StrCmpS $1 "1" next_request
    StrCmpS $1 "2" next_request
    StrCmpS $1 "3" next_request
    StrCmpS $1 "4" next_request
    StrCmpS $1 "5" next_request
    StrCmpS $1 "6" next_request
    StrCmpS $1 "7" next_request
    StrCmpS $1 "8" next_request
    StrCmpS $1 "9" next_request
    StrCmpS $1 "a" next_request
    StrCmpS $1 "b" next_request
    StrCmpS $1 "c" next_request
    StrCmpS $1 "d" next_request
    StrCmpS $1 "e" next_request
    StrCmpS $1 "f" next_request invalid_request
  next_request:
    IntOp $0 $0 + 1
    IntCmp $0 36 request_shape request_loop invalid_request
  request_shape:
    StrCpy $1 $requestId 1 14
    StrCmpS $1 "4" 0 invalid_request
    StrCpy $1 $requestId 1 19
    StrCmpS $1 "8" request_valid
    StrCmpS $1 "9" request_valid
    StrCmpS $1 "a" request_valid
    StrCmpS $1 "b" request_valid invalid_request
  invalid_request:
    StrCpy $requestId ""
    StrCpy $failure "ARGUMENTS_INVALID"
  request_valid:
FunctionEnd

; Reject missing paths, non-directories and every observed reparse component.
Function CheckDirectory
  System::Call 'kernel32::GetFileAttributesW(w "$checkedPath")i.r0 ?e'
  Pop $win32Error
  ${If} $0 == -1
    StrCpy $failure "PATH_UNAVAILABLE"
    Return
  ${EndIf}
  StrCpy $win32Error 0
  IntOp $1 $0 & 0x400
  ${If} $1 != 0
    StrCpy $failure "PATH_REPARSE"
    Return
  ${EndIf}
  IntOp $1 $0 & 0x10
  ${If} $1 == 0
    StrCpy $failure "PATH_NOT_DIRECTORY"
  ${EndIf}
FunctionEnd

; Validate a canonical fixed-drive root and each existing parent without creating any directories.
Function ValidateRoot
  StrLen $4 $root
  IntCmp $4 3 invalid_root invalid_root +1
  StrCpy $0 $root 1
  System::Call 'user32::CharUpperBuffW(w r0, i 1)i'
  StrCmpS $0 "A" drive_valid
  StrCmpS $0 "B" drive_valid
  StrCmpS $0 "C" drive_valid
  StrCmpS $0 "D" drive_valid
  StrCmpS $0 "E" drive_valid
  StrCmpS $0 "F" drive_valid
  StrCmpS $0 "G" drive_valid
  StrCmpS $0 "H" drive_valid
  StrCmpS $0 "I" drive_valid
  StrCmpS $0 "J" drive_valid
  StrCmpS $0 "K" drive_valid
  StrCmpS $0 "L" drive_valid
  StrCmpS $0 "M" drive_valid
  StrCmpS $0 "N" drive_valid
  StrCmpS $0 "O" drive_valid
  StrCmpS $0 "P" drive_valid
  StrCmpS $0 "Q" drive_valid
  StrCmpS $0 "R" drive_valid
  StrCmpS $0 "S" drive_valid
  StrCmpS $0 "T" drive_valid
  StrCmpS $0 "U" drive_valid
  StrCmpS $0 "V" drive_valid
  StrCmpS $0 "W" drive_valid
  StrCmpS $0 "X" drive_valid
  StrCmpS $0 "Y" drive_valid
  StrCmpS $0 "Z" drive_valid invalid_root
  drive_valid:
    StrCpy $0 $root 2 1
    StrCmpS $0 ":\" 0 invalid_root
    IntOp $0 $4 + ${MAX_PAYLOAD_PATH}
    StrLen $1 "${SHELL_ID}"
    ${If} $1 < 47
      StrCpy $1 47
    ${EndIf}
    IntOp $0 $0 + $1
    IntOp $0 $0 + 10
    IntCmp $0 ${NSIS_MAX_STRLEN} invalid_root +1 invalid_root
    System::Call 'kernel32::GetFullPathNameW(w "$root", i ${NSIS_MAX_STRLEN}, w.r0, p 0)i.r1'
    StrCmpS $0 $root 0 invalid_root
    StrCpy $checkedPath $root 3
    ; GetDriveTypeW has no reliable LastError; only DRIVE_FIXED is an approved target.
    System::Call 'kernel32::GetDriveTypeW(w "$checkedPath")i.r0'
    ${If} $0 != 3
      StrCpy $failure "ROOT_DRIVE_UNSUPPORTED"
      StrCpy $win32Error 0
      Return
    ${EndIf}
    Call CheckDirectory
    StrCmp $failure "" 0 root_done
    StrCpy $pathPosition 3
    StrCpy $segment ""
  root_loop:
    StrCpy $0 $root 1 $pathPosition
    StrCmpS $0 "" root_segment_end
    StrCmpS $0 "\" root_segment_end
    StrCpy $1 1
  control_loop:
    IntFmt $2 "%c" $1
    StrCmpS $0 $2 invalid_root
    IntOp $1 $1 + 1
    IntCmp $1 32 control_done control_loop control_done
  control_done:
    IntFmt $2 "%c" 127
    StrCmpS $0 $2 invalid_root
    StrCmpS $0 "/" invalid_root
    StrCmpS $0 ":" invalid_root
    StrCmpS $0 "*" invalid_root
    StrCmpS $0 "?" invalid_root
    StrCmpS $0 '$\"' invalid_root
    StrCmpS $0 "<" invalid_root
    StrCmpS $0 ">" invalid_root
    StrCmpS $0 "|" invalid_root
    StrCpy $segment "$segment$0"
    IntOp $pathPosition $pathPosition + 1
    Goto root_loop
  root_segment_end:
    StrCmp $segment "" invalid_root
    StrCmpS $segment "." invalid_root
    StrCmpS $segment ".." invalid_root
    StrCpy $1 $segment 1 -1
    StrCmpS $1 "." invalid_root
    StrCmpS $1 " " invalid_root
    StrCpy $checkedPath $root $pathPosition
    Call CheckDirectory
    StrCmp $failure "" 0 root_done
    StrLen $1 $root
    IntCmp $pathPosition $1 root_shells
    IntOp $pathPosition $pathPosition + 1
    StrCpy $segment ""
    Goto root_loop
  root_shells:
    StrCpy $checkedPath "$root\shells"
    Call CheckDirectory
    Goto root_done
  invalid_root:
    StrCpy $failure "ROOT_INVALID"
    StrCpy $win32Error 0
  root_done:
FunctionEnd

; Create only a newly derived payload subdirectory; never reuse or overwrite a pre-existing object.
Function CreatePayloadDirectory
  System::Call 'kernel32::CreateDirectoryW(w "$checkedPath", p 0)i.r0 ?e'
  Pop $win32Error
  ${If} $0 == 0
    StrCpy $failure "PAYLOAD_DIRECTORY_FAILED"
  ${EndIf}
FunctionEnd

; Native exclusive copying preserves the first real write error and leaves the partial candidate intact.
Function CopyPayloadFile
  System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\payload.tmp", w "$checkedPath", i 1)i.r0 ?e'
  Pop $win32Error
  ${If} $0 == 0
    StrCpy $failure "PAYLOAD_WRITE_FAILED"
  ${EndIf}
FunctionEnd

; Only fixed ASCII fields and validated IDs reach stderr; no paths or arbitrary arguments are logged.
Function Fail
  Call FreeArguments
  StrCpy $1 ""
  StrCmp $cleanupWin32Error "" +2
    StrCpy $1 ',"cleanupWin32Error":$cleanupWin32Error'
  StrCpy $0 '{"errorCode":"DESKTOP_SHELL_INSTALL_FAILED","requestId":"$requestId","shellId":"${SHELL_ID}","stage":"$stage","win32Error":$win32Error,"rootCause":"$failure"$1}$\n'
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r0, i -1, p 0, i 0, p 0, p 0)i.r1'
  ${If} $1 == 0
    Goto diagnostic_failed
  ${EndIf}
  System::Alloc $1
  Pop $2
  ${If} $2 == 0
    Goto diagnostic_failed
  ${EndIf}
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r0, i -1, p r2, i r1, p 0, p 0)i.r3'
  ${If} $3 == 0
    System::Free $2
    Goto diagnostic_failed
  ${EndIf}
  IntOp $1 $3 - 1
  System::Call 'kernel32::GetStdHandle(i -12)p.r0'
  ${If} $0 == 0
  ${OrIf} $0 == -1
    System::Free $2
    Goto diagnostic_failed
  ${EndIf}
  System::Call 'kernel32::WriteFile(p r0, p r2, i r1, *i.r4, p 0)i.r3'
  System::Free $2
  ${If} $3 == 0
  ${OrIf} $4 != $1
    Goto diagnostic_failed
  ${EndIf}
  SetErrorLevel 1
  Quit
  diagnostic_failed:
    SetErrorLevel 2
    Quit
FunctionEnd

Section
  StrCpy $argv 0
  StrCpy $requestId ""
  StrCpy $stage "arguments"
  StrCpy $win32Error 0
  System::Call 'kernel32::GetCommandLineW()p.r0'
  System::Call 'kernel32::lstrlenW(p r0)i.r1'
  IntCmp $1 ${NSIS_MAX_STRLEN} invalid_arguments +1 invalid_arguments
  System::Call 'shell32::CommandLineToArgvW(p r0, *i.r1)p.r2 ?e'
  Pop $win32Error
  StrCpy $argv $2
  StrCmp $argv 0 argument_parse_failed
  StrCpy $win32Error 0
  IntCmp $1 6 +1 invalid_arguments invalid_arguments
  !insertmacro ReadArgument 4 $4
  StrCmpS $4 "--codeflow-candidate-install" 0 invalid_arguments
  !insertmacro ReadArgument 8 $4
  StrCmpS $4 "--installation-root" 0 invalid_arguments
  !insertmacro ReadArgument 16 $4
  StrCmpS $4 "--request-id" 0 invalid_arguments
  !insertmacro ReadArgument 12 $root
  !insertmacro ReadArgument 20 $requestId
  Call ValidateRequest
  StrCmp $failure "" 0 failed
  Call FreeArguments
  StrCmp $failure "" 0 failed
  StrCpy $stage "root"
  Call ValidateRoot
  StrCmp $failure "" 0 failed
  StrCpy $stage "create-target"
  StrCpy $finalTarget "$root\shells\${SHELL_ID}"
  ; A fresh request owns only its staging directory until all files are present.
  StrCpy $target "$root\shells\.candidate-$requestId"
  System::Call 'kernel32::CreateDirectoryW(w "$target", p 0)i.r0 ?e'
  Pop $win32Error
  ${If} $0 == 0
    StrCpy $failure "TARGET_CREATE_FAILED"
    Goto failed
  ${EndIf}
  ; System plugins have process-owned temporary files; payload temp writes begin only after target creation.
  StrCpy $stage "extract-temp"
  ClearErrors
  InitPluginsDir
  IfErrors payload_temp_failed
  ClearErrors
  SetOutPath "$PLUGINSDIR"
  IfErrors payload_temp_failed
  StrCpy $stage "extract"
  !include "${PAYLOAD_FILE}"
  StrCpy $stage "publish-target"
  System::Call 'kernel32::MoveFileExW(w "$target", w "$finalTarget", i 8)i.r0 ?e'
  Pop $win32Error
  ${If} $0 == 0
    StrCpy $failure "TARGET_PUBLISH_FAILED"
    Goto failed
  ${EndIf}
  SetErrorLevel 0
  Quit
  payload_temp_failed:
    System::Call 'kernel32::GetLastError()i.r0'
    StrCpy $win32Error $0
    StrCpy $stage "extract-temp"
    StrCpy $failure "PAYLOAD_TEMP_FAILED"
    Goto failed
  argument_parse_failed:
    StrCpy $failure "ARGUMENT_PARSE_FAILED"
    Goto failed
  invalid_arguments:
    StrCpy $requestId ""
    StrCpy $win32Error 0
    StrCpy $failure "ARGUMENTS_INVALID"
  failed:
    Call Fail
SectionEnd
