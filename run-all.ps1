<#
.SYNOPSIS
    Launch the full E2EE WebRTC stack (SFU + Key Distributor + N clients).

.DESCRIPTION
    Starts every component in its own window, each pointed at the shared
    config.json. By default three clients (alice / bob / carol) are started so
    you can hold a multi-party conference on a single machine. For the
    single-machine case each client is launched with the E2EE_SYNTHETIC_VIDEO
    env var (see -SyntheticVideo), so it renders an animated synthetic frame
    tagged with its own name instead of opening the webcam (a real webcam can
    only be opened by the first process). This makes the encrypted streams easy
    to tell apart across windows.

.PARAMETER Config
    Path to the config file passed to every app. Default: .\config.json

.PARAMETER Names
    Client names to start. Default: alice, bob, carol. They all share the
    confId from config.json, so they land in the same conference.

.PARAMETER NoClients
    Start only the SFU and Key Distributor (no client windows).

.PARAMETER SyntheticVideo
    Launch each client with E2EE_SYNTHETIC_VIDEO=1 and a per-client
    E2EE_VIDEO_LABEL (its name), forcing the tagged synthetic video source.
    Default: $true. Pass -SyntheticVideo:$false to use a real webcam / the
    media.video.synthetic setting from config.json instead.

.EXAMPLE
    .\run-all.ps1
    .\run-all.ps1 -Names alice,bob
    .\run-all.ps1 -SyntheticVideo:$false
    .\run-all.ps1 -Config .\config.json -NoClients
#>

[CmdletBinding()]
param(
    [string]$Config = (Join-Path $PSScriptRoot 'config.json'),
    [string[]]$Names = @('alice', 'bob', 'carol'),
    [switch]$NoClients,
    # Force the animated synthetic video source (with per-client in-video name
    # tag) via the E2EE_SYNTHETIC_VIDEO env var, instead of relying on
    # media.video.synthetic in config.json. On by default because the usual
    # reason to run run-all.ps1 is a single-machine multi-client test, where a
    # real webcam can only be opened by the first process.
    [bool]$SyntheticVideo = $true
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cfg = (Resolve-Path $Config).Path

function Start-Component {
    param(
        [string]$Title,
        [string]$WorkDir,
        [string]$File,
        [string[]]$ArgList,
        [hashtable]$Env
    )
    Write-Host "Starting $Title ..." -ForegroundColor Cyan
    $quotedArgs = ($ArgList | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $envPrefix = ''
    if ($Env) {
        foreach ($k in $Env.Keys) {
            $envPrefix += "`$env:$k = '$($Env[$k])'; "
        }
    }
    $inner = "Set-Location '$WorkDir'; $envPrefix& $File $quotedArgs"
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

# 3) Clients (default: alice / bob / carol) ----------------------------------
# Note: connect each manually inside the REPL, e.g.
#     connect alice
#     connect bob
#     connect carol
# (defaults for sfuUrl / kdUrl / confId come from config.json), or set
# autoConnect/autoConnectName in config.json for hands-free start.
#
# When -SyntheticVideo is set (default), each client gets the animated synthetic
# source via E2EE_SYNTHETIC_VIDEO=1, tagged with its own name (E2EE_VIDEO_LABEL)
# so the encrypted streams are easy to tell apart on one machine.
foreach ($name in $Names) {
    $clientEnv = $null
    if ($SyntheticVideo) {
        $clientEnv = @{ E2EE_SYNTHETIC_VIDEO = '1'; E2EE_VIDEO_LABEL = $name }
    }
    Start-Component -Title "Client ($name)" -WorkDir (Join-Path $root 'client') `
        -File 'node' -ArgList @('client.js', '--config', $cfg) -Env $clientEnv
}

Write-Host 'All components launched. Each runs in its own window.' -ForegroundColor Green
Write-Host 'In each client window: connect <name>   (e.g. connect alice)' -ForegroundColor Yellow
