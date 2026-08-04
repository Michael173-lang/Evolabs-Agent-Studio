[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Checks = 0

function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    return [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($Path), $utf8)
}

function Assert-EvolabsScriptCondition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw "Windows 建置腳本測試失敗：$Message"
    }
    $script:Checks += 1
}

$PowerShellFiles = @(Get-ChildItem -Path $PSScriptRoot -Filter "*.ps1" -File)
foreach ($File in $PowerShellFiles) {
    $Tokens = $null
    $ParseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $File.FullName,
        [ref]$Tokens,
        [ref]$ParseErrors
    ) | Out-Null
    Assert-EvolabsScriptCondition `
        -Condition (@($ParseErrors).Count -eq 0) `
        -Message "$($File.Name) 有 PowerShell 語法錯誤：$(@($ParseErrors).Message -join '；')"
}

$Bootstrap = Read-Utf8Text -Path (Join-Path $PSScriptRoot "bootstrap-windows.ps1")
$Toolchain = Read-Utf8Text -Path (Join-Path $PSScriptRoot "windows-toolchain.ps1")
$BuildBatch = Read-Utf8Text -Path (Join-Path $ProjectRoot "BUILD_WINDOWS.bat")
$Readme = Read-Utf8Text -Path (Join-Path $ProjectRoot "README.md")

Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('node-v24\.[0-9]+\.[0-9]+-win-x64\.zip') -and $Bootstrap.Contains('SHASUMS256.txt')) `
    -Message "Node.js 24 必須從官方 Windows x64 可攜 ZIP 取得並核對 SHA-256。"
Assert-EvolabsScriptCondition `
    -Condition (-not $Bootstrap.Contains('-Version "24.0.0"') -and -not $Bootstrap.Contains('OpenJS.NodeJS.24')) `
    -Message "不得綁死舊版 Node 24.0.0，也不得假設不存在或不穩定的 WinGet 固定主版本 ID。"
Assert-EvolabsScriptCondition `
    -Condition ($Toolchain.Contains('.build\toolchain') -and $Toolchain.Contains('node-v24*-win-x64\node.exe')) `
    -Message "工具鏈偵測必須能找到專案本機的 Node.js 24 可攜版。"
Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc') -and $Bootstrap.Contains('rustup-init.exe.sha256')) `
    -Message "Rustup 的 WinGet 備援必須使用 Rust 官方 MSVC 安裝器並核對 SHA-256。"
Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('if ($ReturnFailure)') -and $Bootstrap.Contains('return $false')) `
    -Message "WinGet 不可用時，具備官方備援的工具不得直接讓建置器閃退。"

Assert-EvolabsScriptCondition `
    -Condition ($Toolchain -match '\[int\]\$Matches\.major -eq 24') `
    -Message "Node 就緒檢查必須固定為 24.x。"
Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('stable-x86_64-pc-windows-msvc')) `
    -Message "Rust 建置工具鏈必須固定使用 stable MSVC x64。"
Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('pendingRestart') -and $Toolchain.Contains('function Test-EvolabsPendingRestart')) `
    -Message "前置工具失敗後必須辨識 Windows 待重新啟動狀態。"
Assert-EvolabsScriptCondition `
    -Condition ($BuildBatch.Contains('來源碼建置器') -and $BuildBatch.Contains('不是一般使用者安裝程式')) `
    -Message "BUILD_WINDOWS.bat 必須明確說明這是來源碼建置，不是一般安裝。"
Assert-EvolabsScriptCondition `
    -Condition ($Readme.Contains('從來源碼建立 Windows 安裝器') -and $Readme.Contains('開發者')) `
    -Message "README 必須把 Windows 流程標示為開發者來源碼建置。"
Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('https://nodejs.org/dist/latest-v24.x/') -and $Bootstrap.Contains('https://rustup.rs/')) `
    -Message "自動安裝失敗時必須提供 Node.js 與 Rust 官方入口。"
Assert-EvolabsScriptCondition `
    -Condition (-not $Bootstrap.Contains('& $winget.Source "source" "update"')) `
    -Message "不得在每個套件前強制刷新 WinGet source，以免安裝流程反覆卡住。"
Assert-EvolabsScriptCondition `
    -Condition ($Bootstrap.Contains('1641, 3010')) `
    -Message "必須把 Windows 安裝器的重新啟動錯誤碼轉成可重跑提示。"

$BuildScript = Read-Utf8Text -Path (Join-Path $PSScriptRoot "build-windows.ps1")
Assert-EvolabsScriptCondition `
    -Condition ($BuildScript.Contains('Installer.FullName') -and $BuildScript.Contains('SHA-256')) `
    -Message "完成建置時必須顯示安裝器完整路徑與 SHA-256。"

Write-Host "$Checks 項 Windows 建置腳本檢查全部通過。" -ForegroundColor Green
