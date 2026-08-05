[CmdletBinding()]
param(
    [string]$Repository = "Michael173-lang/Evolabs-Agent-Studio",
    [string]$Notes,
    [switch]$Replace
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureMessage = "外部指令執行失敗。"
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage（錯誤碼 $LASTEXITCODE）" }
}

function Resolve-Gh {
    $found = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $candidate = Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"
    if (Test-Path $candidate -PathType Leaf) { return $candidate }
    throw "找不到 GitHub CLI。請先安裝 GitHub CLI，或執行 SETUP_AUTO_UPDATE.bat。"
}

$Package = Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json
$Version = [string]$Package.version
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$') {
    throw "package.json 版本不是完整 SemVer：$Version"
}
$Tag = "v$Version"
$ReleaseRoot = Join-Path $ProjectRoot ("release\v{0}" -f $Version)
$BuildResultPath = Join-Path $ReleaseRoot "build-result.json"
if (-not (Test-Path $BuildResultPath -PathType Leaf)) {
    throw "找不到本機建置結果：$BuildResultPath。請先執行 1_BUILD_AND_TEST.bat。"
}
$BuildResult = Get-Content -Raw -Encoding UTF8 $BuildResultPath | ConvertFrom-Json
$Installer = Get-Item ([string]$BuildResult.installer) -ErrorAction Stop
$SignaturePath = [string]$BuildResult.signature
if (-not (Test-Path $SignaturePath -PathType Leaf)) { throw "找不到 updater 簽章：$SignaturePath" }
$Signature = [IO.File]::ReadAllText($SignaturePath, [Text.UTF8Encoding]::new($false)).Trim()
if (-not $Signature) { throw "Updater 簽章檔是空白檔案。" }
$HashFile = Get-ChildItem $ReleaseRoot -Filter "*.sha256" -File | Select-Object -First 1
if (-not $HashFile) { throw "找不到 SHA-256 驗證檔。" }
if ($Installer.Length -lt 1MB) { throw "安裝程式大小異常，因此停止發布。" }

$Gh = Resolve-Gh
& $Gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "請在瀏覽器完成一次 GitHub 登入。" -ForegroundColor Cyan
    Invoke-Checked $Gh @("auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web") "GitHub 登入失敗。"
}

if (-not $Notes) {
    $NotesPath = Join-Path $ProjectRoot ("RELEASE_NOTES_v{0}.md" -f $Version)
    if (Test-Path $NotesPath -PathType Leaf) {
        $Notes = Get-Content -Raw -Encoding UTF8 $NotesPath
    }
    else {
        $Notes = "Evolabs $Version 本機建置版本。"
    }
}
$NotesFile = Join-Path $ReleaseRoot "release-notes.md"
[IO.File]::WriteAllText($NotesFile, $Notes, [Text.UTF8Encoding]::new($false))

$EncodedAsset = [Uri]::EscapeDataString($Installer.Name)
$DownloadUrl = "https://github.com/$Repository/releases/download/$Tag/$EncodedAsset"
$Latest = [ordered]@{
    version = $Version
    notes = $Notes
    pub_date = [DateTime]::UtcNow.ToString("o")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $Signature
            url = $DownloadUrl
        }
    }
}
$LatestPath = Join-Path $ReleaseRoot "latest.json"
[IO.File]::WriteAllText(
    $LatestPath,
    ($Latest | ConvertTo-Json -Depth 8),
    [Text.UTF8Encoding]::new($false)
)

$Assets = @($Installer.FullName, $SignaturePath, $HashFile.FullName, $LatestPath)
$CheckCommand = "`"$Gh`" release view `"$Tag`" --repo `"$Repository`" >nul 2>&1"
& $env:ComSpec /d /s /c $CheckCommand
$ReleaseExists = $LASTEXITCODE -eq 0
$global:LASTEXITCODE = 0

if ($ReleaseExists) {
    if (-not $Replace) {
        $answer = Read-Host "$Tag 已存在。覆蓋同名發行檔案？[y/N]"
        if ($answer.Trim().ToLowerInvariant() -notin @("y", "yes")) {
            throw "發布已取消；既有 Release 沒有變更。"
        }
    }
    Invoke-Checked $Gh (@("release", "upload", $Tag, "--repo", $Repository, "--clobber") + $Assets) "無法覆蓋發行檔案。"
    $editArgs = @("release", "edit", $Tag, "--repo", $Repository, "--title", "Evolabs Agent Studio $Tag", "--notes-file", $NotesFile, "--draft=false")
    if ($Version.Contains("-")) { $editArgs += "--prerelease" }
    Invoke-Checked $Gh $editArgs "無法更新 Release 資訊。"
}
else {
    $createArgs = @("release", "create", $Tag, "--repo", $Repository, "--target", "main", "--title", "Evolabs Agent Studio $Tag", "--notes-file", $NotesFile)
    if ($Version.Contains("-")) { $createArgs += "--prerelease" }
    $createArgs += $Assets
    Invoke-Checked $Gh $createArgs "無法建立 GitHub Release。"
}

$ReleaseUrl = (& $Gh release view $Tag --repo $Repository --json url --jq .url).Trim()
if ($LASTEXITCODE -ne 0 -or -not $ReleaseUrl) { throw "檔案已上傳，但無法確認 Release 網址。" }
Write-Host ""
Write-Host "Evolabs $Tag 已發布。" -ForegroundColor Green
Write-Host "Release：$ReleaseUrl"
Write-Host "本機發行檔案：$ReleaseRoot"
