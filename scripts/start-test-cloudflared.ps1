[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$TunnelName = "winmcp-test",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
if ($TunnelName -ne "winmcp-test") { throw "Test tunnel name must be winmcp-test" }
$fullConfig = [System.IO.Path]::GetFullPath($ConfigPath)
$productionConfig = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".cloudflared\config.yml"))
if ($fullConfig -eq $productionConfig -or -not (Test-Path -LiteralPath $fullConfig -PathType Leaf)) { throw "A separate test Cloudflare configuration is required" }
$text = Get-Content -LiteralPath $fullConfig -Raw -Encoding UTF8
if ($text -match 'mcp\.example\.com|127\.0\.0\.1:3000|win-mcp(?!-test)|credentials.*win-mcp') { throw "Test tunnel configuration contains a production identifier" }
if ($text -notmatch 'mcp-test\.example\.com' -or $text -notmatch '127\.0\.0\.1:3001') { throw "Test tunnel must target mcp-test.example.com and 127.0.0.1:3001" }
if ($CheckOnly) { [pscustomobject]@{ status = "test-tunnel-ready"; host = "mcp-test.example.com"; port = 3001 } | ConvertTo-Json -Compress; exit 0 }
$cloudflared = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { throw "cloudflared.exe was not found" }
Start-Process -FilePath $cloudflared -ArgumentList @("tunnel", "--config", $fullConfig, "run", $TunnelName) -WorkingDirectory (Split-Path -Parent $fullConfig)
Write-Host "Test Cloudflare tunnel started; production cloudflared service was not queried or changed."
