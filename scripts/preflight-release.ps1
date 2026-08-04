$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ResourceRoot = Join-Path $ProjectRoot "src-tauri\resources\engine"
$EngineExecutable = Join-Path $ResourceRoot "evolabs-engine.exe"
$BuildManifestPath = Join-Path $ProjectRoot "src-tauri\resources\manifests\runtime\functional-core.build.json"
$FfmpegNoticePath = Join-Path $ProjectRoot "src-tauri\resources\manifests\notices\ffmpeg-license.txt"
$Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($Path), $Utf8Strict)
}
$Package = Read-Utf8Text -Path (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json
$TauriConfig = Read-Utf8Text -Path (Join-Path $ProjectRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json
$CargoPackageVersion = [regex]::Match(
    (Read-Utf8Text -Path (Join-Path $ProjectRoot "src-tauri\Cargo.toml")),
    '(?ms)^\[package\].*?^version\s*=\s*"(?<version>[^"]+)"'
).Groups["version"].Value

& (Join-Path $PSScriptRoot "validate-distribution.ps1")

if (-not $Package.version -or $Package.version -ne $TauriConfig.version -or $Package.version -ne $CargoPackageVersion) {
    throw "package.json, tauri.conf.json, and src-tauri/Cargo.toml must contain the same non-empty version."
}
if (-not (Test-Path $EngineExecutable -PathType Leaf)) {
    throw "Bundled Engine is missing. Run scripts\build-engine.ps1 first."
}
if (-not (Test-Path $BuildManifestPath -PathType Leaf)) {
    throw "Functional-core build manifest is missing. Run scripts\build-engine.ps1 first."
}
if (-not (Test-Path $FfmpegNoticePath -PathType Leaf) -or (Get-Item $FfmpegNoticePath).Length -le 0) {
    throw "Bundled FFmpeg license notice is missing. Run scripts\build-engine.ps1 first."
}

$Manifest = Read-Utf8Text -Path $BuildManifestPath | ConvertFrom-Json
if ($Manifest.appVersion -ne $Package.version -or $Manifest.engineVersion -ne $Package.version -or [int]$Manifest.protocolVersion -ne 1) {
    throw "Functional-core build manifest has an incompatible App or protocol version."
}
if ($Manifest.renderSmoke.passed -ne $true -or [int64]$Manifest.renderSmoke.outputBytes -le 0) {
    throw "Functional-core render smoke evidence is missing or invalid."
}
if (@($Manifest.modelPacksIncluded).Count -ne 0 -or $Manifest.modelPayloadsIncluded -ne $false) {
    throw "Source/NSIS release must not embed AI model payloads."
}
$ExpectedModelIds = @("anime-core", "realistic-core")
$SeenModelIds = @()
foreach ($ModelManifest in @($Manifest.modelManifestsIncluded)) {
    $RelativePath = ([string]$ModelManifest.relativePath) -replace '/', '\'
    if (-not $RelativePath.StartsWith("models\") -or [System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.Contains("..")) {
        throw "Build manifest contains an unsafe model manifest path."
    }
    $BundledManifestPath = Join-Path (Join-Path $ProjectRoot "src-tauri\resources\manifests") $RelativePath
    if (-not (Test-Path $BundledManifestPath -PathType Leaf)) { throw "Bundled model manifest is missing: $RelativePath" }
    $Digest = (Get-FileHash -Algorithm SHA256 -Path $BundledManifestPath).Hash.ToLowerInvariant()
    if ($Digest -ne ([string]$ModelManifest.sha256).ToLowerInvariant()) { throw "Bundled model manifest changed after validation: $RelativePath" }
    if ([int64]$ModelManifest.downloadBytes -le 0) { throw "Bundled model manifest download size is invalid: $RelativePath" }
    $SeenModelIds += [string]$ModelManifest.id
}
if (@(Compare-Object -ReferenceObject $ExpectedModelIds -DifferenceObject $SeenModelIds).Count -ne 0) {
    throw "Bundled release must contain exactly anime-core and realistic-core manifests."
}
$UnexpectedPayloads = @(Get-ChildItem -Path (Join-Path $ProjectRoot "src-tauri\resources\manifests") -Recurse -File | Where-Object {
    $_.Extension.ToLowerInvariant() -in @(".safetensors", ".ckpt", ".pt", ".pth", ".pkl", ".pickle", ".onnx", ".zip")
})
if ($UnexpectedPayloads.Count -gt 0) {
    throw "AI payloads must not be bundled in source or NSIS resources: $($UnexpectedPayloads.FullName -join ', ')"
}

$FfmpegSeen = $false
$ManifestPaths = @()
foreach ($Artifact in @($Manifest.artifacts)) {
    $RelativePath = ([string]$Artifact.relativePath) -replace '/', '\'
    if (-not $RelativePath -or [System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.Contains("..")) {
        throw "Build manifest contains an unsafe artifact path."
    }
    $ArtifactPath = Join-Path $ResourceRoot $RelativePath
    if (-not (Test-Path $ArtifactPath -PathType Leaf)) {
        throw "Bundled artifact is missing: $RelativePath"
    }
    $File = Get-Item $ArtifactPath
    if ($File.Length -ne [int64]$Artifact.size) {
        throw "Bundled artifact size changed after verification: $RelativePath"
    }
    $Digest = (Get-FileHash -Algorithm SHA256 -Path $ArtifactPath).Hash.ToLowerInvariant()
    if ($Digest -ne ([string]$Artifact.sha256).ToLowerInvariant()) {
        throw "Bundled artifact hash changed after verification: $RelativePath"
    }
    if ($File.Name -like "ffmpeg*.exe") {
        $FfmpegSeen = $true
    }
    $ManifestPaths += $RelativePath.ToLowerInvariant()
}
if (-not $FfmpegSeen) {
    throw "Verified ffmpeg artifact is absent from the functional-core manifest."
}
$ActualPaths = @(Get-ChildItem -Path $ResourceRoot -Recurse -File | ForEach-Object {
    $_.FullName.Substring($ResourceRoot.Length).TrimStart('\', '/').ToLowerInvariant()
})
$Unlisted = @(Compare-Object -ReferenceObject $ManifestPaths -DifferenceObject $ActualPaths | Where-Object SideIndicator -eq '=>')
if ($Unlisted.Count -gt 0) {
    throw "Engine resources contain files that are absent from the verified manifest: $($Unlisted.InputObject -join ', ')"
}

$HealthLines = @(& $EngineExecutable "--data-root" (Join-Path $ProjectRoot ".build\preflight-health") "--health-check")
if ($LASTEXITCODE -ne 0) {
    throw "Bundled Engine failed the release preflight health check."
}
$HealthLine = $HealthLines | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1
$HealthEnvelope = $HealthLine | ConvertFrom-Json
$Health = if ($HealthEnvelope.result) { $HealthEnvelope.result } else { $HealthEnvelope }
if ($HealthEnvelope.ok -eq $false -or [int]$Health.protocolVersion -ne 1 -or $Health.functionalCoreReady -ne $true -or $Health.ffmpegReady -ne $true) {
    throw "Bundled Engine failed protocol preflight."
}

Write-Host "Evolabs $($Package.version) release resources passed preflight." -ForegroundColor Green
