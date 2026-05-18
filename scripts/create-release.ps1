# Create Release Tag Script
param(
    [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Version) {
    Write-Error "Please provide a version tag (e.g., v1.0.0)"
    Write-Host "Usage: .\scripts\create-release.ps1 v1.0.0" -ForegroundColor Yellow
    exit 1
}

if ($Version -notmatch "^v\d+\.\d+\.\d+") {
    Write-Error "Version must start with 'v' and follow semver format (e.g., v1.0.0, v1.2.3)"
    exit 1
}

Write-Host "Creating release tag: $Version" -ForegroundColor Cyan

# Check if tag already exists
$existingTag = git tag -l $Version
if ($existingTag) {
    Write-Error "Tag $Version already exists!"
    exit 1
}

# Create and push tag
git tag -a $Version -m "Release $Version"
git push origin $Version

Write-Host ""
Write-Host "✅ Tag $Version created and pushed!" -ForegroundColor Green
Write-Host "GitHub Actions will now build and create the release." -ForegroundColor Cyan
Write-Host ""
Write-Host "Monitor progress: https://github.com/Sirhap/PierCode/actions" -ForegroundColor Yellow
