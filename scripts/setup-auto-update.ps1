[CmdletBinding()]
param(
    [string]$Repository,
    [switch]$SkipInitialPublish,
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureMessage = "External command failed."
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)"
    }
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Resolve-WinGet {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Install-WithWinGet {
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )
    $winget = Resolve-WinGet
    if (-not $winget) {
        throw "$DisplayName is missing and WinGet is unavailable. Install $DisplayName, then run this setup again."
    }
    Write-Host "Installing the official $DisplayName package once..." -ForegroundColor Cyan
    & $winget install --id $PackageId --exact --source winget --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -notin @(0, 1641, 3010)) {
        throw "$DisplayName installation failed (exit code $LASTEXITCODE)."
    }
    Refresh-ProcessPath
}

function Resolve-Gh {
    $command = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    Install-WithWinGet -PackageId "GitHub.cli" -DisplayName "GitHub CLI"
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "GitHub CLI\gh.exe")
    )) {
        if ($candidate -and (Test-Path $candidate -PathType Leaf)) { return $candidate }
    }
    $command = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "GitHub CLI is still unavailable."
}

function Resolve-Git {
    $command = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    Install-WithWinGet -PackageId "Git.Git" -DisplayName "Git for Windows"
    $command = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:ProgramFiles "Git\cmd\git.exe"
    if (Test-Path $candidate -PathType Leaf) { return $candidate }
    throw "Git is still unavailable."
}

function Resolve-Npm {
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    Install-WithWinGet -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
    if (Test-Path $candidate -PathType Leaf) { return $candidate }
    throw "npm is still unavailable."
}

function Resolve-Python {
    foreach ($candidate in @("py.exe", "python.exe")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        if ($candidate -eq "py.exe") {
            & $command.Source -3.11 -c "import sys; print(sys.version)" *> $null
            if ($LASTEXITCODE -eq 0) { return @($command.Source, "-3.11") }
        }
        else {
            & $command.Source -c "import sys; assert sys.version_info >= (3, 11)" *> $null
            if ($LASTEXITCODE -eq 0) { return @($command.Source) }
        }
    }

    Install-WithWinGet -PackageId "Python.Python.3.11" -DisplayName "Python 3.11 x64"
    foreach ($candidate in @("py.exe", "python.exe")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        if ($candidate -eq "py.exe") {
            & $command.Source -3.11 -c "import sys; print(sys.version)" *> $null
            if ($LASTEXITCODE -eq 0) { return @($command.Source, "-3.11") }
        }
        else {
            & $command.Source -c "import sys; assert sys.version_info >= (3, 11)" *> $null
            if ($LASTEXITCODE -eq 0) { return @($command.Source) }
        }
    }
    throw "Python 3.11 or newer is still unavailable."
}

function Find-ReleaseRun {
    param(
        [Parameter(Mandatory = $true)][string]$Gh,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Tag,
        [int]$WaitSeconds = 180
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
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

function Wait-ForSignedRelease {
    param(
        [Parameter(Mandatory = $true)][string]$Gh,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Tag
    )
    Write-Host "Waiting for GitHub to build, test and sign $Tag. No local compiler is used..." -ForegroundColor Cyan
    $runId = Find-ReleaseRun -Gh $Gh -Repository $Repository -Tag $Tag
    if (-not $runId) {
        throw "The GitHub Actions release run did not appear. Open https://github.com/$Repository/actions to inspect it."
    }
    Invoke-Checked $Gh @("run", "watch", $runId, "--repo", $Repository, "--exit-status") "The cloud release build failed."
}

function Download-InitialInstaller {
    param(
        [Parameter(Mandatory = $true)][string]$Gh,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Tag
    )
    $downloadRoot = Join-Path $ProjectRoot "release-downloads\$Tag"
    New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
    Invoke-Checked $Gh @("release", "download", $Tag, "--repo", $Repository, "--pattern", "*.exe", "--dir", $downloadRoot, "--clobber") "Could not download the signed release installer."
    $installer = Get-ChildItem -Path $downloadRoot -Filter "*.exe" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $installer) { throw "The release completed but no Windows Setup.exe was found." }
    Write-Host "Installer downloaded: $($installer.FullName)" -ForegroundColor Green
    if (-not $NoInstall) {
        $answer = Read-Host "Install Evolabs $Tag now? [Y/n]"
        if (-not $answer -or $answer.Trim().ToLowerInvariant() -in @("y", "yes")) {
            Start-Process -FilePath $installer.FullName
        }
    }
}

Set-Location $ProjectRoot
if (-not (Test-Path (Join-Path $ProjectRoot "package.json") -PathType Leaf)) {
    throw "Run this script from the Evolabs source folder."
}

$Gh = Resolve-Gh
& $Gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Sign in to GitHub once in the browser window..." -ForegroundColor Cyan
    Invoke-Checked $Gh @("auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web") "GitHub sign-in failed."
}
$login = (& $Gh api user --jq .login).Trim()
if (-not $login) { throw "Could not determine the signed-in GitHub account." }
Invoke-Checked $Gh @("auth", "setup-git", "--hostname", "github.com") "Could not configure GitHub credentials for Git."

if (-not $Repository) {
    $defaultRepository = "$login/Evolabs-Agent-Studio"
    Write-Host "Evolabs needs one PUBLIC GitHub repository so installed apps can download latest.json without signing in." -ForegroundColor Yellow
    $entered = Read-Host "Repository [$defaultRepository]"
    $Repository = if ($entered.Trim()) { $entered.Trim() } else { $defaultRepository }
}
$Repository = $Repository.Trim()
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "Repository must use owner/repo format."
}

$repoJson = & $Gh repo view $Repository --json nameWithOwner,visibility 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating public GitHub repository $Repository..." -ForegroundColor Cyan
    Invoke-Checked $Gh @("repo", "create", $Repository, "--public", "--description", "Evolabs Agent Studio releases and source") "GitHub repository creation failed."
    $repoJson = & $Gh repo view $Repository --json nameWithOwner,visibility
}
$repoInfo = $repoJson | ConvertFrom-Json
if ($repoInfo.visibility -ne "PUBLIC") {
    throw "The updater repository must be PUBLIC. Installed apps cannot download private GitHub Releases without a user token."
}

$Npm = Resolve-Npm
$TauriCli = Join-Path $ProjectRoot "node_modules\.bin\tauri.cmd"
if (-not (Test-Path $TauriCli -PathType Leaf)) {
    Write-Host "Installing the exact pinned Evolabs release tools..." -ForegroundColor Cyan
    Invoke-Checked $Npm @("ci") "npm ci failed."
}
if (-not (Test-Path $TauriCli -PathType Leaf)) {
    throw "Tauri CLI was not installed by npm ci."
}

$KeyRoot = Join-Path $env:USERPROFILE ".evolabs\updater"
$PrivateKeyPath = Join-Path $KeyRoot "evolabs-updater.key"
$PublicKeyPath = "$PrivateKeyPath.pub"
New-Item -ItemType Directory -Force -Path $KeyRoot | Out-Null

if (-not (Test-Path $PrivateKeyPath -PathType Leaf) -or -not (Test-Path $PublicKeyPath -PathType Leaf)) {
    Remove-Item $PrivateKeyPath, $PublicKeyPath -Force -ErrorAction SilentlyContinue
    Write-Host "Generating the one-time Evolabs updater signing key..." -ForegroundColor Cyan
    & $TauriCli signer generate --ci -w $PrivateKeyPath -f *> $null
    if ($LASTEXITCODE -ne 0) {
        Remove-Item $PrivateKeyPath, $PublicKeyPath -Force -ErrorAction SilentlyContinue
        Write-Host "Press Enter twice if the Tauri CLI asks for an optional password." -ForegroundColor Yellow
        Invoke-Checked $TauriCli @("signer", "generate", "-w", $PrivateKeyPath) "Updater signing key generation failed."
    }
}
if (-not (Test-Path $PrivateKeyPath -PathType Leaf) -or -not (Test-Path $PublicKeyPath -PathType Leaf)) {
    throw "Tauri did not create the updater key pair."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $KeyRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" *> $null

$PrivateKey = [IO.File]::ReadAllText($PrivateKeyPath, [Text.UTF8Encoding]::new($false)).Trim()
if (-not $PrivateKey) { throw "The generated updater private key is empty." }
$PrivateKey | & $Gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $Repository
if ($LASTEXITCODE -ne 0) { throw "Could not save the updater signing key as a GitHub Actions secret." }
# An unencrypted updater key does not require a password secret.
# Deleting a secret that does not exist returns HTTP 404; that is harmless.
& cmd.exe /d /s /c "`"$Gh`" secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo `"$Repository`" >nul 2>&1"
$global:LASTEXITCODE = 0

$Python = Resolve-Python
$PythonExe = $Python[0]
$PythonPrefix = @()
if ($Python.Count -gt 1) { $PythonPrefix = $Python[1..($Python.Count - 1)] }
$configureArgs = @($PythonPrefix + @(
    (Join-Path $ProjectRoot "scripts\configure-updater.py"),
    "--repository", $Repository,
    "--public-key-file", $PublicKeyPath
))
Invoke-Checked $PythonExe $configureArgs "Could not write the signed updater configuration."

$Git = Resolve-Git
if (-not (Test-Path (Join-Path $ProjectRoot ".git"))) {
    & $Git init -b main *> $null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Checked $Git @("init") "git init failed."
        Invoke-Checked $Git @("branch", "-M", "main") "Could not create the main branch."
    }
}

if (-not (& $Git config user.name)) { Invoke-Checked $Git @("config", "user.name", $login) }
if (-not (& $Git config user.email)) { Invoke-Checked $Git @("config", "user.email", "$login@users.noreply.github.com") }

$remoteUrl = "https://github.com/$Repository.git"
& $Git remote get-url origin *> $null
if ($LASTEXITCODE -eq 0) {
    Invoke-Checked $Git @("remote", "set-url", "origin", $remoteUrl) "Could not update the origin remote."
}
else {
    Invoke-Checked $Git @("remote", "add", "origin", $remoteUrl) "Could not add the origin remote."
}

Invoke-Checked $PythonExe @($PythonPrefix + @((Join-Path $ProjectRoot "scripts\validate-source-release.py"))) "Evolabs source validation failed."
Invoke-Checked $Git @("add", "-A") "git add failed."
& $Git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    Invoke-Checked $Git @("commit", "-m", "Configure Evolabs Agent Studio signed updates") "git commit failed."
}
Invoke-Checked $Git @("branch", "-M", "main") "Could not select the main branch."
Invoke-Checked $Git @("push", "-u", "origin", "main") "Could not push the Evolabs source to GitHub."

$Version = (Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json).version
$Tag = "v$Version"
if (-not $SkipInitialPublish) {
    & $Git rev-parse $Tag *> $null
    $hasLocalTag = $LASTEXITCODE -eq 0
    $remoteTag = & $Git ls-remote --tags origin "refs/tags/$Tag"
    if (-not $hasLocalTag -and -not $remoteTag) {
        Invoke-Checked $Git @("tag", "-a", $Tag, "-m", "Evolabs Agent Studio $Tag") "Could not create the initial release tag."
        Invoke-Checked $Git @("push", "origin", $Tag) "Could not start the initial GitHub release build."
    }
    elseif ($hasLocalTag -and -not $remoteTag) {
        Invoke-Checked $Git @("push", "origin", $Tag) "Could not push the initial release tag."
    }
    else {
        Write-Host "$Tag already exists; the existing release will be used." -ForegroundColor DarkYellow
    }

    & $Gh release view $Tag --repo $Repository *> $null
    if ($LASTEXITCODE -ne 0) { Wait-ForSignedRelease -Gh $Gh -Repository $Repository -Tag $Tag }
    Download-InitialInstaller -Gh $Gh -Repository $Repository -Tag $Tag
}

Write-Host ""
Write-Host "Signed automatic updates are configured." -ForegroundColor Green
Write-Host "Repository: https://github.com/$Repository"
Write-Host "Future releases: double-click PUBLISH_UPDATE.bat."
Write-Host "Signing key backup folder: $KeyRoot" -ForegroundColor Yellow
Write-Host "Back up that folder securely. Losing the private key prevents updates to already-installed copies." -ForegroundColor Yellow
