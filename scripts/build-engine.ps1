$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EngineRoot = Join-Path $ProjectRoot "engine"
$BuildRoot = Join-Path $ProjectRoot ".build"
$VirtualEnvironment = Join-Path $BuildRoot "engine-venv"
$PythonExecutable = Join-Path $VirtualEnvironment "Scripts\python.exe"
$ResourceRoot = Join-Path $ProjectRoot "src-tauri\resources\engine"
$ManifestSourceRoot = Join-Path $ProjectRoot "distribution\manifests"
$ManifestResourceRoot = Join-Path $ProjectRoot "src-tauri\resources\manifests"
$SmokeRoot = Join-Path $BuildRoot "engine-render-smoke"
$SmokeJobId = "job_00000000-0000-4000-8000-000000000001"
$PyInstallerVersion = "6.21.0"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Executable $($Arguments -join ' ')"
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}


function Read-Utf8Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    $Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    $JsonText = [System.IO.File]::ReadAllText(
        [System.IO.Path]::GetFullPath($Path),
        $Utf8Strict
    )
    return $JsonText | ConvertFrom-Json
}

New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null

if (Test-Path $PythonExecutable -PathType Leaf) {
    $ExistingPythonArchitecture = [string](@(& $PythonExecutable "-c" "import platform, struct; print(platform.python_version() + '|' + str(struct.calcsize('P') * 8))" 2>$null) | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or $ExistingPythonArchitecture -notmatch '^3\.11\.\d+\|64$') {
        Write-Warning "Recreating incompatible Engine build venv ('$ExistingPythonArchitecture')."
        Remove-Item -Recurse -Force $VirtualEnvironment
    }
}
if (-not (Test-Path $PythonExecutable -PathType Leaf)) {
    $BootstrapPython = $env:EVOLABS_PYTHON311
    if (-not $BootstrapPython) {
        $BootstrapPython = "py"
        Invoke-Checked $BootstrapPython "-3.11" "-m" "venv" $VirtualEnvironment
    }
    else {
        if (-not (Test-Path $BootstrapPython -PathType Leaf)) { throw "EVOLABS_PYTHON311 does not point to a Python executable." }
        Invoke-Checked $BootstrapPython "-m" "venv" $VirtualEnvironment
    }
}

$PythonArchitecture = [string](@(& $PythonExecutable "-c" "import platform, struct; print(platform.python_version() + '|' + str(struct.calcsize('P') * 8))") | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or $PythonArchitecture -notmatch '^3\.11\.\d+\|64$') {
    throw "Engine build venv must use 64-bit CPython 3.11; detected '$PythonArchitecture'."
}

Invoke-Checked $PythonExecutable "-m" "pip" "install" "--disable-pip-version-check" "pyinstaller==$PyInstallerVersion"
Invoke-Checked $PythonExecutable "-m" "pip" "install" "--disable-pip-version-check" "--upgrade" "--force-reinstall" $EngineRoot
Invoke-Checked $PythonExecutable "-m" "pip" "check"
Invoke-Checked $PythonExecutable (Join-Path $PSScriptRoot "validate-engine-manifests.py") "--manifest-root" $ManifestSourceRoot

Push-Location $EngineRoot
try {
    Invoke-Checked $PythonExecutable "-m" "unittest" "discover" "-s" "tests" "-v"
    Invoke-Checked $PythonExecutable "-m" "PyInstaller" "--clean" "--noconfirm" "evolabs-engine.spec"
}
finally {
    Pop-Location
}

if (Test-Path $ResourceRoot) {
    Remove-Item -Recurse -Force $ResourceRoot
}
New-Item -ItemType Directory -Force -Path $ResourceRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $EngineRoot "dist\evolabs-engine\*") $ResourceRoot

$EngineExecutable = Join-Path $ResourceRoot "evolabs-engine.exe"
if (-not (Test-Path $EngineExecutable -PathType Leaf)) {
    throw "PyInstaller did not produce evolabs-engine.exe."
}

$EngineHelp = @(& $EngineExecutable "--help" 2>&1)
if ($LASTEXITCODE -ne 0 -or ($EngineHelp -join "`n") -notmatch '--install-model-pack' -or ($EngineHelp -join "`n") -notmatch '--install-id') {
    throw "Bundled Engine CLI does not expose the model installer contract required by the Tauri App."
}

$HealthLines = @(& $EngineExecutable "--data-root" (Join-Path $BuildRoot "engine-health") "--health-check")
if ($LASTEXITCODE -ne 0) {
    throw "Bundled Engine health check failed with exit code $LASTEXITCODE."
}
$HealthLine = $HealthLines | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1
if (-not $HealthLine) {
    throw "Bundled Engine health check returned no JSON."
}
$HealthEnvelope = $HealthLine | ConvertFrom-Json
if ($HealthEnvelope.ok -eq $false) {
    throw "Bundled Engine reported an unhealthy state."
}
$Health = if ($HealthEnvelope.result) { $HealthEnvelope.result } else { $HealthEnvelope }
if ([int]$Health.protocolVersion -ne 1) {
    throw "Bundled Engine protocol is incompatible: $($Health.protocolVersion)"
}
if (-not $Health.engineVersion) {
    throw "Bundled Engine health response omitted engineVersion."
}
if ($Health.functionalCoreReady -ne $true -or $Health.ffmpegReady -ne $true) {
    throw "Bundled Engine does not report a ready FFmpeg functional core."
}

$BundledFfmpeg = @(Get-ChildItem -Path $ResourceRoot -Recurse -File | Where-Object {
    $_.Name -like "ffmpeg*.exe"
})
if ($BundledFfmpeg.Count -lt 1) {
    throw "The PyInstaller Engine does not contain imageio-ffmpeg's ffmpeg executable. Update evolabs-engine.spec before packaging."
}

if (Test-Path $SmokeRoot) {
    Remove-Item -Recurse -Force $SmokeRoot
}
New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
$SmokeProjectPath = Join-Path $SmokeRoot "project.json"
$SmokeProject = [ordered]@{
    schemaVersion = 1
    id = "project_build_smoke"
    title = "Evolabs build smoke"
    story = "Two short scenes verify the packaged renderer."
    updatedAt = [DateTime]::UtcNow.ToString("o")
    workflowStep = 3
    maxUnlockedStep = 3
    settings = [ordered]@{
        mode = "anime"
        format = "9:16"
        targetSeconds = 2
        quality = "speed"
        renderMode = "comic"
        captions = $true
    }
    characters = @(
        [ordered]@{
            id = "character_smoke"
            name = "Evo"
            role = "主角"
            appearance = "黑色極簡剪影"
            voice = "中性・自然"
            locked = $true
            accent = "#c7cad1"
        }
    )
    scenes = @(
        [ordered]@{
            id = "scene_smoke_1"
            order = 1
            title = "第一鏡"
            visual = "黑色背景上的白色圓形"
            dialogue = "Evo：核心引擎開始測試。"
            characterIds = @("character_smoke")
            duration = 1
            shot = "中景・固定鏡頭"
            status = "ready"
            progress = 0
        },
        [ordered]@{
            id = "scene_smoke_2"
            order = 2
            title = "第二鏡"
            visual = "極簡光線緩慢移動"
            dialogue = "Evo：影片輸出完成。"
            characterIds = @("character_smoke")
            duration = 1
            shot = "近景・緩慢推進"
            status = "ready"
            progress = 0
        }
    )
}
Write-Utf8NoBom -Path $SmokeProjectPath -Content ($SmokeProject | ConvertTo-Json -Depth 12)

$SmokeLog = Join-Path $SmokeRoot "engine.log"
& $EngineExecutable `
    "--data-root" $SmokeRoot `
    "--render-project" $SmokeProjectPath `
    "--job-id" $SmokeJobId *> $SmokeLog
if ($LASTEXITCODE -ne 0) {
    throw "Bundled Engine render smoke failed with exit code $LASTEXITCODE. See $SmokeLog"
}

$SmokeStatusPath = Join-Path $SmokeRoot "jobs\$SmokeJobId\status.json"
if (-not (Test-Path $SmokeStatusPath -PathType Leaf)) {
    throw "Bundled Engine render smoke did not write status.json."
}
$SmokeStatus = Read-Utf8Json -Path $SmokeStatusPath
if (@("complete", "completed", "succeeded") -notcontains [string]$SmokeStatus.state) {
    throw "Bundled Engine render smoke ended in unexpected state '$($SmokeStatus.state)'."
}
$SmokeOutputValue = if ($SmokeStatus.outputPath) { $SmokeStatus.outputPath } else { $SmokeStatus.output_path }
if (-not $SmokeOutputValue) {
    throw "Bundled Engine render smoke status omitted outputPath."
}
$SmokeOutputPath = [string]$SmokeOutputValue
if (-not [System.IO.Path]::IsPathRooted($SmokeOutputPath)) {
    $SmokeOutputPath = Join-Path $SmokeRoot $SmokeOutputPath
}
if (-not (Test-Path $SmokeOutputPath -PathType Leaf)) {
    throw "Bundled Engine render smoke output does not exist: $SmokeOutputPath"
}
$SmokeOutput = Get-Item $SmokeOutputPath
if ($SmokeOutput.Length -le 0 -or $SmokeOutput.Extension -ne ".mp4") {
    throw "Bundled Engine render smoke output is not a non-empty MP4."
}
$Header = [System.IO.File]::ReadAllBytes($SmokeOutput.FullName)
if ($Header.Length -lt 12 -or [System.Text.Encoding]::ASCII.GetString($Header, 4, 4) -ne "ftyp") {
    throw "Bundled Engine render smoke output does not have an MP4 file signature."
}

if (Test-Path $ManifestResourceRoot) {
    Remove-Item -Recurse -Force $ManifestResourceRoot
}
New-Item -ItemType Directory -Force -Path $ManifestResourceRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $ManifestSourceRoot "*") $ManifestResourceRoot
$NoticeRoot = Join-Path $ManifestResourceRoot "notices"
New-Item -ItemType Directory -Force -Path $NoticeRoot | Out-Null
$FfmpegLicenseLines = @(& $BundledFfmpeg[0].FullName "-hide_banner" "-L" 2>&1)
if ($LASTEXITCODE -ne 0 -or $FfmpegLicenseLines.Count -lt 1) {
    throw "Bundled FFmpeg did not provide its license text."
}
Write-Utf8NoBom -Path (Join-Path $NoticeRoot "ffmpeg-license.txt") -Content ($FfmpegLicenseLines -join [Environment]::NewLine)
$RuntimeManifestRoot = Join-Path $ManifestResourceRoot "runtime"
New-Item -ItemType Directory -Force -Path $RuntimeManifestRoot | Out-Null

$Artifacts = @()
$EngineFiles = @(Get-ChildItem -Path $ResourceRoot -Recurse -File)
foreach ($Artifact in $EngineFiles) {
    $RelativePath = $Artifact.FullName.Substring($ResourceRoot.Length).TrimStart('\', '/') -replace '\\', '/'
    $Artifacts += [ordered]@{
        relativePath = $RelativePath
        size = $Artifact.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -Path $Artifact.FullName).Hash.ToLowerInvariant()
    }
}
$ModelManifestRecords = @()
foreach ($ModelManifestFile in @(Get-ChildItem -Path (Join-Path $ManifestSourceRoot "models") -Filter "*.json" -File | Where-Object Name -notlike "*.template.json")) {
    $ModelManifest = Read-Utf8Json -Path $ModelManifestFile.FullName
    $DownloadBytes = 0L
    foreach ($ModelFile in @($ModelManifest.files)) {
        $FileBytes = [int64]$ModelFile.size
        if ($FileBytes -le 0 -or $DownloadBytes -gt [int64]::MaxValue - $FileBytes) {
            throw "Model manifest download size is invalid: $($ModelManifestFile.Name)"
        }
        $DownloadBytes += $FileBytes
    }
    $ModelManifestRecords += [ordered]@{
        id = [string]$ModelManifest.id
        version = [string]$ModelManifest.version
        relativePath = "models/$($ModelManifestFile.Name)"
        sha256 = (Get-FileHash -Algorithm SHA256 -Path $ModelManifestFile.FullName).Hash.ToLowerInvariant()
        downloadBytes = $DownloadBytes
    }
}
$Package = Read-Utf8Json -Path (Join-Path $ProjectRoot "package.json")
$BuildManifest = [ordered]@{
    schemaVersion = 1
    id = "evolabs-functional-core"
    appVersion = [string]$Package.version
    engineVersion = [string]$Health.engineVersion
    protocolVersion = [int]$Health.protocolVersion
    target = "x86_64-pc-windows-msvc"
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
    modelPacksIncluded = @()
    modelPayloadsIncluded = $false
    modelManifestsIncluded = $ModelManifestRecords
    renderSmoke = [ordered]@{
        passed = $true
        scenes = 2
        outputBytes = $SmokeOutput.Length
        outputSha256 = (Get-FileHash -Algorithm SHA256 -Path $SmokeOutput.FullName).Hash.ToLowerInvariant()
    }
    artifacts = $Artifacts
}
Write-Utf8NoBom `
    -Path (Join-Path $RuntimeManifestRoot "functional-core.build.json") `
    -Content ($BuildManifest | ConvertTo-Json -Depth 10)

Write-Host "Evolabs functional-core Engine $($Health.engineVersion) passed health and MP4 render smoke checks." -ForegroundColor Green
