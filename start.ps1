# Launches the Workana job board using the project-local Node runtime in .tools\
# so nothing has to be installed system-wide.
#
#   .\start.ps1              # start the web server
#   .\start.ps1 scrape       # run one scrape and exit
#   .\start.ps1 login-check  # verify the cookies still authenticate

param([string]$Task = 'start')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root '.tools\node-v24.20.0-win-x64'

if (-not (Test-Path (Join-Path $node 'node.exe'))) {
    Write-Host "Local Node runtime not found in $node" -ForegroundColor Yellow
    Write-Host "Either install Node 22.5+ system-wide, or re-download the portable build." -ForegroundColor Yellow
    exit 1
}

$env:Path = "$node;$env:Path"
Set-Location $root

switch ($Task) {
    'scrape'      { & node src/cli/scrape.js @args }
    'login-check' { & node src/cli/login-check.js }
    'verify'      { & node scripts/verify.mjs }
    default {
        Write-Host ''
        Write-Host '  Starting Workana job board on http://127.0.0.1:4300' -ForegroundColor Cyan
        Write-Host ''
        & node src/server.js
    }
}
