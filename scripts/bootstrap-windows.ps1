[CmdletBinding()]
param(
    [switch]$InstallMissing,
    [string]$ReportPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "windows-toolchain.ps1")
$script:RestartRequested = $false

function Invoke-WinGetInstall {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$HelpUrl,
        [string]$Override,
        [string]$Version,
        [switch]$Force,
        [switch]$ReturnFailure
    )
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        if ($ReturnFailure) {
            Write-Warning "找不到 WinGet；$DisplayName 將改走可用的官方備援流程。"
            return $false
        }
        throw "找不到 WinGet。請先從 Microsoft Store 安裝或修復『應用程式安裝程式』，關閉目前視窗後再執行 BUILD_WINDOWS.bat：https://apps.microsoft.com/detail/9NBLGGH4NNS1"
    }
    Write-Host "正在嘗試透過 WinGet 安裝：$DisplayName（套件 $Id）" -ForegroundColor Cyan
    $arguments = @(
        "install", "--id", $Id, "--exact", "--source", "winget",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
    )
    if ($Version) { $arguments += @("--version", $Version) }
    if ($Override) {
        $arguments += @("--override", $Override)
    }
    else {
        $arguments += "--silent"
    }
    if ($Force) { $arguments += "--force" }
    & $winget.Source @arguments
    $installExitCode = $LASTEXITCODE
    if ($installExitCode -in @(1641, 3010)) {
        $script:RestartRequested = $true
        Write-Warning "$DisplayName 安裝程式要求重新開機（錯誤碼 $installExitCode）。目前流程會在重新檢查後停止。"
    }
    elseif ($installExitCode -ne 0) {
        if ($ReturnFailure) { return $false }
        throw "WinGet 未能完成 $DisplayName（錯誤碼 $installExitCode）。這不代表已安裝成功；請查看上方安裝訊息，或從官方頁面手動安裝：$HelpUrl。完成後重新執行 BUILD_WINDOWS.bat。"
    }
    Refresh-EvolabsProcessPath
    return $true
}

function Install-Node24PortableFromOfficialArchive {
    $baseUrl = "https://nodejs.org/dist/latest-v24.x"
    $checksumUrl = "$baseUrl/SHASUMS256.txt"
    $toolchainRoot = Join-Path $ProjectRoot ".build\toolchain"
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("evolabs-node24-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $toolchainRoot, $tempRoot | Out-Null
    Write-Host "正在下載 Node.js 24 官方可攜版並驗證 SHA-256；不需要安裝或管理員權限……" -ForegroundColor Cyan
    try {
        $checksumText = (Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl -TimeoutSec 60).Content
        $match = [regex]::Match($checksumText, '(?m)^(?<hash>[a-fA-F0-9]{64})\s+(?<file>node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)$')
        if (-not $match.Success) { throw "Node.js 官方校驗清單中找不到 24.x Windows x64 ZIP。" }
        $fileName = $match.Groups['file'].Value
        $expectedHash = $match.Groups['hash'].Value.ToLowerInvariant()
        $archivePath = Join-Path $tempRoot $fileName
        $folderName = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
        $destination = Join-Path $toolchainRoot $folderName
        if ((Test-Path (Join-Path $destination "node.exe") -PathType Leaf) -and (Test-Path (Join-Path $destination "npm.cmd") -PathType Leaf)) {
            Write-Host "已找到可重用的專案本機 Node.js：$destination" -ForegroundColor Green
            Refresh-EvolabsProcessPath
            return
        }
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$fileName" -OutFile $archivePath -TimeoutSec 600
        $actualHash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw "Node.js 官方 ZIP SHA-256 驗證失敗。" }
        $extractRoot = Join-Path $tempRoot "extract"
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
        $extracted = Join-Path $extractRoot $folderName
        if (-not (Test-Path (Join-Path $extracted "node.exe") -PathType Leaf) -or -not (Test-Path (Join-Path $extracted "npm.cmd") -PathType Leaf)) {
            throw "Node.js 官方 ZIP 解壓後缺少 node.exe 或 npm.cmd。"
        }
        if (Test-Path $destination) { Remove-Item -Recurse -Force $destination }
        Move-Item -LiteralPath $extracted -Destination $destination
        Get-ChildItem -Path $toolchainRoot -Directory -Filter "node-v24*-win-x64" -ErrorAction SilentlyContinue |
            Where-Object FullName -ne $destination |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Refresh-EvolabsProcessPath
        Write-Host "Node.js 24 可攜版已就緒：$destination" -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    }
}

function Install-RustupFromOfficialBootstrapper {
    $baseUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc"
    $installerUrl = "$baseUrl/rustup-init.exe"
    $checksumUrl = "$baseUrl/rustup-init.exe.sha256"
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("evolabs-rustup-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $installerPath = Join-Path $tempRoot "rustup-init.exe"
    Write-Host "WinGet 無法安裝 Rustup，改用 Rust 官方 rustup-init 並驗證 SHA-256……" -ForegroundColor Cyan
    try {
        $checksumResponse = Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl -TimeoutSec 60
        $checksumContent = $checksumResponse.Content
        if ($checksumContent -is [byte[]]) {
            $checksumText = [System.Text.Encoding]::UTF8.GetString($checksumContent)
        }
        else {
            $checksumText = [string]$checksumContent
        }
        $checksumText = $checksumText.Trim()
        $match = [regex]::Match($checksumText, '(?im)^\s*(?<hash>[a-f0-9]{64})(?:\s+[* ]?\S+)?\s*$')
        if (-not $match.Success) {
            $match = [regex]::Match($checksumText, '(?i)(?<hash>[a-f0-9]{64})')
        }
        if (-not $match.Success) { throw "Rust 官方校驗檔格式無效：$checksumText" }
        Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installerPath -TimeoutSec 600
        $actualHash = (Get-FileHash -Algorithm SHA256 -Path $installerPath).Hash.ToLowerInvariant()
        if ($actualHash -ne $match.Groups['hash'].Value.ToLowerInvariant()) { throw "rustup-init.exe SHA-256 驗證失敗。" }
        $process = Start-Process -FilePath $installerPath -ArgumentList @(
            '-y', '--profile', 'minimal',
            '--default-host', 'x86_64-pc-windows-msvc',
            '--default-toolchain', 'none'
        ) -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Rust 官方 rustup-init 安裝失敗，錯誤碼 $($process.ExitCode)。" }
        Refresh-EvolabsProcessPath
    }
    finally {
        Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    }
}

function Write-PrerequisiteHelp {
    Write-Host "可手動安裝的官方入口：" -ForegroundColor Yellow
    Write-Host "  Node.js 24（腳本會使用官方可攜 ZIP）：https://nodejs.org/dist/latest-v24.x/"
    Write-Host "  Python 3.11 x64：https://www.python.org/downloads/release/python-3119/"
    Write-Host "  Rustup：https://rustup.rs/"
    Write-Host "  Visual Studio Build Tools：https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Write-Host "  WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/"
}

if ($env:OS -ne "Windows_NT") {
    throw "這個來源碼建置器只能在 64 位元 Windows 上執行；目前平台是 '$([Environment]::OSVersion.Platform)'。"
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Evolabs 來源碼建置只支援 64 位元 Windows。"
}
if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "需要 Windows PowerShell 5.1 或更新版本。"
}

Write-Host "Evolabs Windows 來源碼建置：前置工具檢查" -ForegroundColor Cyan
Write-Host "這是給開發／自行編譯使用的流程，不是一般使用者安裝程式。"
if ($InstallMissing) {
    Write-Host "腳本會優先使用官方可攜工具與 WinGet 補齊缺少項目；UAC、安裝失敗或重新開機仍需由你完成。"
}

$status = Get-EvolabsToolchainStatus
$toolInstallNeeded = -not $status.node.Ready -or -not $status.python.Ready -or -not $status.rust.Ready -or -not $status.msvc.Ready -or -not $status.webView2Ready
$minimumFreeBytes = if ($InstallMissing -and $toolInstallNeeded) { 15GB } else { 10GB }
Assert-EvolabsBuildDiskSpace `
    -ProjectRoot $ProjectRoot `
    -MinimumBuildBytes $minimumFreeBytes `
    -MinimumSystemBytes $minimumFreeBytes | Out-Null
if (-not $status.node.Ready -and $InstallMissing) {
    Install-Node24PortableFromOfficialArchive
}
if (-not $status.python.Ready -and $InstallMissing) {
    Invoke-WinGetInstall `
        -Id "Python.Python.3.11" `
        -DisplayName "CPython 3.11 x64" `
        -HelpUrl "https://www.python.org/downloads/release/python-3119/" `
        -Force
}
if ((-not $status.rust.RustupReady) -and $InstallMissing) {
    $rustupInstalled = Invoke-WinGetInstall `
        -Id "Rustlang.Rustup" `
        -DisplayName "Rustup（Rust stable MSVC）" `
        -HelpUrl "https://rustup.rs/" `
        -ReturnFailure
    if ($rustupInstalled) {
        Refresh-EvolabsProcessPath
        $rustupInstalled = (Get-EvolabsRustTool).RustupReady
    }
    if (-not $rustupInstalled) {
        Install-RustupFromOfficialBootstrapper
    }
}
if ((-not $status.msvc.Ready) -and $InstallMissing) {
    Invoke-WinGetInstall `
        -Id "Microsoft.VisualStudio.2022.BuildTools" `
        -DisplayName "Visual Studio 2022 C++ Build Tools 與 Windows SDK" `
        -HelpUrl "https://visualstudio.microsoft.com/visual-cpp-build-tools/" `
        -Override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
        -Force
}
if ((-not $status.webView2Ready) -and $InstallMissing) {
    Invoke-WinGetInstall `
        -Id "Microsoft.EdgeWebView2Runtime" `
        -DisplayName "Microsoft Edge WebView2 Runtime" `
        -HelpUrl "https://developer.microsoft.com/microsoft-edge/webview2/"
}

$status = Get-EvolabsToolchainStatus
if ($status.rust.Rustup -and $InstallMissing -and (-not $status.rust.Ready -or -not $status.rust.TargetReady)) {
    $rustToolchain = if ($status.rust.Toolchain) { [string]$status.rust.Toolchain } else { "stable-x86_64-pc-windows-msvc" }
    Write-Host "正在設定 Rust stable MSVC 工具鏈與 x64 Windows target……" -ForegroundColor Cyan
    & $status.rust.Rustup "toolchain" "install" $rustToolchain "--profile" "minimal"
    if ($LASTEXITCODE -ne 0) { throw "rustup 無法安裝 $rustToolchain。請依上方訊息修正，或到 https://rustup.rs/ 重新安裝後再執行 BUILD_WINDOWS.bat。" }
    & $status.rust.Rustup "target" "add" "x86_64-pc-windows-msvc" "--toolchain" $rustToolchain
    if ($LASTEXITCODE -ne 0) { throw "rustup 無法加入 x86_64-pc-windows-msvc target。請修正上方錯誤後再執行 BUILD_WINDOWS.bat。" }
    $env:RUSTUP_TOOLCHAIN = $rustToolchain
    $status = Get-EvolabsToolchainStatus
}
elseif ($status.rust.Ready -and -not $status.rust.TargetReady) {
    throw "Rust 已安裝，但缺少 x86_64-pc-windows-msvc target。請執行：rustup target add x86_64-pc-windows-msvc --toolchain stable-x86_64-pc-windows-msvc"
}

$missing = New-Object System.Collections.Generic.List[string]
if (-not $status.node.Ready) {
    $detail = if ($status.node.Version) { "（偵測到 $($status.node.Version)，但建置固定需要 24.x）" } else { "" }
    $missing.Add("Node.js 24 x64$detail")
}
if (-not $status.python.Ready) { $missing.Add("CPython 3.11 x64") }
if (-not $status.rust.Ready) { $missing.Add("Rust stable MSVC x64／Cargo") }
elseif (-not $status.rust.TargetReady) { $missing.Add("Rust target x86_64-pc-windows-msvc") }
if (-not $status.msvc.Ready) { $missing.Add("Visual Studio 2022 C++ Build Tools、link.exe、rc.exe 與 Windows SDK") }
if (-not $status.webView2Ready) { $missing.Add("Microsoft Edge WebView2 Runtime") }
if ($missing.Count -gt 0) {
    Write-PrerequisiteHelp
    $hint = if ($script:RestartRequested -or $status.pendingRestart) {
        "Windows 顯示有待完成的重新啟動。請先重新開機，登入後再次雙擊 BUILD_WINDOWS.bat；腳本會重新偵測並沿用已完成的安裝。"
    }
    elseif ($InstallMissing) {
        "自動安裝並未讓所有工具就緒。請完成尚未關閉的 UAC／安裝視窗，必要時重新開機，再執行 BUILD_WINDOWS.bat。腳本可安全重跑，但不保證 WinGet 能修復每一台電腦。"
    }
    else {
        "可雙擊 BUILD_WINDOWS.bat 嘗試以 WinGet 安裝，或依上方官方入口手動安裝。"
    }
    throw "Windows 建置前置工具尚未就緒：$($missing -join '；')。$hint"
}
if ($script:RestartRequested) {
    throw "前置工具安裝程式要求重新啟動 Windows。請重新開機，登入後再次執行 BUILD_WINDOWS.bat；腳本會重新偵測已完成的工具。"
}

# Tool installation can consume several gigabytes. Recheck both locations before
# allowing npm, pip, Cargo, NSIS, and WebView2 caches to start growing.
Assert-EvolabsBuildDiskSpace -ProjectRoot $ProjectRoot | Out-Null

$buildRoot = Join-Path $ProjectRoot ".build"
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
if (-not $ReportPath) { $ReportPath = Join-Path $buildRoot "windows-preflight.json" }
$report = [ordered]@{
    schemaVersion = 1
    checkedAtUtc = [DateTime]::UtcNow.ToString("o")
    operatingSystem = [Environment]::OSVersion.VersionString
    architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    tools = [ordered]@{
        node = [ordered]@{ version = $status.node.Version; executable = $status.node.Node; npm = $status.node.Npm }
        python = [ordered]@{ version = $status.python.Version; executable = $status.python.Executable }
        rust = [ordered]@{
            version = $status.rust.Version
            cargo = $status.rust.Cargo
            toolchain = $status.rust.Toolchain
            host = $status.rust.Host
            target = "x86_64-pc-windows-msvc"
        }
        msvc = [ordered]@{
            compiler = $status.msvc.Compiler
            linker = $status.msvc.Linker
            resourceCompiler = $status.msvc.ResourceCompiler
            windowsSdk = $status.msvc.WindowsSdk
        }
        webView2Ready = $status.webView2Ready
        pendingRestart = $status.pendingRestart
    }
    hardware = $status.hardware
}
[System.IO.File]::WriteAllText(
    $ReportPath,
    ($report | ConvertTo-Json -Depth 10),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Windows 來源碼建置工具已就緒。" -ForegroundColor Green
Write-Host "  Node $($status.node.Version)；Python $($status.python.Version)；$($status.rust.Version)／$($status.rust.Host)"
Write-Host "  GPU：$($status.hardware.gpu)／$($status.hardware.vramMb) MB VRAM／設定檔 $($status.hardware.profile)"
if (-not $status.hardware.vramReliable) {
    Write-Warning "無法用 nvidia-smi 確認 VRAM；AI 模型安裝會停止，不會假設顯示卡相容。"
}
Write-Host "  檢查報告：$ReportPath"
