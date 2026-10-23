@echo off
powershell.exe -NoProfile -Command "Stop-ScheduledTask -TaskName 'Godoy CRM Leads' -ErrorAction SilentlyContinue; Disable-ScheduledTask -TaskName 'Godoy CRM Leads' | Out-Null"
echo Sincronizacao pausada. O historico local foi preservado.
pause
