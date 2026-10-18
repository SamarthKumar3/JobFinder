$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$windowsZone=(Get-TimeZone).Id
if($windowsZone -ne 'India Standard Time') { throw 'Daily Windows task requires India Standard Time. The application cron still uses Asia/Kolkata; adjust the Windows trigger to match your system timezone.' }
$ps=(Get-Command powershell.exe).Source
$daily=New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskRoot\scripts\run-workflow.ps1`"" -WorkingDirectory $taskRoot
$trigger=New-ScheduledTaskTrigger -Daily -At '09:00'
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 8)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'JobFinder Daily 9AM' -Action $daily -Trigger $trigger -Settings $settings -Principal $principal -Description 'Collect and score jobs daily at 09:00 Asia/Kolkata; catch up after missed starts.' -Force | Out-Null
$serve=New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskRoot\scripts\serve.ps1`"" -WorkingDirectory $taskRoot
$logon=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$serveSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'JobFinder Dashboard' -Action $serve -Trigger $logon -Settings $serveSettings -Principal $principal -Description 'Local JobFinder dashboard at login, using the existing PostgreSQL Docker image.' -Force | Out-Null
Write-Host 'Registered daily 09:00 workflow and dashboard at logon. The Windows user must be logged in for Codex authentication.'
