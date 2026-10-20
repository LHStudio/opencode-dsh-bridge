# 在桌面创建「OpenCode 桥接器」快捷方式（Windows）
#
# 用法（在仓库根目录或任意位置执行都行）：
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Destination "D:\我的快捷方式"
#
# 快捷方式会打开一个 cmd 窗口并运行仓库里的 start.cmd；
# 桥需要一直运行，所以窗口保留（/k），关掉窗口即停止桥。

param(
  [string]$Destination = [Environment]::GetFolderPath("Desktop"),
  [string]$Name = "OpenCode 桥接器"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$startCmd = Join-Path $repoRoot "start.cmd"
if (-not (Test-Path $startCmd)) {
  throw "找不到 $startCmd（请把本脚本放在仓库的 scripts 目录里）"
}
if (-not (Test-Path $Destination)) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
}

$shortcutPath = Join-Path $Destination "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $env:ComSpec
$shortcut.Arguments = "/k `"`"$startCmd`"`""
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = "启动 OpenCode → DeepSeek Harness 本地桥接器（免费 / Go）"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,14"
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "已创建快捷方式：$shortcutPath"
Write-Host "双击即可启动（会打开 cmd 窗口，关闭窗口即停止桥）。"
