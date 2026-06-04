param(
  [string]$OutputRoot = "release-packages",
  [switch]$SkipTests,
  [switch]$SkipGoTests,
  [switch]$SkipExtensionTests,
  [switch]$SkipTypeCheck,
  [switch]$SkipVet,
  [switch]$NoPackage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$extensionDir = Join-Path $repoRoot "extension"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $repoRoot (Join-Path $OutputRoot $stamp)
$binDir = Join-Path $outDir "bin"

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Block
  )

  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Block
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Require-Command "go"
Require-Command "npm"
Require-Command "node"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Push-Location $repoRoot
try {
  if (-not $SkipTests -and -not $SkipGoTests) {
    Invoke-Step "go test ./..." { go test ./... }
  }

  if (-not $SkipVet) {
    Invoke-Step "go vet ./..." { go vet ./... }
  }

  Invoke-Step "build piercode.exe" {
    go build -ldflags "-s -w" -o (Join-Path $binDir "piercode.exe") ./cmd/server
  }

  Invoke-Step "build piercode-mcp.exe" {
    go build -ldflags "-s -w" -o (Join-Path $binDir "piercode-mcp.exe") ./cmd/mcp
  }

  Push-Location $extensionDir
  try {
    if (-not (Test-Path "node_modules")) {
      if (Test-Path "package-lock.json") {
        Invoke-Step "npm ci" { npm ci }
      } else {
        Invoke-Step "npm install" { npm install }
      }
    }

    if (-not $SkipTypeCheck) {
      Invoke-Step "extension typecheck" { npx tsc --noEmit }
    }

    if (-not $SkipTests -and -not $SkipExtensionTests) {
      Invoke-Step "extension tests" { npm test }
    }

    Invoke-Step "extension build" { npm run build }

    Invoke-Step "validate content script bundle" {
      node -e "const fs=require('fs'); const src=fs.readFileSync('dist/content.js','utf8'); new Function(src); if (/^\s*import\s/m.test(src.slice(0, 512))) { throw new Error('content.js starts with a static import'); }"
    }
  } finally {
    Pop-Location
  }

  if (-not $NoPackage) {
    $backendZip = Join-Path $outDir "piercode_windows_amd64.zip"
    $extensionZip = Join-Path $outDir "extension.zip"

    Invoke-Step "package backend zip" {
      Compress-Archive -Path (Join-Path $binDir "*") -DestinationPath $backendZip -Force
    }

    Invoke-Step "package extension zip" {
      Compress-Archive -Path (Join-Path $extensionDir "dist\*") -DestinationPath $extensionZip -Force
    }
  }

  Write-Host ""
  Write-Host "Build complete: $outDir" -ForegroundColor Green
  Get-ChildItem -Recurse -File $outDir | Select-Object FullName, Length
} finally {
  Pop-Location
}
