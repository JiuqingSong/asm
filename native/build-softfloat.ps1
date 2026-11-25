param([string]$Zig, [switch]$Debug)
$ErrorActionPreference = 'Stop'
$compiler = (Get-Command -Name $Zig -ErrorAction Stop).Source
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'vendor\softfloat\source'
$output = Join-Path $PSScriptRoot 'build\softfloat'
New-Item -ItemType Directory -Force $output | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $root 'vendor\softfloat\Makefile') -Raw
$sources = @([regex]::Matches($manifest, '(?m)^\s+(\w+)\$\(OBJ\)') | ForEach-Object {
    $name = $_.Groups[1].Value + '.c'
    $file = Join-Path $source "8086\$name"
    if (-not (Test-Path -LiteralPath $file)) { $file = Join-Path $source $name }
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing vendored SoftFloat source: $file" }
    $file
})
if ($sources.Count -eq 0) { throw 'The vendored SoftFloat source manifest is empty' }
$sources += Join-Path $root 'tools\softfloat\kernel.c'
$optimization = '-O2'
if ($Debug) { $optimization = '-O0' }
$arguments = @('cc', '-c', '-std=c11', $optimization, '-g',
    '-DSOFTFLOAT_FAST_INT64', '-DINLINE_LEVEL=5', '-DSOFTFLOAT_FAST_DIV32TO16', '-DSOFTFLOAT_FAST_DIV64TO32',
    ('-I' + (Join-Path $root 'tools\softfloat')), ('-I' + (Join-Path $source '8086')),
    ('-I' + (Join-Path $source 'include')))
$objects = @($sources | ForEach-Object { Join-Path $output ([System.IO.Path]::GetFileNameWithoutExtension($_) + '.obj') })
$library = Join-Path $output 'softfloat.lib'
Push-Location $output
try {
    for ($i = 0; $i -lt $sources.Count; ++$i) {
        & $compiler @arguments $sources[$i] -o $objects[$i]
        if ($LASTEXITCODE -ne 0) { throw "Native SoftFloat C compilation failed: $($sources[$i])" }
    }
    if (Test-Path -LiteralPath $library) { Remove-Item -LiteralPath $library }
    & $compiler ar rcs $library @objects
    if ($LASTEXITCODE -ne 0) { throw 'Native SoftFloat archive creation failed' }
} finally {
    Pop-Location
}
Copy-Item -LiteralPath (Join-Path $root 'vendor\softfloat\COPYING.txt') -Destination (Join-Path $PSScriptRoot 'build\softfloat-license.txt') -Force
Write-Output $library
