<#
.SYNOPSIS
    Launch the full E2EE WebRTC stack (SFU + Key Distributor + two clients).

.DESCRIPTION
    Starts every component in its own window, each pointed at the shared
    config.json. Two clients (alice / bob) are started so you can place a call
    between them on a single machine. For the single-machine case, set
    media.video.synthetic = true in config.json (a real webcam can only be
    opened by one process).

.PARAMETER Config
    Path to the config file passed to every app. Default: .\config.json

.PARAMETER NoClients
    Start only the SFU and Key Distributor (no client windows).

.EXAMPLE
    .\run-all.ps1
    .\run-all.ps1 -Config .\config.json -NoClients
#>

[CmdletBinding()]
param(
    [string]$Config = (Join-Path $PSScriptRoot 'config.json'),
    [switch]$NoClients
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cfg = (Resolve-Path $Config).Path

function Start-Component {
    param([string]$Title, [string]$WorkDir, [string]$File, [string[]]$ArgList)
    Write-Host "Starting $Title ..." -ForegroundColor Cyan
    $quotedArgs = ($ArgList | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $inner = "Set-Location '$WorkDir'; & $File $quotedArgs"
    Start-Process -FilePath 'powershell' `
        -ArgumentList '-NoExit', '-Command', $inner `
        -WindowStyle Normal | Out-Null
}

# 1) SFU (str0m PERC example) -------------------------------------------------
$sfuExe = Join-Path $root 'str0m\target\debug\examples\e2ee_perc.exe'
if (-not (Test-Path $sfuExe)) {
    Write-Warning "SFU binary not found at $sfuExe."
    Write-Warning "Build it first:  cd str0m; cargo build --example e2ee_perc --no-default-features --features `"wincrypto,examples`""
} else {
    Start-Component -Title 'SFU (e2ee_perc)' -WorkDir (Join-Path $root 'str0m') `
        -File $sfuExe -ArgList @('--config', $cfg)
}

# 2) Key Distributor ----------------------------------------------------------
Start-Component -Title 'Key Distributor' -WorkDir (Join-Path $root 'key-distributor') `
    -File 'node' -ArgList @('server.js', '--config', $cfg)

if ($NoClients) {
    Write-Host 'SFU + Key Distributor started (no clients).' -ForegroundColor Green
    return
}

Start-Sleep -Seconds 1

# 3) Two clients (alice / bob) ------------------------------------------------
# Note: connect each manually inside the REPL, e.g.
#     connect-perc alice
#     connect-perc bob
# (defaults for sfuUrl / kdUrl / confId come from config.json), or set
# autoConnect/autoConnectName in config.json for hands-free start.
foreach ($name in @('alice', 'bob')) {
    Start-Component -Title "Client ($name)" -WorkDir (Join-Path $root 'client') `
        -File 'node' -ArgList @('client.js', '--config', $cfg)
}

Write-Host 'All components launched. Each runs in its own window.' -ForegroundColor Green
Write-Host 'In each client window: connect-perc <name>   (e.g. connect-perc alice)' -ForegroundColor Yellow
