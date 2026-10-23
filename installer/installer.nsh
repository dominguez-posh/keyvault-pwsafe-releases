; Per-user installation (no administrator rights). The app sets itself up for the user on first start; the
; uninstaller removes the user's passkey provider package and browser registration again.
; Machine-wide parts (certificate trust, extension policy) come from IT (Intune) or from the app's
; "Set up with administrator rights" button – see installer/setup.ps1 -Scope Machine.

!macro customUnInstall
  ; An update runs the old uninstaller first – keep the setup then.
  ${ifNot} ${isUpdated}
    DetailPrint "Entferne Passkey-Anbieter und Browser-Anbindung …"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\setup.ps1" -Action Uninstall -Scope User'
    Pop $0
  ${endIf}
!macroend
