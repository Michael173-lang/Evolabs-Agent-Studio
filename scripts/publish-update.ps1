[CmdletBinding()]
param(
    [string]$Version,
    [string]$Notes,
    [switch]$NoWait
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureMessage = "External command failed."
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit code $LASTEXITCODE)" }
}

function Resolve-Python {
    $py = (Get-Command py.exe -ErrorAction SilentlyContinue).Source
    if ($py) {
        & $py -3.11 -c "import sys; print(sys.version)" *> $null
        if ($LASTEXITCODE -eq 0) { return @($py, "-3.11") }
    }
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if ($python) {
        & $python -c "import sys; assert sys.version_info >= (3, 11)" *> $null
        if ($LASTEXITCODE -eq 0) { return @($python) }
    }
    throw "Python 3.11 or newer was not found."
}

function Find-ReleaseRun {
    param(
        [Parameter(Mandatory = $true)][string]$Gh,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Tag
    )
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    do {
        $json = & $Gh run list --repo $Repository --workflow windows-installer.yml --limit 30 --json databaseId,headBranch,status,conclusion 2>$null
        if ($LASTEXITCODE -eq 0 -and $json) {
            $runs = @($json | ConvertFrom-Json)
            $run = $runs | Where-Object { $_.headBranch -eq $Tag } | Sort-Object databaseId -Descending | Select-Object -First 1
            if ($run) { return [string]$run.databaseId }
        }
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

$CurrentVersion = (Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json).version
$currentCore = ($CurrentVersion -split '-', 2)[0].Split('.')
if ($currentCore.Count -ne 3) { throw "Current package version is invalid: $CurrentVersion" }
$SuggestedVersion = "{0}.{1}.{2}" -f [int]$currentCore[0], [int]$currentCore[1], ([int]$currentCore[2] + 1)

if (-not $Version) {
    $entered = Read-Host "New Evolabs version [$SuggestedVersion]"
    $Version = if ($entered.Trim()) { $entered.Trim() } else { $SuggestedVersion }
}
$Version = $Version.Trim().TrimStart("v")
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$') {
    throw "Version must be complete SemVer, for example 0.6.1."
}
if ($Version -eq $CurrentVersion) { throw "The new version must differ from $CurrentVersion." }

if (-not $Notes) {
    $enteredNotes = Read-Host "Release summary [Agent workflow, quality and stability improvements]"
    $Notes = if ($enteredNotes.Trim()) { $enteredNotes.Trim() } else { "Agent workflow, quality and stability improvements." }
}

$channel = Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectRoot "src-tauri\resources\update-channel.json") | ConvertFrom-Json
if (-not $channel.enabled -or -not $channel.endpoint -or -not $channel.pubkey) {
    throw "Automatic updates are not configured. Run SETUP_AUTO_UPDATE.bat once first."
}

$Python = Resolve-Python
$PythonExe = $Python[0]
$PythonArgs = @()
if ($Python.Count -gt 1) { $PythonArgs = $Python[1..($Python.Count - 1)] }
Invoke-Checked $PythonExe @($PythonArgs + @((Join-Path $ProjectRoot "scripts\set-version.py"), $Version, "--notes", $Notes)) "Version update failed."
Invoke-Checked $PythonExe @($PythonArgs + @((Join-Path $ProjectRoot "scripts\validate-source-release.py"))) "Source validation failed."

$Git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if (-not $Git -or -not (Test-Path (Join-Path $ProjectRoot ".git"))) {
    throw "This source folder is not connected to GitHub. Run SETUP_AUTO_UPDATE.bat once first."
}
& $Git remote get-url origin *> $null
if ($LASTEXITCODE -ne 0) { throw "Git remote origin is not configured." }

$Tag = "v$Version"
& $Git rev-parse $Tag *> $null
if ($LASTEXITCODE -eq 0) { throw "Tag $Tag already exists. Choose a newer version." }

Invoke-Checked $Git @("add", "-A") "git add failed."
& $Git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { throw "There are no release changes to publish." }
Invoke-Checked $Git @("commit", "-m", "Release Evolabs Agent Studio $Tag") "git commit failed."
Invoke-Checked $Git @("tag", "-a", $Tag, "-m", "Evolabs Agent Studio $Tag") "git tag failed."
Invoke-Checked $Git @("push", "origin", "HEAD") "Could not push the release commit."
Invoke-Checked $Git @("push", "origin", $Tag) "Could not start the GitHub release build."

$origin = (& $Git remote get-url origin).Trim()
$repository = $origin -replace '^https://github\.com/', '' -replace '\.git$', ''
Write-Host ""
Write-Host "Release $Tag was submitted. GitHub is compiling and signing it; this computer does not rebuild the EXE." -ForegroundColor Green

$Gh = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
if (-not $NoWait -and $Gh -and $repository -match '^[^/]+/[^/]+$') {
    $runId = Find-ReleaseRun -Gh $Gh -Repository $repository -Tag $Tag
    if ($runId) {
        Invoke-Checked $Gh @("run", "watch", $runId, "--repo", $repository, "--exit-status") "The GitHub Actions release build failed."
        Write-Host "Evolabs $Tag is published. Installed copies can now use Update and restart." -ForegroundColor Green
    }
    else {
        Write-Host "The cloud run was not found yet. Check https://github.com/$repository/actions" -ForegroundColor Yellow
    }
}
elseif ($repository -match '^[^/]+/[^/]+$') {
    Write-Host "Track it at https://github.com/$repository/actions"
}
