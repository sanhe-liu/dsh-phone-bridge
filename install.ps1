<#
.SYNOPSIS
  一键安装：把 dsh-phone-bridge 装成 DSH 技能，并立刻把手机访问桥跑起来。

.DESCRIPTION
  1. 把 skill\ 复制到 %USERPROFILE%\.dsh\skills\dsh-phone-bridge（DSH 会自动发现）；
  2. 调用 setup.ps1 安装并启动桥（可用 -NoSetup 跳过，只装技能）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 8090 -NoSetup
#>
[CmdletBinding()]
param(
  [string]$SkillDir = (Join-Path $env:USERPROFILE '.dsh\skills\dsh-phone-bridge'),
  [int]$Port = 8090,
  [switch]$NoSetup
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'skill'
if (-not (Test-Path (Join-Path $src 'SKILL.md'))) {
  throw "找不到 skill\SKILL.md —— 请在仓库根目录运行这个脚本"
}

Write-Host ''
Write-Host '== 安装 DSH 技能' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
Copy-Item (Join-Path $src '*') $SkillDir -Recurse -Force
Write-Host "   已复制到 $SkillDir" -ForegroundColor Green
Write-Host '   重启 DSH（或新开会话）后，技能列表里会出现 dsh-phone-bridge。'

if ($NoSetup) {
  Write-Host ''
  Write-Host '   已跳过启动（-NoSetup）。需要时运行：' -ForegroundColor Yellow
  Write-Host "   powershell -ExecutionPolicy Bypass -File `"$SkillDir\scripts\setup.ps1`" -Port $Port"
  exit 0
}

Write-Host ''
Write-Host '== 安装并启动手机访问桥' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SkillDir 'scripts\setup.ps1') -Port $Port
exit $LASTEXITCODE
