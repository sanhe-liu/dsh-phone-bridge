<#
.SYNOPSIS
  查看 DSH 手机桥的运行状态（端口、进程、日志、手机地址）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\status.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 8090,
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.dsh\phone-bridge'),
  [string]$TaskName = 'DSH-Phone-Bridge'
)

$ErrorActionPreference = 'Continue'

function Line($k, $v) { Write-Host ('  {0,-16} {1}' -f $k, $v) }
function YesNo($b) { if ($b) { return '有' } return '缺' }

Write-Host ''
Write-Host 'DSH 手机桥状态' -ForegroundColor Cyan
Write-Host ('-' * 48)

Line '安装目录' $InstallDir
Line '目录存在' (YesNo (Test-Path $InstallDir))

foreach ($f in @('bridge.mjs', 'mobile.css', 'bridge.pass.txt')) {
  Line $f (YesNo (Test-Path (Join-Path $InstallDir $f)))
}

$nodeInfo = '未找到（PATH 里没有 node）'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nodeVer = (& $node.Source --version).Trim()
  $nodeInfo = "$($node.Source) $nodeVer"
}
Line 'Node.js' $nodeInfo

$taskState = '未注册'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $taskState = $task.State
  Line '计划任务' $taskState
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($info) { Line '上次运行' "$($info.LastRunTime)（结果 $($info.LastTaskResult)）" }
} else {
  Line '计划任务' $taskState
}

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  $procName = '未知'
  if ($proc) { $procName = $proc.ProcessName }
  Line "端口 $Port" "监听中，PID $($conn.OwningProcess)（$procName）"
} else {
  Line "端口 $Port" '没有监听 —— 桥没在跑'
}

$pidFile = Join-Path $InstallDir 'bridge.pid'
if (Test-Path $pidFile) { Line 'bridge.pid' (Get-Content $pidFile -Raw -Encoding UTF8).Trim() }

Write-Host ''
Write-Host '  手机地址' -ForegroundColor White
$urlFile = Join-Path $InstallDir 'phone-url.txt'
if (Test-Path $urlFile) {
  Get-Content $urlFile -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "    $_" }
} else {
  Write-Host '    （还没写过，桥启动后才会生成）'
}

Write-Host ''
Write-Host '  Tailscale' -ForegroundColor White
$ts = @()
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.IPAddress -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.') { $ts += $_.IPAddress }
}
if ($ts.Count) {
  foreach ($ip in $ts) { Write-Host "    $ip" }
} else {
  Write-Host '    （没检测到 100.x 地址；Tailscale 未装或未登录）'
}

Write-Host ''
Write-Host '最近日志' -ForegroundColor Cyan
foreach ($log in @('bridge.err.log', 'bridge.out.log')) {
  $p = Join-Path $InstallDir $log
  Write-Host "  -- $log"
  if (Test-Path $p) {
    Get-Content $p -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host "     $_" }
  } else {
    Write-Host '     （无）'
  }
}

$authLog = Join-Path $InstallDir 'bridge-auth.log'
if (Test-Path $authLog) {
  Write-Host ''
  Write-Host '最近访问/失败记录' -ForegroundColor Cyan
  Get-Content $authLog -Tail 6 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
}
Write-Host ''
