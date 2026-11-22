[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$supervisorScript = Join-Path $projectDir "scripts\prod-supervisor.mjs"
$productionTunnelUuid = $env:CLOUDFLARE_TUNNEL_UUID
if ([string]::IsNullOrWhiteSpace($productionTunnelUuid)) {
    throw "CLOUDFLARE_TUNNEL_UUID is not set. Export it before stopping the production tunnel."
}

$processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($supervisorScript) })
foreach ($process in $processes) {
    Write-Host "Stopping supervisor PID $($process.ProcessId)"
    & taskkill.exe /F /T /PID $process.ProcessId | Out-Null
}

$tunnels = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($productionTunnelUuid) })
foreach ($tunnel in $tunnels) {
    Write-Host "Stopping production tunnel PID $($tunnel.ProcessId)"
    & taskkill.exe /F /PID $tunnel.ProcessId | Out-Null
}
