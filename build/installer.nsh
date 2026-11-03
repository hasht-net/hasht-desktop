; electron-builder includes this from build/ automatically.
; The login item is a per-user Run value named after the AppUserModelID
; (src/main/loginItem.ts). Updates run this uninstaller too, so keep it then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "net.hasht.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "net.hasht.app"
  ${endIf}
!macroend
