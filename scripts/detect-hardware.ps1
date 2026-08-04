[CmdletBinding()]
param(
    [switch]$RequireRtx3050Profile,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-toolchain.ps1")

if ($env:OS -ne "Windows_NT") {
    throw "Hardware detection is supported by this script only on Windows."
}
$hardware = Get-EvolabsHardwareProfile
if ($AsJson) {
    $hardware | ConvertTo-Json -Depth 5
}
else {
    Write-Host "GPU: $($hardware.gpu)"
    Write-Host "VRAM: $($hardware.vramMb) MB (source: $($hardware.gpuSource); reliable: $($hardware.vramReliable))"
    Write-Host "NVIDIA driver: $($hardware.driverVersion)"
    Write-Host "System RAM: $($hardware.ramGb) GB"
    Write-Host "Evolabs profile: $($hardware.profile)"
}
if ($RequireRtx3050Profile -and $hardware.profile -ne "rtx3050-4gb") {
    throw "Expected an RTX 3050 4 GB profile, but detected '$($hardware.profile)' ($($hardware.gpu), $($hardware.vramMb) MB)."
}
