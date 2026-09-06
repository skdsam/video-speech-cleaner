!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove only Speech Cleaner's per-user app data. This contains the downloaded
  ; Whisper model, Whisper runtime, FFmpeg tools, and temporary app-owned data.
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\com.skdsam.speechcleaner"
!macroend
