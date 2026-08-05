[CmdletBinding()]
param(
    [string]$Repository = "Michael173-lang/Evolabs-Agent-Studio",
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Version = (Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json).version
$Branch = "agent/v0.8.0-real-video-studio"
$Tag = "v$Version"
$Title = "Evolabs $Version：真實影片模型與可稽核 Agent 工作室"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureMessage = "外部命令執行失敗。"
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage（結束代碼 $LASTEXITCODE）" }
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Install-WithWinGet {
    param([string]$PackageId, [string]$DisplayName)
    $winget = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
    if (-not $winget) { throw "缺少 $DisplayName，且系統無法使用 WinGet。" }
    Write-Host "正在安裝官方 $DisplayName……" -ForegroundColor Cyan
    & $winget install --id $PackageId --exact --source winget --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -notin @(0, 1641, 3010)) { throw "$DisplayName 安裝失敗。" }
    Refresh-ProcessPath
}

function Resolve-Tool {
    param([string]$Command, [string]$PackageId, [string]$DisplayName, [string[]]$Candidates = @())
    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    Install-WithWinGet -PackageId $PackageId -DisplayName $DisplayName
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path $candidate -PathType Leaf)) { return $candidate }
    }
    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    throw "安裝後仍找不到 $DisplayName。"
}

function Wait-ForWorkflowRun {
    param(
        [string]$Gh,
        [string]$Repository,
        [string]$Workflow,
        [string]$BranchName,
        [string]$HeadSha,
        [int]$Minutes = 5
    )
    $deadline = [DateTime]::UtcNow.AddMinutes($Minutes)
    do {
        $json = & $Gh run list --repo $Repository --workflow $Workflow --branch $BranchName --limit 20 --json databaseId,headSha,status,conclusion 2>$null
        if ($LASTEXITCODE -eq 0 -and $json) {
            $runs = @($json | ConvertFrom-Json)
            $run = $runs | Where-Object { $_.headSha -eq $HeadSha } | Sort-Object databaseId -Descending | Select-Object -First 1
            if ($run) { return [string]$run.databaseId }
        }
        Start-Sleep -Seconds 4
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "找不到 $Workflow 的 GitHub Actions 執行紀錄。"
}

function Copy-ReleaseSource {
    param([string]$Source, [string]$Destination)
    Push-Location $Destination
    try {
        & $Git rm -r --ignore-unmatch . *> $null
        $global:LASTEXITCODE = 0
    }
    finally { Pop-Location }

    $excludedDirectories = @(
        (Join-Path $Source ".git"),
        (Join-Path $Source "node_modules"),
        (Join-Path $Source ".build"),
        (Join-Path $Source "dist"),
        (Join-Path $Source "release"),
        (Join-Path $Source "release-downloads"),
        (Join-Path $Source ".pytest_cache"),
        (Join-Path $Source "src-tauri\target"),
        (Join-Path $Source "scripts\__pycache__"),
        (Join-Path $Source "engine\.pytest_cache")
    )
    $arguments = @($Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD") + $excludedDirectories
    & robocopy.exe @arguments
    if ($LASTEXITCODE -gt 7) { throw "複製 Evolabs 來源碼失敗（robocopy $LASTEXITCODE）。" }
    $global:LASTEXITCODE = 0

    Remove-Item (Join-Path $Destination ".github\workflows\export-source-v080.yml") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Destination "source-export-status.json") -Force -ErrorAction SilentlyContinue
}

if ($Version -notmatch '^0\.8\.0-beta\.1$') {
    throw "此快速發佈器只允許已驗證的 0.8.0-beta.1；目前來源版本為 $Version。"
}

$Gh = Resolve-Tool -Command "gh.exe" -PackageId "GitHub.cli" -DisplayName "GitHub CLI" -Candidates @(
    (Join-Path $env:ProgramFiles "GitHub CLI\gh.exe")
)
$Git = Resolve-Tool -Command "git.exe" -PackageId "Git.Git" -DisplayName "Git for Windows" -Candidates @(
    (Join-Path $env:ProgramFiles "Git\cmd\git.exe")
)

& $Gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "請在瀏覽器完成一次 GitHub 登入。" -ForegroundColor Cyan
    Invoke-Checked $Gh @("auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web") "GitHub 登入失敗。"
}
Invoke-Checked $Gh @("auth", "setup-git", "--hostname", "github.com") "無法設定 GitHub Git 認證。"

$repoInfo = & $Gh repo view $Repository --json nameWithOwner,defaultBranchRef,visibility 2>$null
if ($LASTEXITCODE -ne 0) { throw "無法存取 GitHub repository：$Repository" }
$repo = $repoInfo | ConvertFrom-Json
if ($repo.visibility -ne "PUBLIC") { throw "目前更新通道要求公開 repository。" }

$WorkRoot = Join-Path $env:TEMP ("Evolabs-v080-publish-" + [Guid]::NewGuid().ToString("N"))
$CloneRoot = Join-Path $WorkRoot "repo"
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

try {
    Write-Host "正在建立乾淨的 GitHub 工作副本……" -ForegroundColor Cyan
    Invoke-Checked $Gh @("repo", "clone", $Repository, $CloneRoot, "--", "--filter=blob:none") "無法下載 GitHub repository。"
    Set-Location $CloneRoot
    Invoke-Checked $Git @("fetch", "origin", "main", "--prune") "無法同步 main 分支。"
    # Optional branches may not exist on a first run or may have been deleted after a previous PR.
    foreach ($optionalBranch in @("publish", $Branch)) {
        & $Git fetch origin ("refs/heads/{0}:refs/remotes/origin/{0}" -f $optionalBranch) --prune 2>$null
        $global:LASTEXITCODE = 0
    }
    Invoke-Checked $Git @("checkout", "-B", $Branch, "origin/main") "無法建立發佈分支。"

    Write-Host "正在套用 Evolabs $Version 完整來源碼……" -ForegroundColor Cyan
    Copy-ReleaseSource -Source $ProjectRoot -Destination $CloneRoot
    Set-Location $CloneRoot

    Invoke-Checked $Git @("add", "-A") "無法加入來源碼變更。"
    & $Git diff --cached --quiet
    $NeedsPullRequest = $LASTEXITCODE -ne 0
    $global:LASTEXITCODE = 0

    if ($NeedsPullRequest) {
        Invoke-Checked $Git @("commit", "-m", "Rebuild Evolabs $Version around real video and verifiable agents") "無法建立版本提交。"
        $HeadSha = (& $Git rev-parse HEAD).Trim()
        Invoke-Checked $Git @("push", "origin", "HEAD:refs/heads/$Branch", "--force-with-lease") "無法推送 v0.8 Beta 分支。"

        $existing = & $Gh pr list --repo $Repository --head $Branch --base main --state open --json number,url --jq '.[0]' 2>$null
        if ($LASTEXITCODE -ne 0) { throw "無法查詢 Pull Request。" }
        if ($existing -and $existing -ne "null") {
            $pr = $existing | ConvertFrom-Json
            $PrNumber = [string]$pr.number
            $PrUrl = [string]$pr.url
        }
        else {
            $BodyPath = Join-Path $WorkRoot "pr-body.md"
            @"
## v0.8.0-beta.1 核心重構

- 對話區只保留使用者訊息與具完整模型要求證據的真實 AI 回覆；系統活動獨立稽核。
- Agent 必須完成任務確認，資料不足時停止，不再使用規則式成果冒充 AI。
- 支援與個別 Agent 及製作會議交流，修改以提案形式套用或拒絕。
- AI 影片模式只接受真正 ComfyUI 影片工作流輸出；動態漫畫完全隔離。
- 新增逐鏡品質檢查、人工核准、退回與限次重新生成。
- 重製模型、設定、製作與響應式繁體中文介面。
- 此版本只發布為 Prerelease；RTX 3050 Laptop 4 GB 維持實驗性相容標示。

## 已完成的本機驗證

- 發行來源／版本一致性驗證
- Python Engine 82 項測試及 12 項子測試
- Python 語法編譯
- TypeScript 嚴格型別檢查
- 41 項 TypeScript 結構測試
- Git 空白與衝突檢查

GitHub Windows runner 仍須完成 npm、正式 Vitest、Vite、Rust/Tauri、Engine 打包及 NSIS 簽章。
"@ | Set-Content -Path $BodyPath -Encoding UTF8
            $PrUrl = (& $Gh pr create --repo $Repository --base main --head $Branch --title $Title --body-file $BodyPath).Trim()
            if ($LASTEXITCODE -ne 0 -or -not $PrUrl) { throw "無法建立 Pull Request。" }
            $PrNumber = (& $Gh pr view $PrUrl --repo $Repository --json number --jq .number).Trim()
        }
        Write-Host "Pull Request：$PrUrl" -ForegroundColor Green

        Write-Host "正在等待乾淨 Windows runner 完成完整品質檢查……" -ForegroundColor Cyan
        $QualityRun = Wait-ForWorkflowRun -Gh $Gh -Repository $Repository -Workflow "quality.yml" -BranchName $Branch -HeadSha $HeadSha -Minutes 7
        Invoke-Checked $Gh @("run", "watch", $QualityRun, "--repo", $Repository, "--exit-status") "Windows 品質檢查失敗；已停止發布。"
        Invoke-Checked $Gh @("pr", "checks", $PrNumber, "--repo", $Repository, "--watch", "--fail-fast") "Pull Request 檢查尚未全部通過。"

        Write-Host "品質檢查通過，正在合併至 main……" -ForegroundColor Cyan
        & $Gh pr merge $PrNumber --repo $Repository --squash --delete-branch
        if ($LASTEXITCODE -ne 0) {
            Write-Host "一般合併受到分支規則阻擋，正在以管理員權限重試……" -ForegroundColor Yellow
            Invoke-Checked $Gh @("pr", "merge", $PrNumber, "--repo", $Repository, "--squash", "--delete-branch", "--admin") "Pull Request 合併失敗。"
        }
        Invoke-Checked $Git @("fetch", "origin", "main", "--prune") "無法取得合併後的 main。"
        $MainSha = (& $Git rev-parse origin/main).Trim()
    }
    else {
        $MainSha = (& $Git rev-parse origin/main).Trim()
        Write-Host "GitHub main 已包含完全相同的 $Version 來源；改為重新驗證後繼續發布。" -ForegroundColor Yellow
        Invoke-Checked $Gh @("workflow", "run", "quality.yml", "--repo", $Repository, "--ref", "main") "無法啟動 main 品質檢查。"
        $QualityRun = Wait-ForWorkflowRun -Gh $Gh -Repository $Repository -Workflow "quality.yml" -BranchName "main" -HeadSha $MainSha -Minutes 7
        Invoke-Checked $Gh @("run", "watch", $QualityRun, "--repo", $Repository, "--exit-status") "Windows 品質檢查失敗；已停止發布。"
    }

    $Release = $null
    $ReleaseJson = & $Gh release view $Tag --repo $Repository --json url,isPrerelease,isDraft,assets 2>$null
    if ($LASTEXITCODE -eq 0 -and $ReleaseJson) {
        $Release = $ReleaseJson | ConvertFrom-Json
        Write-Host "Release $Tag 已存在；正在驗證既有發行資產。" -ForegroundColor Yellow
    }
    $global:LASTEXITCODE = 0

    if (-not $Release) {
        Write-Host "正在啟動簽章 Windows Beta 發布……" -ForegroundColor Cyan
        $publishLine = & $Git ls-remote origin refs/heads/publish 2>$null | Select-Object -First 1
        $publishSha = if ($publishLine) { ($publishLine -split '\s+')[0] } else { "" }
        $global:LASTEXITCODE = 0
        if ($publishSha -eq $MainSha) {
            Write-Host "publish 已指向目前 main；改用手動工作流重新啟動簽章發布。" -ForegroundColor Yellow
            Invoke-Checked $Gh @("workflow", "run", "windows-installer.yml", "--repo", $Repository, "--ref", "publish") "無法重新啟動 Windows 發布工作流。"
        }
        else {
            Invoke-Checked $Git @("push", "origin", "origin/main:refs/heads/publish", "--force-with-lease") "無法更新 publish 分支。"
        }
        $ReleaseRun = Wait-ForWorkflowRun -Gh $Gh -Repository $Repository -Workflow "windows-installer.yml" -BranchName "publish" -HeadSha $MainSha -Minutes 7
        Invoke-Checked $Gh @("run", "watch", $ReleaseRun, "--repo", $Repository, "--exit-status") "簽章 Windows 發布失敗。"

        $ReleaseJson = & $Gh release view $Tag --repo $Repository --json url,isPrerelease,isDraft,assets
        if ($LASTEXITCODE -ne 0 -or -not $ReleaseJson) { throw "工作流完成，但找不到 $Tag Release。" }
        $Release = $ReleaseJson | ConvertFrom-Json
    }

    if ($Release.isDraft -or -not $Release.isPrerelease) { throw "$Tag 未正確標示為 Prerelease。" }
    $required = @("latest.json", ".sig", ".exe")
    foreach ($needle in $required) {
        if (-not ($Release.assets.name | Where-Object { $_ -like "*$needle*" })) {
            throw "$Tag Release 缺少 $needle 發行資產。"
        }
    }

    $DownloadRoot = Join-Path $ProjectRoot "release-downloads\$Tag"
    New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null
    Invoke-Checked $Gh @("release", "download", $Tag, "--repo", $Repository, "--dir", $DownloadRoot, "--clobber") "無法下載發行資產。"
    $Installer = Get-ChildItem $DownloadRoot -Filter "*.exe" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

    Write-Host ""
    Write-Host "Evolabs $Tag 已完成 Windows CI、簽章並發布為 Prerelease。" -ForegroundColor Green
    Write-Host "Release：$($Release.url)"
    Write-Host "發行檔案：$DownloadRoot"
    if ($Installer -and -not $NoInstall) {
        $answer = Read-Host "立即啟動 Beta 安裝程式？[Y/n]"
        if (-not $answer -or $answer.Trim().ToLowerInvariant() -in @("y", "yes")) {
            Start-Process -FilePath $Installer.FullName
        }
    }
}
finally {
    Set-Location $ProjectRoot
    Remove-Item $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
}
