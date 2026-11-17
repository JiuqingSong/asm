# Releases AsmPerfect 86 to the family server (http://192.168.0.120:8075/).
# Refuses unless everything is committed and pushed; then the server pulls from GitHub,
# rebuilds the container (deploy/update-server.sh) and we check it reports this commit.
# Keep this file ASCII: Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI.
param(
    [string]$Server = 'songthin@192.168.0.120',
    [string]$Url = 'http://192.168.0.120:8075'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Native programs write progress to stderr; PowerShell 5.1 would treat that as an error.
function Invoke-Native([scriptblock]$Block) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}

Write-Host '==> Checking that everything is committed and pushed'
$dirty = Invoke-Native { git status --porcelain }
if ($dirty) { throw "There are uncommitted changes:`n$($dirty -join "`n")" }
Invoke-Native { git fetch --quiet origin } | Out-Null
$head = (Invoke-Native { git rev-parse HEAD }) | Select-Object -Last 1
$remote = (Invoke-Native { git rev-parse '@{u}' }) | Select-Object -Last 1
if ($head -ne $remote) { throw "HEAD ($head) is not the same as origin ($remote): push first." }
$short = (Invoke-Native { git rev-parse --short HEAD }) | Select-Object -Last 1

Write-Host "==> Updating the server to $short"
Invoke-Native { ssh -o BatchMode=yes $Server '~/asmperfect/deploy/update-server.sh' } | Write-Host
if ($LASTEXITCODE -ne 0) { throw "update-server.sh failed (exit code $LASTEXITCODE)." }

Write-Host '==> Checking the page'
$v = Invoke-RestMethod "$Url/api/v1/version"
if ($v.commit -ne $short) { throw "The server reports commit '$($v.commit)', expected '$short'." }
Write-Host "AsmPerfect 86 $($v.version) ($($v.commit)) is live: $Url/"
