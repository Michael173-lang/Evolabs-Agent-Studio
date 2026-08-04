[CmdletBinding()]
param(
    [switch]$InstallMissing,
    [switch]$SkipBootstrap,
    [switch]$RequireRtx3050Profile
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "windows-toolchain.ps1")

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "指令執行失敗（錯誤碼 $LASTEXITCODE）：$Executable $($Arguments -join ' ')"
    }
}

function Import-EvolabsMsvcEnvironment {
    param([Parameter(Mandatory = $true)][string]$InstallationPath)
    $VsDevCmd = Join-Path $InstallationPath "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path $VsDevCmd -PathType Leaf)) {
        throw "Visual Studio 開發環境檔案不存在：$VsDevCmd。請修復『使用 C++ 的桌面開發』工作負載。"
    }
    $command = "`"$VsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    $environmentLines = @(& $env:ComSpec "/d" "/s" "/c" $command)
    if ($LASTEXITCODE -ne 0) {
        throw "無法初始化 Visual Studio x64 開發環境。請修復 Visual Studio Build Tools 與 Windows SDK。"
    }
    foreach ($line in $environmentLines) {
        if ($line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
    foreach ($requiredCommand in @("cl.exe", "link.exe", "rc.exe")) {
        if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
            throw "初始化 Visual Studio x64 開發環境後仍找不到 $requiredCommand。請修復 C++ Build Tools 與 Windows SDK。"
        }
    }
}

Push-Location $ProjectRoot
try {
    if ($env:OS -ne "Windows_NT") { throw "這個來源碼建置器只能在 64 位元 Windows 上執行。" }
    Write-Host "Evolabs Windows 來源碼建置開始。這不是一般使用者安裝流程。" -ForegroundColor Cyan
    $BuildRoot = Join-Path $ProjectRoot ".build"
    $LogRoot = Join-Path $BuildRoot "logs"
    New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
    $LogPath = Join-Path $LogRoot ("windows-build-{0}.log" -f [DateTime]::Now.ToString("yyyyMMdd-HHmmss"))
    try { Start-Transcript -Path $LogPath -Force | Out-Null } catch { }

    if (-not $SkipBootstrap) {
        if ($InstallMissing) {
            & (Join-Path $PSScriptRoot "bootstrap-windows.ps1") -InstallMissing
        }
        else {
            & (Join-Path $PSScriptRoot "bootstrap-windows.ps1")
        }
    }
    Refresh-EvolabsProcessPath
    $Toolchain = Get-EvolabsToolchainStatus

    # Rustup's `which` parsing can report a false negative even when the
    # installed stable MSVC toolchain is fully usable. Verify the real tools
    # directly and repair only the Rust portion of the status object.
    $KnownCargoHome = Join-Path $env:USERPROFILE ".cargo"
    $KnownRustupHome = Join-Path $env:USERPROFILE ".rustup"
    $KnownCargo = Join-Path $KnownCargoHome "bin\cargo.exe"
    $KnownRustup = Join-Path $KnownCargoHome "bin\rustup.exe"
    $KnownRustc = Join-Path $KnownCargoHome "bin\rustc.exe"
    $KnownToolchain = "stable-x86_64-pc-windows-msvc"
    $KnownTarget = "x86_64-pc-windows-msvc"

    if ((-not $Toolchain.rust.Ready -or -not $Toolchain.rust.TargetReady) -and
        (Test-Path $KnownRustup -PathType Leaf) -and
        (Test-Path $KnownCargo -PathType Leaf) -and
        (Test-Path $KnownRustc -PathType Leaf)) {

        $OldCargoHome = $env:CARGO_HOME
        $OldRustupHome = $env:RUSTUP_HOME
        try {
            $env:CARGO_HOME = $KnownCargoHome
            $env:RUSTUP_HOME = $KnownRustupHome
            $env:Path = "$(Join-Path $KnownCargoHome 'bin');$env:Path"

            $CargoVersion = [string](@(& $KnownRustup "run" $KnownToolchain "cargo" "--version" 2>$null) | Select-Object -Last 1)
            $CargoOk = $LASTEXITCODE -eq 0 -and $CargoVersion -match '^cargo\s+'

            $RustcInfo = @(& $KnownRustup "run" $KnownToolchain "rustc" "-vV" 2>$null)
            $RustcOk = $LASTEXITCODE -eq 0 -and ($RustcInfo -match '^host:\s*x86_64-pc-windows-msvc\s*$')

            $InstalledTargets = @(& $KnownRustup "target" "list" "--installed" "--toolchain" $KnownToolchain 2>$null)
            $TargetOk = $LASTEXITCODE -eq 0 -and $InstalledTargets -contains $KnownTarget

            if ($CargoOk -and $RustcOk -and $TargetOk) {
                $Toolchain.rust.Ready = $true
                $Toolchain.rust.TargetReady = $true
                $Toolchain.rust.HostReady = $true
                $Toolchain.rust.Host = $KnownTarget
                $Toolchain.rust.Cargo = $KnownCargo
                $Toolchain.rust.Rustup = $KnownRustup
                $Toolchain.rust.Toolchain = $KnownToolchain
                $Toolchain.rust.Version = $CargoVersion
                Write-Host "已直接驗證既有 Rust stable MSVC／Cargo，可繼續建置。" -ForegroundColor Green
            }
        }
        finally {
            $env:CARGO_HOME = $OldCargoHome
            $env:RUSTUP_HOME = $OldRustupHome
        }
    }

    $MissingNow = @()
    if (-not $Toolchain.node.Ready) { $MissingNow += "Node.js 24 x64" }
    if (-not $Toolchain.python.Ready) { $MissingNow += "Python 3.11 x64" }
    if (-not $Toolchain.rust.Ready -or -not $Toolchain.rust.TargetReady) { $MissingNow += "Rust stable MSVC x64／Cargo" }
    if (-not $Toolchain.msvc.Ready) { $MissingNow += "Visual Studio C++ Build Tools／Windows SDK" }
    if (-not $Toolchain.webView2Ready) { $MissingNow += "WebView2 Runtime" }
    if ($MissingNow.Count -gt 0) {
        throw "仍缺少建置工具：$($MissingNow -join '；')。"
    }
    Assert-EvolabsBuildDiskSpace -ProjectRoot $ProjectRoot | Out-Null
    Import-EvolabsMsvcEnvironment -InstallationPath $Toolchain.msvc.InstallationPath
    if ($RequireRtx3050Profile -and $Toolchain.hardware.profile -ne "rtx3050-4gb") {
        throw "此建置指定 RTX 3050 4GB 設定檔，但實際偵測為 '$($Toolchain.hardware.profile)'（$($Toolchain.hardware.gpu)，$($Toolchain.hardware.vramMb) MB）。"
    }
    $env:EVOLABS_PYTHON311 = $Toolchain.python.Executable
    $RustTarget = "x86_64-pc-windows-msvc"
    $env:RUSTUP_TOOLCHAIN = $Toolchain.rust.Toolchain
    $cargoDirectory = Split-Path -Parent $Toolchain.rust.Cargo
    $nodeDirectory = Split-Path -Parent $Toolchain.node.Node
    $env:Path = "$nodeDirectory;$cargoDirectory;$env:Path"

    & (Join-Path $PSScriptRoot "test-windows-build-scripts.ps1")
    Invoke-Checked $Toolchain.python.Executable (Join-Path $PSScriptRoot "validate-source-release.py")
    & (Join-Path $PSScriptRoot "validate-distribution.ps1")

    $BundleRoots = @(
        (Join-Path $ProjectRoot "src-tauri\target\$RustTarget\release\bundle\nsis"),
        (Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis")
    )
    foreach ($BundleRoot in $BundleRoots) {
        if (Test-Path $BundleRoot) {
            Remove-Item -Recurse -Force $BundleRoot
        }
    }

    Invoke-Checked $Toolchain.node.Npm "ci"
    Invoke-Checked $Toolchain.node.Npm "run" "check"
    Invoke-Checked $Toolchain.node.Npm "test"
    Invoke-Checked "powershell.exe" "-NoProfile" "-ExecutionPolicy" "Bypass" "-File" (Join-Path $PSScriptRoot "build-engine.ps1")
    $CargoLock = Join-Path $ProjectRoot "src-tauri\Cargo.lock"
    if (-not (Test-Path $CargoLock -PathType Leaf)) {
        Write-Warning "找不到 src-tauri\Cargo.lock；本次建置會先產生。公開發行前應提交並固定這個 lockfile。"
        Push-Location (Join-Path $ProjectRoot "src-tauri")
        try {
            Invoke-Checked $Toolchain.rust.Cargo "generate-lockfile"
        }
        finally {
            Pop-Location
        }
    }
    Invoke-Checked "powershell.exe" "-NoProfile" "-ExecutionPolicy" "Bypass" "-File" (Join-Path $PSScriptRoot "preflight-release.ps1")
    $TauriCommand = Join-Path $ProjectRoot "node_modules\.bin\tauri.cmd"
    if (-not (Test-Path $TauriCommand -PathType Leaf)) {
        throw "npm ci 完成後仍找不到專案固定版本的 Tauri CLI。請查看上方 npm 錯誤與建置記錄。"
    }
    Invoke-Checked $TauriCommand "build" "--bundles" "nsis" "--target" $RustTarget "--ci" "--" "--locked"

    $Installers = @()
    foreach ($BundleRoot in $BundleRoots) {
        if (Test-Path $BundleRoot -PathType Container) {
            $Installers += @(Get-ChildItem -Path $BundleRoot -Filter "*.exe" -File)
        }
    }
    $Installer = $Installers | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $Installer) { throw "建置完成後找不到 NSIS 安裝器。請查看 Tauri 輸出與建置記錄。" }
    if ($Installer.Length -lt 1MB) { throw "NSIS 安裝器大小異常（$($Installer.Length) bytes），因此不交付。" }
    $InstallerHash = (Get-FileHash -Algorithm SHA256 -Path $Installer.FullName).Hash.ToLowerInvariant()
    $HashPath = "$($Installer.FullName).sha256"
    [System.IO.File]::WriteAllText(
        $HashPath,
        "$InstallerHash  $($Installer.Name)`r`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $Signature = Get-AuthenticodeSignature -FilePath $Installer.FullName
    if ($Signature.Status -ne "Valid") {
        Write-Warning "安裝器尚未通過 Authenticode 簽署（狀態：$($Signature.Status)）。公開散布前必須簽署 App、Engine 與安裝器。"
    }
    Write-Host "Windows NSIS 安裝器已建立：$($Installer.FullName)" -ForegroundColor Green
    Write-Host "SHA-256: $InstallerHash" -ForegroundColor Green
    Write-Host "SHA-256 檔案：$HashPath" -ForegroundColor Green
    Write-Host "建置記錄：$LogPath"
}
catch {
    Write-Host "Evolabs Windows 來源碼建置已停止：$($_.Exception.Message)" -ForegroundColor Red
    if ($LogPath) { Write-Host "建置記錄：$LogPath" -ForegroundColor Yellow }
    throw
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
    Pop-Location
}
