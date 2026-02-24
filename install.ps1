$ErrorActionPreference = "Stop"

$REPO = "afumu/openlink"
$BIN = "openlink"
$INSTALL_DIR = "$env:USERPROFILE\.openlink"

$ARCH = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }

$release = Invoke-RestMethod "https://api.github.com/repos/$REPO/releases/latest"
$VERSION = $release.tag_name
if (-not $VERSION) { Write-Error "获取版本失败"; exit 1 }

$FILE = "${BIN}_windows_${ARCH}.zip"
$URL = "https://github.com/$REPO/releases/download/$VERSION/$FILE"

Write-Host "正在安装 openlink $VERSION (windows/$ARCH)..."

New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
$TMP = Join-Path $env:TEMP "openlink_install"
New-Item -ItemType Directory -Force -Path $TMP | Out-Null

Invoke-WebRequest -Uri $URL -OutFile "$TMP\openlink.zip"
Expand-Archive -Path "$TMP\openlink.zip" -DestinationPath $TMP -Force
Move-Item -Force "$TMP\$BIN.exe" "$INSTALL_DIR\$BIN.exe"
Remove-Item -Recurse -Force $TMP

# 添加到用户 PATH
$path = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($path -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable("PATH", "$path;$INSTALL_DIR", "User")
    Write-Host "已添加 $INSTALL_DIR 到 PATH（重新打开终端生效）"
}

Write-Host "安装完成: $INSTALL_DIR\$BIN.exe"
Write-Host "运行 'openlink' 启动服务"
