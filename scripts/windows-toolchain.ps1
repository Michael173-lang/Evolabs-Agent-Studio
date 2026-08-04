$ErrorActionPreference = "Stop"
$script:EvolabsProjectRoot = Split-Path -Parent $PSScriptRoot

function Refresh-EvolabsProcessPath {
    $segments = New-Object System.Collections.Generic.List[string]
    foreach ($scope in @("Machine", "User")) {
        $value = [Environment]::GetEnvironmentVariable("Path", $scope)
        if ($value) {
            foreach ($segment in ($value -split ';')) {
                if ($segment -and -not $segments.Contains($segment)) {
                    $segments.Add($segment)
                }
            }
        }
    }
    foreach ($segment in ($env:Path -split ';')) {
        if ($segment -and -not $segments.Contains($segment)) {
            $segments.Add($segment)
        }
    }
    $env:Path = $segments -join ';'
}

function Get-EvolabsCommandCandidates {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$AdditionalPaths = @()
    )

    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($command in @(Get-Command $Name -All -ErrorAction SilentlyContinue)) {
        $path = if ($command.Path) { $command.Path } else { $command.Source }
        if ($path -and (Test-Path $path -PathType Leaf) -and -not $candidates.Contains($path)) {
            $candidates.Add($path)
        }
    }
    foreach ($path in $AdditionalPaths) {
        if ($path -and (Test-Path $path -PathType Leaf) -and -not $candidates.Contains($path)) {
            $candidates.Add($path)
        }
    }
    return @($candidates)
}

function Get-EvolabsNodeTool {
    $extra = @()
    if ($env:ProgramFiles) { $extra += (Join-Path $env:ProgramFiles "nodejs\node.exe") }
    if (${env:ProgramFiles(x86)}) { $extra += (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe") }
    if ($env:LOCALAPPDATA) { $extra += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe") }
    $portableRoot = Join-Path $script:EvolabsProjectRoot ".build\toolchain"
    if (Test-Path $portableRoot -PathType Container) {
        $extra += @(
            Get-ChildItem -Path (Join-Path $portableRoot "node-v24*-win-x64\node.exe") -File -ErrorAction SilentlyContinue |
                Sort-Object FullName -Descending |
                ForEach-Object { $_.FullName }
        )
    }

    $seen = @()
    foreach ($candidate in @(Get-EvolabsCommandCandidates -Name "node.exe" -AdditionalPaths $extra)) {
        try {
            $version = [string](@(& $candidate "--version" 2>$null) | Select-Object -Last 1)
            $exitCode = $LASTEXITCODE
        }
        catch { continue }
        if ($exitCode -ne 0 -or $version -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)') {
            continue
        }
        $seen += $version
        if ([int]$Matches.major -eq 24) {
            $npm = Join-Path (Split-Path -Parent $candidate) "npm.cmd"
            if (-not (Test-Path $npm -PathType Leaf)) {
                continue
            }
            return [pscustomobject]@{
                Ready = $true
                Node = $candidate
                Npm = $npm
                Version = $version.TrimStart('v')
            }
        }
    }
    return [pscustomobject]@{
        Ready = $false
        Node = $null
        Npm = $null
        Version = ($seen -join ", ")
    }
}

function Get-EvolabsPython311Tool {
    $probeCode = "import platform,struct; print(platform.python_version() + '|' + platform.machine() + '|' + str(struct.calcsize('P') * 8))"
    $launcherExtra = @()
    if ($env:SystemRoot) { $launcherExtra += (Join-Path $env:SystemRoot "py.exe") }
    if ($env:LOCALAPPDATA) { $launcherExtra += (Join-Path $env:LOCALAPPDATA "Programs\Python\Launcher\py.exe") }
    foreach ($launcher in @(Get-EvolabsCommandCandidates -Name "py.exe" -AdditionalPaths $launcherExtra)) {
        try {
            $probe = [string](@(& $launcher "-3.11" "-c" $probeCode 2>$null) | Select-Object -Last 1)
            $probeExitCode = $LASTEXITCODE
        }
        catch { continue }
        $parts = $probe -split '\|'
        $version = if ($parts.Count -ge 1) { $parts[0] } else { "" }
        $architecture = if ($parts.Count -ge 2) { $parts[1] } else { "" }
        $pointerBits = if ($parts.Count -ge 3) { $parts[2] } else { "" }
        if ($probeExitCode -eq 0 -and $version -match '^3\.11\.\d+$' -and $architecture -match '^(AMD64|x86_64)$' -and $pointerBits -eq '64') {
            try {
                $executable = [string](@(& $launcher "-3.11" "-c" "import sys; print(sys.executable)" 2>$null) | Select-Object -Last 1)
                $executableExitCode = $LASTEXITCODE
            }
            catch { continue }
            if ($executableExitCode -eq 0 -and (Test-Path $executable -PathType Leaf)) {
                return [pscustomobject]@{
                    Ready = $true
                    Executable = $executable
                    Launcher = $launcher
                    Version = $version
                    Architecture = $architecture
                }
            }
        }
    }

    $pythonExtra = @()
    if ($env:LOCALAPPDATA) { $pythonExtra += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe") }
    if ($env:ProgramFiles) { $pythonExtra += (Join-Path $env:ProgramFiles "Python311\python.exe") }
    foreach ($candidate in @(Get-EvolabsCommandCandidates -Name "python.exe" -AdditionalPaths $pythonExtra)) {
        try {
            $probe = [string](@(& $candidate "-c" $probeCode 2>$null) | Select-Object -Last 1)
            $probeExitCode = $LASTEXITCODE
        }
        catch { continue }
        $parts = $probe -split '\|'
        $version = if ($parts.Count -ge 1) { $parts[0] } else { "" }
        $architecture = if ($parts.Count -ge 2) { $parts[1] } else { "" }
        $pointerBits = if ($parts.Count -ge 3) { $parts[2] } else { "" }
        if ($probeExitCode -eq 0 -and $version -match '^3\.11\.\d+$' -and $architecture -match '^(AMD64|x86_64)$' -and $pointerBits -eq '64') {
            return [pscustomobject]@{
                Ready = $true
                Executable = $candidate
                Launcher = $null
                Version = $version
                Architecture = $architecture
            }
        }
    }
    return [pscustomobject]@{ Ready = $false; Executable = $null; Launcher = $null; Version = ""; Architecture = "" }
}

function Get-EvolabsRustTool {
    $toolchain = "stable-x86_64-pc-windows-msvc"
    $rustupExtra = @()
    if ($env:USERPROFILE) {
        $rustupExtra += (Join-Path $env:USERPROFILE ".cargo\bin\rustup.exe")
    }
    # WinGet/rustup-init installs its proxies here. Prefer that matching rustup
    # over unrelated Chocolatey/MSYS copies that may appear earlier on PATH.
    $rustupCandidates = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in $rustupExtra) {
        if ($candidate -and (Test-Path $candidate -PathType Leaf) -and -not $rustupCandidates.Contains($candidate)) {
            $rustupCandidates.Add($candidate)
        }
    }
    foreach ($candidate in @(Get-EvolabsCommandCandidates -Name "rustup.exe")) {
        if ($candidate -and -not $rustupCandidates.Contains($candidate)) {
            $rustupCandidates.Add($candidate)
        }
    }
    $rustup = @($rustupCandidates) | Select-Object -First 1
    if (-not $rustup) {
        return [pscustomobject]@{
            Ready = $false
            Cargo = $null
            Rustup = $null
            RustupReady = $false
            Version = ""
            Toolchain = $toolchain
            Host = ""
            HostReady = $false
            TargetReady = $false
        }
    }

    $rustupReady = $false
    try {
        $rustupVersion = [string](@(& $rustup "--version" 2>$null) | Select-Object -First 1)
        $rustupReady = $LASTEXITCODE -eq 0 -and $rustupVersion -match '^rustup '
    }
    catch { }
    if (-not $rustupReady) {
        return [pscustomobject]@{
            Ready = $false
            Cargo = $null
            Rustup = $rustup
            RustupReady = $false
            Version = ""
            Toolchain = $toolchain
            Host = ""
            HostReady = $false
            TargetReady = $false
        }
    }

    try {
        $version = [string](@(& $rustup "run" $toolchain "cargo" "--version" 2>$null) | Select-Object -Last 1)
        $cargoReady = $LASTEXITCODE -eq 0 -and $version -match '^cargo '
    }
    catch {
        $version = ""
        $cargoReady = $false
    }
    $rustHost = ""
    if ($cargoReady) {
        $rustcDetails = @(& $rustup "run" $toolchain "rustc" "-vV" 2>$null)
        if ($LASTEXITCODE -eq 0) {
            $hostLine = [string]($rustcDetails | Where-Object { $_ -match '^host:\s*' } | Select-Object -First 1)
            if ($hostLine -match '^host:\s*(?<host>\S+)\s*$') {
                $rustHost = [string]$Matches.host
            }
        }
    }
    $hostReady = $rustHost -eq "x86_64-pc-windows-msvc"

    $cargo = $null
    if ($cargoReady -and $hostReady) {
        $cargoCandidate = [string](@(& $rustup "which" "cargo" "--toolchain" $toolchain 2>$null) | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $cargoCandidate -and (Test-Path $cargoCandidate -PathType Leaf)) {
            $cargo = $cargoCandidate
        }
    }

    $targets = @(& $rustup "target" "list" "--installed" "--toolchain" $toolchain 2>$null)
    $targetReady = $cargoReady -and $hostReady -and $LASTEXITCODE -eq 0 -and $targets -contains "x86_64-pc-windows-msvc"
    return [pscustomobject]@{
        Ready = $cargoReady -and $hostReady -and [bool]$cargo
        Cargo = $cargo
        Rustup = $rustup
        RustupReady = $rustupReady
        Version = $version
        Toolchain = $toolchain
        Host = $rustHost
        HostReady = $hostReady
        TargetReady = $targetReady
    }
}

function Get-EvolabsMsvcTool {
    $vswhereCandidates = @()
    if (${env:ProgramFiles(x86)}) {
        $vswhereCandidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe")
    }
    if ($env:ProgramFiles) {
        $vswhereCandidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
    }
    $vswhere = $vswhereCandidates | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
    $installationPath = $null
    $compiler = $null
    if ($vswhere) {
        $installationPath = [string](@(& $vswhere "-latest" "-products" "*" "-requires" "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" "-property" "installationPath" 2>$null) | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $installationPath -and (Test-Path $installationPath -PathType Container)) {
            $compiler = Get-ChildItem -Path (Join-Path $installationPath "VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe") -File -ErrorAction SilentlyContinue |
                Sort-Object FullName -Descending |
                Select-Object -First 1
        }
    }

    $kitsRoot = $null
    foreach ($registryPath in @(
        "HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots"
    )) {
        try {
            $candidate = (Get-ItemProperty -Path $registryPath -Name KitsRoot10 -ErrorAction Stop).KitsRoot10
            if ($candidate -and (Test-Path $candidate -PathType Container)) {
                $kitsRoot = $candidate
                break
            }
        }
        catch { }
    }
    $kernelLibrary = $null
    $resourceCompiler = $null
    if ($kitsRoot) {
        $kernelLibrary = Get-ChildItem -Path (Join-Path $kitsRoot "Lib\*\um\x64\kernel32.lib") -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        $resourceCompiler = Get-ChildItem -Path (Join-Path $kitsRoot "bin\*\x64\rc.exe") -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
    }
    $linkerPath = if ($compiler) { Join-Path $compiler.DirectoryName "link.exe" } else { $null }
    $linker = if ($linkerPath -and (Test-Path $linkerPath -PathType Leaf)) { $linkerPath } else { $null }

    return [pscustomobject]@{
        Ready = [bool]$compiler -and [bool]$linker -and [bool]$kernelLibrary -and [bool]$resourceCompiler
        VsWhere = $vswhere
        InstallationPath = $installationPath
        Compiler = if ($compiler) { $compiler.FullName } else { $null }
        Linker = $linker
        WindowsSdk = if ($kernelLibrary) { $kernelLibrary.FullName } else { $null }
        ResourceCompiler = if ($resourceCompiler) { $resourceCompiler.FullName } else { $null }
    }
}

function Get-EvolabsDriveFreeBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    if (-not $root -or $root -notmatch '^(?<drive>[A-Za-z]):\\$') {
        throw "$Label 必須位於 Windows 本機磁碟，才能確認可用空間：$Path"
    }
    $drive = Get-PSDrive -PSProvider FileSystem -Name $Matches.drive -ErrorAction SilentlyContinue
    if (-not $drive -or $null -eq $drive.Free) {
        throw "無法確認 $Label（$root）的可用空間。"
    }
    return [int64]$drive.Free
}

function Assert-EvolabsBuildDiskSpace {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [int64]$MinimumBuildBytes = 10GB,
        [int64]$MinimumSystemBytes = 10GB
    )

    $buildFree = Get-EvolabsDriveFreeBytes -Path $ProjectRoot -Label "Evolabs 建置目錄"
    $systemRoot = [Environment]::SystemDirectory
    $systemFree = Get-EvolabsDriveFreeBytes -Path $systemRoot -Label "Windows 系統目錄"
    if ($buildFree -lt $MinimumBuildBytes) {
        throw "建置磁碟至少需要 $([math]::Ceiling($MinimumBuildBytes / 1GB)) GB 可用空間；目前只有 $([math]::Round($buildFree / 1GB, 1)) GB。"
    }
    if ($systemFree -lt $MinimumSystemBytes) {
        throw "Windows 系統磁碟至少需要 $([math]::Ceiling($MinimumSystemBytes / 1GB)) GB，供套件與編譯器快取使用；目前只有 $([math]::Round($systemFree / 1GB, 1)) GB。"
    }
    return [pscustomobject]@{
        BuildFree = $buildFree
        SystemFree = $systemFree
    }
}

function Test-EvolabsWebView2Runtime {
    $roots = @()
    if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application") }
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles "Microsoft\EdgeWebView\Application") }
    if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA "Microsoft\EdgeWebView\Application") }
    foreach ($root in $roots) {
        if (Test-Path $root -PathType Container) {
            $runtime = Get-ChildItem -Path (Join-Path $root "*\msedgewebview2.exe") -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($runtime) { return $true }
        }
    }
    return $false
}

function Test-EvolabsPendingRestart {
    # Do not block the build because of global Windows reboot markers.
    # PendingFileRenameOperations and the Windows Update/CBS keys are often
    # left behind by unrelated drivers or installers even after multiple
    # successful restarts. Evolabs validates every required executable and
    # toolchain component directly, so stale system-wide markers are not a
    # reliable prerequisite signal.
    #
    # Installers launched during the current run are still handled separately
    # through their explicit 1641/3010 exit codes in bootstrap-windows.ps1.
    return $false
}

function Get-EvolabsHardwareProfile {
    $gpuName = "未偵測到 NVIDIA 顯示卡"
    $vramMb = 0
    $driverVersion = $null
    $gpuSource = "none"
    $vramReliable = $false

    $smiExtra = @()
    if ($env:SystemRoot) { $smiExtra += (Join-Path $env:SystemRoot "System32\nvidia-smi.exe") }
    $smi = @(Get-EvolabsCommandCandidates -Name "nvidia-smi.exe" -AdditionalPaths $smiExtra) | Select-Object -First 1
    if ($smi) {
        $rows = @(& $smi "--query-gpu=index,name,memory.total,driver_version" "--format=csv,noheader,nounits" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $rows.Count -gt 0) {
            $parsed = @($rows | ConvertFrom-Csv -Header "Index", "Name", "VramMB", "DriverVersion") |
                ForEach-Object {
                    [pscustomobject]@{
                        Name = ([string]$_.Name).Trim()
                        VramMB = [int](([string]$_.VramMB).Trim())
                        DriverVersion = ([string]$_.DriverVersion).Trim()
                    }
                } |
                Sort-Object VramMB -Descending
            $preferred = $parsed | Where-Object { $_.Name -match 'RTX 3050' } | Select-Object -First 1
            if (-not $preferred) { $preferred = $parsed | Select-Object -First 1 }
            if ($preferred) {
                $gpuName = $preferred.Name
                $vramMb = $preferred.VramMB
                $driverVersion = $preferred.DriverVersion
                $gpuSource = "nvidia-smi"
                $vramReliable = $true
            }
        }
    }

    if ($gpuSource -eq "none") {
        try {
            $video = Get-CimInstance Win32_VideoController -ErrorAction Stop |
                Where-Object { $_.Name -match 'NVIDIA|RTX|GeForce' } |
                Sort-Object AdapterRAM -Descending |
                Select-Object -First 1
            if ($video) {
                $gpuName = [string]$video.Name
                if ($video.AdapterRAM) { $vramMb = [int]([math]::Round([double]$video.AdapterRAM / 1MB)) }
                $driverVersion = [string]$video.DriverVersion
                $gpuSource = "cim"
            }
        }
        catch { }
    }

    $ramGb = 0
    try {
        $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        $ramGb = [int]([math]::Round([double]$computer.TotalPhysicalMemory / 1GB))
    }
    catch { }

    $profile = "low-vram"
    if ($gpuName -match 'RTX 3050' -and $vramMb -ge 3500 -and $vramMb -le 4608) {
        $profile = "rtx3050-4gb"
    }
    elseif ($vramMb -ge 12288) {
        $profile = "high-vram"
    }
    elseif ($vramMb -ge 6144) {
        $profile = "balanced"
    }

    return [pscustomobject]@{
        gpu = $gpuName
        vramMb = $vramMb
        vramReliable = $vramReliable
        gpuSource = $gpuSource
        driverVersion = $driverVersion
        ramGb = $ramGb
        profile = $profile
    }
}

function Get-EvolabsToolchainStatus {
    Refresh-EvolabsProcessPath
    $node = Get-EvolabsNodeTool
    $python = Get-EvolabsPython311Tool
    $rust = Get-EvolabsRustTool
    $msvc = Get-EvolabsMsvcTool
    return [pscustomobject]@{
        node = $node
        python = $python
        rust = $rust
        msvc = $msvc
        webView2Ready = Test-EvolabsWebView2Runtime
        pendingRestart = Test-EvolabsPendingRestart
        hardware = Get-EvolabsHardwareProfile
    }
}
