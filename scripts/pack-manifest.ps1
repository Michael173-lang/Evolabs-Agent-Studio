$ErrorActionPreference = "Stop"

function Read-EvolabsPackManifest {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path -PathType Leaf)) {
        throw "Pack manifest does not exist: $Path"
    }
    try {
        # Windows PowerShell 5.1 may decode UTF-8 files as the active ANSI
        # code page when Get-Content is used without an explicit encoding.
        # Read bytes through .NET and decode as UTF-8 so Chinese metadata and
        # JSON quotation marks are preserved exactly.
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $jsonText = [System.IO.File]::ReadAllText(
            [System.IO.Path]::GetFullPath($Path),
            $utf8
        )
        return $jsonText | ConvertFrom-Json
    }
    catch {
        throw "Pack manifest is not valid JSON: $Path ($($_.Exception.Message))"
    }
}

function Test-EvolabsSafeRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [switch]$AllowDot
    )
    if ($AllowDot -and $Value -eq ".") { return $true }
    if (-not $Value -or [System.IO.Path]::IsPathRooted($Value) -or $Value.Contains([char]0)) { return $false }
    if ($Value -match '(^|[\\/])\.\.([\\/]|$)' -or $Value -match '(^|[\\/])\.([\\/]|$)') { return $false }
    if ($Value -match '^[\\/]' -or $Value -match '[:*?"<>|]') { return $false }
    return $true
}

function Get-EvolabsPackManifestErrors {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    $errors = New-Object System.Collections.Generic.List[string]
    $label = Split-Path -Leaf $ManifestPath
    if ([int]$Manifest.schemaVersion -ne 1) { $errors.Add("${label}: schemaVersion must be 1") }
    if (@("model-pack", "runtime-pack") -notcontains [string]$Manifest.kind) { $errors.Add("${label}: invalid kind") }
    if ([string]$Manifest.id -notmatch '^[a-z0-9][a-z0-9._-]{1,63}$') { $errors.Add("${label}: invalid id") }
    if ([string]$Manifest.version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') { $errors.Add("${label}: invalid version") }
    if (@("release", "manifest-template") -notcontains [string]$Manifest.status) { $errors.Add("${label}: invalid status") }
    if ([string]$Manifest.provider -ne "sd-cli") { $errors.Add("${label}: provider must be sd-cli") }

    if ([string]$Manifest.status -eq "manifest-template") {
        if (@($Manifest.files).Count -ne 0) { $errors.Add("${label}: a manifest-template must not contain downloadable files") }
        return @($errors)
    }

    if ([string]$Manifest.install.verification -ne "sha256-and-size") { $errors.Add("${label}: install.verification must be sha256-and-size") }
    if ($Manifest.install.atomicActivate -ne $true) { $errors.Add("${label}: install.atomicActivate must be true") }

    $licenseIds = @{}
    foreach ($license in @($Manifest.licenses)) {
        $licenseId = [string]$license.id
        if ($licenseId -notmatch '^[a-z0-9][a-z0-9._-]{1,63}$') {
            $errors.Add("${label}: invalid license id '$licenseId'")
            continue
        }
        if ($licenseIds.ContainsKey($licenseId)) { $errors.Add("${label}: duplicate license id '$licenseId'") }
        $licenseIds[$licenseId] = $true
        if (-not [string]$license.name) { $errors.Add("${label}: license '$licenseId' has no name") }
        try {
            $licenseUri = [Uri]([string]$license.url)
            if ($licenseUri.Scheme -ne "https" -or -not $licenseUri.Host) { throw "invalid" }
        }
        catch { $errors.Add("${label}: license '$licenseId' must have an HTTPS URL") }
    }
    if ($licenseIds.Count -lt 1) { $errors.Add("${label}: at least one reviewed license is required") }

    $fileIds = @{}
    $destinations = @{}
    $files = @($Manifest.files)
    if ($files.Count -lt 1) { $errors.Add("${label}: a release manifest must contain at least one file") }
    foreach ($file in $files) {
        $fileId = [string]$file.id
        if ($fileId -notmatch '^[a-z0-9][a-z0-9._-]{1,95}$') { $errors.Add("${label}: invalid file id '$fileId'") }
        elseif ($fileIds.ContainsKey($fileId)) { $errors.Add("${label}: duplicate file id '$fileId'") }
        else { $fileIds[$fileId] = $true }
        if (-not [string]$file.role) { $errors.Add("$label/${fileId}: role is required") }
        if (-not (Test-EvolabsSafeRelativePath -Value ([string]$file.fileName))) { $errors.Add("$label/${fileId}: unsafe fileName") }
        if ([int64]$file.size -le 0) { $errors.Add("$label/${fileId}: size must be positive") }
        if ($null -ne $file.sizeBytes -and [int64]$file.sizeBytes -ne [int64]$file.size) { $errors.Add("$label/${fileId}: size and sizeBytes disagree") }
        if ([string]$file.sha256 -cnotmatch '^[a-f0-9]{64}$' -or [string]$file.sha256 -match '^(.)\1{63}$') {
            $errors.Add("$label/${fileId}: sha256 must be a real lowercase 64-character digest")
        }
        if (-not $licenseIds.ContainsKey([string]$file.licenseId)) { $errors.Add("$label/${fileId}: unknown licenseId") }
        try {
            if ([string]$file.url -ne [string]$file.source.url) { throw "url mismatch" }
            $sourceUri = [Uri]([string]$file.url)
            if ($sourceUri.Scheme -ne "https" -or -not $sourceUri.Host -or $sourceUri.UserInfo) { throw "invalid" }
        }
        catch { $errors.Add("$label/${fileId}: source.url must be HTTPS without embedded credentials") }

        $mode = [string]$file.install.mode
        if (@("file", "extract-zip") -notcontains $mode) { $errors.Add("$label/${fileId}: unsupported install mode '$mode'") }
        $expectedKind = if ($mode -eq "extract-zip") { "zip" } else { "file" }
        if ([string]$file.kind -ne $expectedKind) { $errors.Add("$label/${fileId}: kind and install.mode disagree") }
        if ([string]$file.destination -ne [string]$file.install.destination) { $errors.Add("$label/${fileId}: destination and install.destination disagree") }
        $destination = ([string]$file.destination) -replace '\\', '/'
        if (-not (Test-EvolabsSafeRelativePath -Value $destination -AllowDot)) { $errors.Add("$label/${fileId}: unsafe install destination") }
        elseif ($destinations.ContainsKey($destination.ToLowerInvariant())) { $errors.Add("$label/${fileId}: duplicate install destination '$destination'") }
        else { $destinations[$destination.ToLowerInvariant()] = $true }

        if ($mode -eq "file") {
            if ($destination -eq ".") { $errors.Add("$label/${fileId}: file destination cannot be '.'") }
            if ([string]$Manifest.kind -eq "model-pack" -and [System.IO.Path]::GetExtension($destination).ToLowerInvariant() -notin @(
                ".safetensors", ".onnx", ".json", ".txt", ".model", ".vocab", ".yaml", ".yml"
            )) {
                $errors.Add("$label/${fileId}: model packs may not install pickle/checkpoint code formats")
            }
        }
        if ($mode -eq "extract-zip") {
            if ([System.IO.Path]::GetExtension([string]$file.fileName).ToLowerInvariant() -ne ".zip") { $errors.Add("$label/${fileId}: extract-zip source must end in .zip") }
            if ([int64]$file.install.maxExtractedBytes -le 0) { $errors.Add("$label/${fileId}: extract-zip requires maxExtractedBytes") }
            if ([string]$file.install.stripComponents -notin @("none", "auto-single-root")) { $errors.Add("$label/${fileId}: unsupported stripComponents setting") }
        }
    }

    $dependencies = if ($null -ne $Manifest.dependencies) { @($Manifest.dependencies) } else { @() }
    foreach ($dependency in $dependencies) {
        if ([string]$dependency.id -notmatch '^[a-z0-9][a-z0-9._-]{1,63}$') { $errors.Add("${label}: dependency has invalid id") }
        if ([string]$dependency.version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') { $errors.Add("${label}: dependency has invalid version") }
        $dependencyPath = [string]$dependency.manifest
        if (-not (Test-EvolabsSafeRelativePath -Value $dependencyPath)) { $errors.Add("${label}: dependency manifest path is unsafe") }
        else {
            $resolvedDependency = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ManifestPath) $dependencyPath))
            if (-not (Test-Path $resolvedDependency -PathType Leaf)) { $errors.Add("${label}: dependency manifest is missing: $dependencyPath") }
        }
    }

    if ([string]$Manifest.kind -eq "model-pack") {
        if ([string]$Manifest.activation.provider -ne "sd-cli") { $errors.Add("${label}: model activation provider must be sd-cli") }
        if ([string]$Manifest.activation.executableGlob -ne "runtime/**/sd-cli.exe") { $errors.Add("${label}: activation.executableGlob must constrain sd-cli.exe inside runtime") }
        if (-not (Test-EvolabsSafeRelativePath -Value ([string]$Manifest.activation.modelPath))) { $errors.Add("${label}: activation.modelPath is unsafe") }
        foreach ($optionalPath in @("vaePath", "clipVisionPath", "ipAdapterPath")) {
            $value = [string]$Manifest.activation.$optionalPath
            if ($value -and -not (Test-EvolabsSafeRelativePath -Value $value)) { $errors.Add("${label}: activation.$optionalPath is unsafe") }
        }
    }
    else {
        if (-not $Manifest.exports -or @($Manifest.exports.psobject.Properties).Count -lt 1) { $errors.Add("${label}: runtime pack must declare at least one export") }
    }

    if ([int64]$Manifest.hardware.minVramMb -lt 0 -or [int64]$Manifest.hardware.minRamMb -lt 0) {
        $errors.Add("${label}: hardware minimums cannot be negative")
    }
    return @($errors)
}

function Assert-EvolabsPackManifest {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )
    $errors = @(Get-EvolabsPackManifestErrors -Manifest $Manifest -ManifestPath $ManifestPath)
    if ($errors.Count -gt 0) {
        throw "Manifest validation failed:`n - $($errors -join "`n - ")"
    }
}
