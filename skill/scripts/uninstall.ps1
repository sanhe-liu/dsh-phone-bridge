<#
.SYNOPSIS
  卸载 DSH 手机桥：停进程、删计划任务、删开机自启快捷方式、清防火墙规则，可选删文件。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepFiles
#>
[CmdletBinding()]
param(
  [int]$Port = 8090,
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.dsh\phone-bridge'),
  [string]$TaskName = 'DSH-Phone-Bridge',
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'

function Step($m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   $m" -ForegroundColor Yellow }

Step '停止计划任务'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Ok "已删除计划任务 $TaskName"
} else {
  Warn '没有这个计划任务'
}

Step '停止桥进程'
$killed = 0
$pidFile = Join-Path $InstallDir 'bridge.pid'
if (Test-Path $pidFile) {
  $savedPid = [int]((Get-Content $pidFile -Raw).Trim())
  $p = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $savedPid -Force; $killed++ }
}
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($owner -and $owner.ProcessName -eq 'node') {
    try {
      $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.Id)").CommandLine
      if ($cmdline -match 'bridge\.mjs') { Stop-Process -Id $owner.Id -Force; $killed++ }
    } catch {
      Stop-Process -Id $owner.Id -Force; $killed++
    }
  }
}
if ($killed) { Ok "已停止 $killed 个进程" } else { Warn '没有发现正在运行的桥' }

Step '删除开机自启快捷方式'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH Phone Bridge.lnk'
if (Test-Path $lnk) {
  $ws = New-Object -ComObject WScript.Shell
  $shortcut = $ws.CreateShortcut($lnk)
  $pointsHere = ("$($shortcut.TargetPath) $($shortcut.Arguments)") -like "*$InstallDir*"
  if ($pointsHere) {
    Remove-Item $lnk -Force
    Ok $lnk
  } else {
    Warn "这个快捷方式指向别处，保留：$lnk"
  }
} else {
  Warn '没有快捷方式'
}

Step '清理防火墙规则'
try {
  $rules = Get-NetFirewallRule -DisplayName 'DSH Phone Bridge*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*$Port*" }
  if ($rules) {
    $rules | Remove-NetFirewallRule -ErrorAction Stop
    Ok "已删除 $($rules.Count) 条规则"
  } else {
    Warn '没有找到相关规则'
  }
} catch {
  Warn "清理防火墙失败（需要管理员）：$($_.Exception.Message)"
}

Step '清理文件'
if ($KeepFiles) {
  Warn "保留 $InstallDir"
} elseif (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force
  Ok "已删除 $InstallDir"
}

Write-Host ''
Write-Host '卸载完成。' -ForegroundColor White
Write-Host '（已安装的技能目录 %USERPROFILE%\.dsh\skills\dsh-phone-bridge 需要的话手动删）' -ForegroundColor DarkGray
