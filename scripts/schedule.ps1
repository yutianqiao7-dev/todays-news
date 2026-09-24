# 毎朝の通知をタスクスケジューラに登録/削除する
#   登録: powershell -File scripts\schedule.ps1 -Time 07:00
#   削除: powershell -File scripts\schedule.ps1 -Remove
param([string]$Time = '07:00', [switch]$Remove)

$name = 'TodaysNewsMorning'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Output "朝の通知を停止しました"
  return
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\notify.js`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
# PCがその時刻にスリープ/オフでも、次に起動したときに実行する
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description '今日のニュースを通知' -Force | Out-Null
Write-Output "毎日 $Time にニュースを通知します"
