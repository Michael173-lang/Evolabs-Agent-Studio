[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ManifestRoot = Join-Path $ProjectRoot "distribution\manifests"
. (Join-Path $PSScriptRoot "pack-manifest.ps1")

$manifests = @(
    Get-ChildItem -Path (Join-Path $ManifestRoot "models") -Filter "*.json" -File | Where-Object Name -notlike "*.template.json"
    Get-ChildItem -Path (Join-Path $ManifestRoot "runtime") -Filter "*.json" -File | Where-Object Name -notlike "*.template.json"
)
if ($manifests.Count -lt 1) { throw "No model/runtime manifests were found." }

$identities = @{}
foreach ($file in $manifests) {
    $manifest = Read-EvolabsPackManifest -Path $file.FullName
    Assert-EvolabsPackManifest -Manifest $manifest -ManifestPath $file.FullName
    $identity = "$($manifest.kind)/$($manifest.id)/$($manifest.version)"
    if ($identities.ContainsKey($identity)) { throw "Duplicate pack identity: $identity" }
    $identities[$identity] = $true
    Write-Host "Verified manifest: $identity" -ForegroundColor DarkGreen
}

$profilePath = Join-Path $ManifestRoot "profiles\rtx3050-4gb.json"
$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$profileText = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($profilePath), $utf8Strict)
$profile = $profileText | ConvertFrom-Json
if ($profile.id -ne "rtx3050-4gb" -or [int]$profile.match.vram_mb_min -lt 3500 -or [int]$profile.match.vram_mb_max -gt 4608) {
    throw "RTX 3050 profile manifest has invalid matching limits."
}
if ([int]$profile.runtime.gpu_workers -ne 1 -or [int]$profile.anime.batch_size -ne 1) {
    throw "RTX 3050 profile must serialize GPU work and use batch size 1."
}

foreach ($required in @(
    "runtime-pack/stable-diffusion-cpp-cuda12/master-810-db99efd",
    "model-pack/anime-core/0.4.0",
    "model-pack/realistic-core/0.4.0"
)) {
    if (-not $identities.ContainsKey($required)) { throw "Required release pack is missing: $required" }
}

Write-Host "$($manifests.Count) release manifests and the RTX 3050 profile passed validation." -ForegroundColor Green
