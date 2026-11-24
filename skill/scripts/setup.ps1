<#
.SYNOPSIS
  安装 DSH 手机桥：把本机 DSH 桌面 Web GUI 开放给局域网 / Tailscale 手机访问。

.DESCRIPTION
  - 检查 Node.js（>= 18），没有就提示安装命令；
  - 把 bridge.mjs / mobile.css 复制到安装目录；
  - 生成或复用访问口令（bridge.pass.txt）；
  - 注册开机自启（启动文件夹快捷方式 + 计划任务）；
  - 放行防火墙端口（需要管理员时给出命令）；
  - 启动并自检，最后打印手机可用的地址。

.PARAMETER Port
  桥监听端口，默认 8090。

.PARAMETER Pass
  访问口令；省略时复用安装目录里已有的，没有就随机生成。

.PARAMETER InstallDir
  安装目录，默认 %USERPROFILE%\.dsh\phone-bridge。

.PARAMETER Bind
  监听地址，默认 0.0.0.0（局域网可达）。只给本机用可写 127.0.0.1。

.PARAMETER DshPort
  上游 DSH 端口，默认 auto（自动探测桌面版）。

.PARAMETER NoFirewall
  不添加防火墙规则（端口已在别处放行时用）。

.PARAMETER NoAutostart
  不注册开机自启。

.PARAMETER NoStart
  只安装文件、不立刻启动。

.PARAMETER Force
  端口被其它程序占用时也继续（会撞端口，一般不用）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Port 8090 -InstallDir D:\tools\dsh-bridge
#>
[CmdletBinding()]
param(
  [int]$Port = 8090,
  [string]$Pass = '',
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.dsh\phone-bridge'),
  [string]$Bind = '0.0.0.0',
  [string]$DshPort = 'auto',
  [string]$TaskName = 'DSH-Phone-Bridge',
  [switch]$NoFirewall,
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot

function Step($m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   $m" -ForegroundColor Yellow }

# ---------- 1. Node.js ----------
Step '检查 Node.js'
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
  if (-not $node -and (Test-Path $p)) { $node = $p }
}
if (-not $node) {
  Write-Host '   没有找到 Node.js。先装一个（任选其一）：' -ForegroundColor Red
  Write-Host '     winget install OpenJS.NodeJS.LTS'
  Write-Host '     https://nodejs.org/zh-cn/download'
  throw '缺少 Node.js'
}
$nodeVer = (& $node --version).Trim()
$major = [int](($nodeVer -replace '^v', '') -split '\.')[0]
if ($major -lt 18) { throw "Node.js 版本太旧（$nodeVer），需要 18 以上" }
Ok "$node ($nodeVer)"

# ---------- 2. 复制文件 ----------
Step '准备安装目录'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($f in @('bridge.mjs', 'mobile.css')) {
  $target = Join-Path $InstallDir $f
  $source = Join-Path $src $f
  if (-not (Test-Path $source)) { throw "安装源缺少 $f" }
  if ((Resolve-Path $source).Path -ne $target) { Copy-Item $source $target -Force }
  Ok $target
}
$apkSrc = Join-Path $src 'apk'
if (Test-Path $apkSrc) {
  Copy-Item $apkSrc (Join-Path $InstallDir 'apk') -Recurse -Force
  Ok 'apk/（手机安装包，可选）'
}

# 端口占用检查
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing -and -not $Force) {
  $owner = Get-Process -Id $existing.OwningProcess -ErrorAction SilentlyContinue
  $pidFile = Join-Path $InstallDir 'bridge.pid'
  $expected = if (Test-Path $pidFile) { [int]((Get-Content $pidFile -Raw).Trim()) } else { -1 }
  if ($existing.OwningProcess -ne $expected) {
    throw "端口 $Port 已被 PID $($existing.OwningProcess) ($($owner.ProcessName)) 占用；换一个 -Port，或先停掉它"
  }
}

# ---------- 3. 口令 ----------
Step '配置访问口令'
$passFile = Join-Path $InstallDir 'bridge.pass.txt'
if ($Pass) {
  $finalPass = $Pass
} elseif (Test-Path $passFile) {
  $finalPass = (Get-Content $passFile -Raw).Trim()
  Ok '沿用已有口令'
} else {
  $bytes = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $finalPass = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  Ok '已生成新口令'
}
if ($finalPass.Length -lt 6) { throw '口令至少 6 位' }
[System.IO.File]::WriteAllText($passFile, $finalPass)
Ok "口令保存在 $passFile"

# ---------- 4. 启动器 ----------
Step '写启动脚本'
$cmdFile = Join-Path $InstallDir 'start-bridge.cmd'
$vbsFile = Join-Path $InstallDir 'start-bridge.vbs'
$cmdText = @"
@echo off
chcp 65001 >nul
cd /d "%~dp0"
"$node" bridge.mjs --port $Port --bind $Bind --dsh-port $DshPort >> bridge.out.log 2>> bridge.err.log
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cmdFile, $cmdText, $utf8NoBom)
# VBS 里只用 ASCII：wscript 按 ANSI 读脚本，中文会变乱码；安装路径在运行时从脚本自身位置推导
$vbsText = @"
' Start DSH phone bridge in a hidden window (used by autostart + scheduled task)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd.exe /c """ & dir & "\start-bridge.cmd""", 0, False
"@
[System.IO.File]::WriteAllText($vbsFile, $vbsText, $utf8NoBom)
Ok $cmdFile
Ok $vbsFile

# ---------- 5. 防火墙 ----------
Step '防火墙'
$ruleName = "DSH Phone Bridge (TCP $Port)"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($NoFirewall) {
  Warn '已跳过（-NoFirewall）'
} elseif ($admin) {
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain, Private, Public | Out-Null
    Ok "已放行 TCP $Port"
  } else {
    Ok "规则已存在：$ruleName"
  }
} else {
  Warn '当前不是管理员，没动防火墙。如果手机连不上，用管理员 PowerShell 跑一次：'
  Warn "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private,Public"
}

# ---------- 6. 开机自启 ----------
Step '开机自启'
if ($NoAutostart) {
  Warn '已跳过（-NoAutostart）'
} else {
  try {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbsFile + '"')
    $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Ok "计划任务 $TaskName"
  } catch {
    Warn "计划任务注册失败：$($_.Exception.Message)"
  }
  try {
    $startup = [Environment]::GetFolderPath('Startup')
    $lnkPath = Join-Path $startup 'DSH Phone Bridge.lnk'
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = 'wscript.exe'
    $lnk.Arguments = '"' + $vbsFile + '"'
    $lnk.WorkingDirectory = $InstallDir
    $lnk.WindowStyle = 7
    $lnk.Description = 'Start DSH phone bridge at logon'
    $lnk.Save()
    Ok "启动文件夹快捷方式：$lnkPath"
  } catch {
    Warn "快捷方式创建失败：$($_.Exception.Message)"
  }
}

# ---------- 7. 启动并自检 ----------
Step '启动'
$listening = $false
if (-not $NoStart) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $TaskName
  } else {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbsFile + '"') -WindowStyle Hidden
  }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
  }
  if (-not $listening) {
    Warn '等待超时，桥没起来。看日志：'
    $errLog = Join-Path $InstallDir 'bridge.err.log'
    if (Test-Path $errLog) { Get-Content $errLog -Tail 10 | ForEach-Object { Warn $_ } }
    throw '启动失败'
  }
  $status = 0
  try {
    $u = "http://127.0.0.1:$Port/?k=$([uri]::EscapeDataString($finalPass))"
    $r = Invoke-WebRequest -Uri $u -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    $status = [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  }
  if ($status -ne 303) { throw "本机自检失败（HTTP $status），日志见 $InstallDir\bridge.err.log" }
  Ok "本机自检通过（口令 ?k= → 303）"
}

# ---------- 8. 汇总 ----------
Step '完成'
$ips = @()
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
  $ip = $_.IPAddress
  if ($ip -match '^192\.168\.' -or $ip -match '^10\.' -or $ip -match '^172\.(1[6-9]|2\d|3[01])\.' -or $ip -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.') { $ips += $ip }
}
Write-Host ''
Write-Host '   手机浏览器打开（第一次必须带 ?k=，之后靠 cookie）：' -ForegroundColor White
foreach ($ip in $ips) { Write-Host "     http://${ip}:$Port/?k=$finalPass" }
if ($ips.Count -eq 0) { Write-Host '     （本机没检测到局域网/Tailscale 地址）' }
Write-Host ''
Write-Host "   口令：$finalPass" -ForegroundColor White
Write-Host "   安装目录：$InstallDir"
Write-Host "   日志：$InstallDir\bridge.out.log / bridge.err.log"
Write-Host '   建议手机用浏览器菜单「添加到主屏幕」，以后点图标直达。'
